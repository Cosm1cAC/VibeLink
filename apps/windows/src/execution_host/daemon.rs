use super::{
    protocol::{
        parse_params, start_fingerprint, validate_request, AckParams, AttachState, EventsParams,
        ExecutionManifest, ExecutionParams, ExecutionSnapshot, ExecutionStatus, ListParams,
        RequestEnvelope, ResponseEnvelope, StartParams, WorkerBootstrap, WorkerHelloParams,
        PROTOCOL_VERSION,
    },
    spool::{write_json_atomic, EventSpool},
    windows,
};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    env, fs,
    fs::OpenOptions,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone)]
struct Route {
    manifest_path: PathBuf,
    manifest: ExecutionManifest,
    reachable: bool,
}

#[derive(Debug, Clone)]
struct StartRecord {
    fingerprint: String,
    execution_id: String,
}

struct WorkerProof {
    process_pid: Option<u32>,
    process_started_at_ticks: Option<u64>,
}

struct HostState {
    executions_dir: PathBuf,
    routes: Mutex<BTreeMap<String, Route>>,
    starts: Mutex<HashMap<String, StartRecord>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}

pub fn run(data_dir: &Path, pipe_override: Option<&str>) -> Result<()> {
    let executions_dir = data_dir.join("executions");
    fs::create_dir_all(&executions_dir).with_context(|| {
        format!(
            "failed to create execution-host data directory {}",
            executions_dir.display()
        )
    })?;
    let state = Arc::new(HostState {
        executions_dir,
        routes: Mutex::new(BTreeMap::new()),
        starts: Mutex::new(HashMap::new()),
    });
    reconcile_all(&state)?;
    let pipe_name = pipe_override
        .map(str::to_string)
        .unwrap_or_else(|| windows::execd_pipe_name(data_dir));
    windows::validate_pipe_name(&pipe_name)?;
    println!("VibeLink execd listening on {pipe_name}");

    loop {
        let pipe = windows::accept_named_pipe(&pipe_name)?;
        let connection_state = Arc::clone(&state);
        thread::Builder::new()
            .name("execd-pipe".to_string())
            .spawn(move || {
                let _ = serve_connection(pipe, connection_state);
            })
            .context("failed to start execd named-pipe connection")?;
    }
}

fn serve_connection(mut pipe: fs::File, state: Arc<HostState>) -> Result<()> {
    while let Some(request) = super::protocol::read_frame(&mut pipe)? {
        let response = dispatch(&state, request);
        super::protocol::write_frame(&mut pipe, &response)?;
    }
    Ok(())
}

fn dispatch(state: &HostState, request: RequestEnvelope) -> ResponseEnvelope {
    let request_id = request.request_id.clone();
    if let Err(error) = validate_request(&request) {
        let code = if request.protocol_version != PROTOCOL_VERSION {
            "PROTOCOL_VERSION_UNSUPPORTED"
        } else {
            "MESSAGE_INVALID"
        };
        return ResponseEnvelope::error(request_id, code, error.to_string(), false);
    }

    if matches!(
        request.method.as_str(),
        "execution.input" | "execution.resize" | "execution.signal"
    ) {
        return match execution_id_from_params(&request.params)
            .and_then(|execution_id| route_for(state, &execution_id))
        {
            Ok(route) if route.reachable => {
                proxy_to_worker(&route, &request).unwrap_or_else(|_| {
                    set_attach_state(
                        state,
                        &route.manifest.execution_id,
                        AttachState::Unreachable,
                    );
                    ResponseEnvelope::error(
                        request_id,
                        "EXECUTION_NOT_ATTACHED",
                        "Execution worker is not reachable.",
                        true,
                    )
                })
            }
            Ok(route) => {
                let code = if route.manifest.status == ExecutionStatus::OutcomeUnknown {
                    "OUTCOME_UNKNOWN"
                } else {
                    "EXECUTION_NOT_ATTACHED"
                };
                ResponseEnvelope::error(
                    request_id,
                    code,
                    "Execution worker is not attached.",
                    code == "EXECUTION_NOT_ATTACHED",
                )
            }
            Err(error) => response_from_error(request_id, error),
        };
    }

    match dispatch_local(state, &request.method, request.params, &request_id) {
        Ok(response) => response,
        Err(error) => {
            eprintln!("execd method {} failed: {error:#}", request.method);
            response_from_error(request_id, error)
        }
    }
}

fn dispatch_local(
    state: &HostState,
    method: &str,
    raw_params: Value,
    request_id: &str,
) -> Result<ResponseEnvelope> {
    let result = match method {
        "host.hello" => {
            let _: EmptyParams = parse_params(raw_params)?;
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {
                    "namedPipe": true,
                    "perExecutionWorker": true,
                    "conpty": true,
                    "stdio": true,
                    "eventReplay": true,
                    "startupReconciliation": true
                }
            })
        }
        "host.health" => {
            let _: EmptyParams = parse_params(raw_params)?;
            refresh_routes(state);
            let routes = state
                .routes
                .lock()
                .map_err(|_| anyhow::anyhow!("route lock poisoned"))?;
            json!({
                "ok": true,
                "workers": routes.len(),
                "attachedWorkers": routes.values().filter(|route| route.reachable).count(),
                "unreachableWorkers": routes.values().filter(|route| !route.reachable).count()
            })
        }
        "execution.start" => {
            let start: StartParams = parse_params(raw_params)?;
            let snapshot = start_execution(state, start)?;
            serde_json::to_value(snapshot)?
        }
        "execution.get" => {
            let params: ExecutionParams = parse_params(raw_params.clone())?;
            let route = route_for(state, &params.execution_id)?;
            if route.reachable {
                let request = RequestEnvelope {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.to_string(),
                    method: method.to_string(),
                    params: raw_params,
                };
                return proxy_to_worker(&route, &request);
            }
            serde_json::to_value(ExecutionSnapshot::from(&route.manifest))?
        }
        "execution.list" => {
            let params: ListParams = parse_params(raw_params)?;
            if params.limit == 0 || params.limit > 500 {
                bail!("MESSAGE_INVALID: list limit must be between 1 and 500");
            }
            refresh_routes(state);
            let routes = state
                .routes
                .lock()
                .map_err(|_| anyhow::anyhow!("route lock poisoned"))?;
            let executions = routes
                .iter()
                .filter(|(execution_id, _)| {
                    params.after_execution_id.is_empty()
                        || execution_id.as_str() > params.after_execution_id.as_str()
                })
                .take(params.limit)
                .map(|(_, route)| ExecutionSnapshot::from(&route.manifest))
                .collect::<Vec<_>>();
            json!({ "executions": executions })
        }
        "execution.events" => {
            let params: EventsParams = parse_params(raw_params.clone())?;
            let route = route_for(state, &params.execution_id)?;
            if route.reachable {
                let request = RequestEnvelope {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.to_string(),
                    method: method.to_string(),
                    params: raw_params,
                };
                return proxy_to_worker(&route, &request);
            }
            if !route.manifest.status.is_terminal() {
                bail!("EXECUTION_NOT_ATTACHED");
            }
            let spool = EventSpool::open(
                route
                    .manifest_path
                    .parent()
                    .context("manifest has no parent")?,
                &route.manifest.execution_id,
                route.manifest.spool_quota_bytes,
                route.manifest.segment_bytes,
                route.manifest.last_acked_host_seq,
                route.manifest.last_host_seq,
            )?;
            json!({
                "events": spool.replay(params.after_host_seq, params.limit)?,
                "lastHostSeq": spool.last_seq()
            })
        }
        "execution.ack" => {
            let params: AckParams = parse_params(raw_params.clone())?;
            let route = route_for(state, &params.execution_id)?;
            if route.reachable {
                let request = RequestEnvelope {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.to_string(),
                    method: method.to_string(),
                    params: raw_params,
                };
                return proxy_to_worker(&route, &request);
            }
            if !route.manifest.status.is_terminal() {
                bail!("EXECUTION_NOT_ATTACHED");
            }
            let mut spool = EventSpool::open(
                route
                    .manifest_path
                    .parent()
                    .context("manifest has no parent")?,
                &route.manifest.execution_id,
                route.manifest.spool_quota_bytes,
                route.manifest.segment_bytes,
                route.manifest.last_acked_host_seq,
                route.manifest.last_host_seq,
            )?;
            spool.acknowledge(params.host_seq)?;
            let mut manifest = route.manifest;
            manifest.last_acked_host_seq = spool.acked_seq();
            write_json_atomic(&route.manifest_path, &manifest)?;
            replace_route(state, route.manifest_path, manifest.clone(), false)?;
            json!({ "ackedHostSeq": manifest.last_acked_host_seq })
        }
        _ => bail!("MESSAGE_INVALID: unknown execd method {method}"),
    };
    Ok(ResponseEnvelope::success(request_id, result))
}

fn start_execution(state: &HostState, mut start: StartParams) -> Result<ExecutionSnapshot> {
    start.validate()?;
    let fingerprint = start_fingerprint(&start)?;
    if let Some(record) = state
        .starts
        .lock()
        .map_err(|_| anyhow::anyhow!("start operation lock poisoned"))?
        .get(&start.operation_id)
        .cloned()
    {
        if record.fingerprint != fingerprint {
            bail!("OPERATION_CONFLICT");
        }
        return Ok(ExecutionSnapshot::from(
            &route_for(state, &record.execution_id)?.manifest,
        ));
    }

    let execution_id = match start.execution_id.take() {
        Some(execution_id) => Uuid::parse_str(&execution_id)
            .context("MESSAGE_INVALID: executionId must be a UUID")?
            .to_string(),
        None => Uuid::new_v4().to_string(),
    };
    let execution_dir = state.executions_dir.join(&execution_id);
    if execution_dir.exists() {
        bail!("EXECUTION_STATE_CONFLICT");
    }
    fs::create_dir_all(&execution_dir)?;
    start.execution_id = Some(execution_id.clone());
    let worker_instance_id = Uuid::new_v4().to_string();
    let pipe_name = windows::worker_pipe_name(&execution_id, &worker_instance_id);
    let nonce = random_nonce()?;
    let manifest_path = execution_dir.join("manifest.json");
    let bootstrap_path = execution_dir.join("worker-bootstrap.json");
    let bootstrap = WorkerBootstrap {
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        start: start.clone(),
        worker_instance_id,
        pipe_name,
        nonce,
    };
    write_json_atomic(&bootstrap_path, &bootstrap)?;

    let executable = env::current_exe().context("failed to locate vibelink executable")?;
    let worker_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(execution_dir.join("worker.log"))?;
    let mut command = Command::new(executable);
    command
        .arg("execution-worker")
        .arg("--bootstrap")
        .arg(&bootstrap_path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(worker_log.try_clone()?))
        .stderr(Stdio::from(worker_log));
    #[cfg(windows)]
    command.creation_flags(
        windows::DETACHED_PROCESS | windows::CREATE_NEW_PROCESS_GROUP | windows::CREATE_NO_WINDOW,
    );
    let mut child = command
        .spawn()
        .context("failed to launch execution worker")?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut last_reconcile_error = None;
    loop {
        if manifest_path.exists() {
            match reconcile_path(&manifest_path) {
                Ok(route) => {
                    replace_route(
                        state,
                        manifest_path.clone(),
                        route.manifest.clone(),
                        route.reachable,
                    )?;
                    state
                        .starts
                        .lock()
                        .map_err(|_| anyhow::anyhow!("start operation lock poisoned"))?
                        .insert(
                            start.operation_id.clone(),
                            StartRecord {
                                fingerprint: fingerprint.clone(),
                                execution_id: execution_id.clone(),
                            },
                        );
                    if route.reachable || route.manifest.status.is_terminal() {
                        return Ok(ExecutionSnapshot::from(&route.manifest));
                    }
                }
                Err(error) => last_reconcile_error = Some(error.to_string()),
            }
        }
        if let Some(status) = child.try_wait()? {
            bail!("execution worker exited during startup with {status}");
        }
        if Instant::now() >= deadline {
            bail!(
                "execution worker did not become reachable before startup timeout: {}",
                last_reconcile_error.unwrap_or_else(|| "manifest was not ready".to_string())
            );
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn reconcile_all(state: &HostState) -> Result<()> {
    let mut routes = BTreeMap::new();
    let mut starts = HashMap::new();
    for entry in fs::read_dir(&state.executions_dir)? {
        let entry = match entry {
            Ok(entry) if entry.path().is_dir() => entry,
            _ => continue,
        };
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        match reconcile_path(&manifest_path) {
            Ok(route) => {
                starts.insert(
                    route.manifest.start_operation_id.clone(),
                    StartRecord {
                        fingerprint: route.manifest.start_fingerprint.clone(),
                        execution_id: route.manifest.execution_id.clone(),
                    },
                );
                routes.insert(route.manifest.execution_id.clone(), route);
            }
            Err(error) => eprintln!(
                "Ignoring invalid execution manifest {}: {error:#}",
                manifest_path.display()
            ),
        }
    }
    *state
        .routes
        .lock()
        .map_err(|_| anyhow::anyhow!("route lock poisoned"))? = routes;
    *state
        .starts
        .lock()
        .map_err(|_| anyhow::anyhow!("start operation lock poisoned"))? = starts;
    Ok(())
}

fn reconcile_path(manifest_path: &Path) -> Result<Route> {
    let mut manifest = load_manifest(manifest_path)?;
    validate_manifest(manifest_path, &manifest)?;
    let worker_identity_matches =
        windows::process_matches(manifest.worker_pid, manifest.worker_started_at_ticks);
    let child_identity_matches = match (manifest.process_pid, manifest.process_started_at_ticks) {
        (Some(pid), Some(ticks)) => windows::process_matches(pid, ticks),
        (None, None) if manifest.status == ExecutionStatus::Starting => true,
        _ => manifest.status.is_terminal(),
    };

    if worker_identity_matches && child_identity_matches {
        match verify_worker(&manifest) {
            Ok(proof) => {
                let latest = load_manifest(manifest_path)?;
                validate_manifest(manifest_path, &latest)?;
                if latest.execution_id != manifest.execution_id
                    || latest.worker_instance_id != manifest.worker_instance_id
                    || latest.worker_pid != manifest.worker_pid
                    || latest.worker_started_at_ticks != manifest.worker_started_at_ticks
                    || latest.pipe_name != manifest.pipe_name
                    || latest.nonce != manifest.nonce
                    || latest.process_pid != proof.process_pid
                    || latest.process_started_at_ticks != proof.process_started_at_ticks
                {
                    bail!("worker identity changed during reconciliation");
                }
                if !latest.status.is_terminal()
                    && !matches!(
                        (proof.process_pid, proof.process_started_at_ticks),
                        (Some(pid), Some(ticks)) if windows::process_matches(pid, ticks)
                    )
                {
                    bail!("worker child identity is not live after reconciliation");
                }
                manifest = latest;
                manifest.attach_state = AttachState::Attached;
                return Ok(Route {
                    manifest_path: manifest_path.to_path_buf(),
                    manifest,
                    reachable: true,
                });
            }
            Err(_) => {
                manifest.attach_state = AttachState::Unreachable;
                return Ok(Route {
                    manifest_path: manifest_path.to_path_buf(),
                    manifest,
                    reachable: false,
                });
            }
        }
    }

    if !manifest.status.is_terminal() && !worker_identity_matches {
        mark_lost(manifest_path, &mut manifest, "worker_identity_lost")?;
    } else if !manifest.status.is_terminal() && !child_identity_matches {
        manifest.attach_state = AttachState::Unreachable;
    } else {
        manifest.attach_state = offline_attach_state(manifest.status);
        write_json_atomic(manifest_path, &manifest)?;
    }
    Ok(Route {
        manifest_path: manifest_path.to_path_buf(),
        manifest,
        reachable: false,
    })
}

fn offline_attach_state(status: ExecutionStatus) -> AttachState {
    if status == ExecutionStatus::Lost {
        AttachState::Lost
    } else {
        AttachState::Unreachable
    }
}

fn verify_worker(manifest: &ExecutionManifest) -> Result<WorkerProof> {
    let mut pipe = windows::connect_named_pipe(&manifest.pipe_name, Duration::from_secs(2))?;
    let request_id = Uuid::new_v4().to_string();
    super::protocol::write_frame(
        &mut pipe,
        &RequestEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            method: "host.hello".to_string(),
            params: serde_json::to_value(WorkerHelloParams {
                nonce: manifest.nonce.clone(),
            })?,
        },
    )?;
    let response: ResponseEnvelope = super::protocol::read_json_frame(&mut pipe)?
        .context("worker closed during identity handshake")?;
    if response.request_id != request_id || response.error.is_some() {
        bail!("worker rejected identity handshake");
    }
    let result = response.result.context("worker handshake omitted result")?;
    if result.get("workerInstanceId").and_then(Value::as_str)
        != Some(manifest.worker_instance_id.as_str())
        || result.get("workerPid").and_then(Value::as_u64) != Some(manifest.worker_pid as u64)
        || result.get("workerStartedAtTicks").and_then(Value::as_u64)
            != Some(manifest.worker_started_at_ticks)
        || result.get("executionId").and_then(Value::as_str) != Some(manifest.execution_id.as_str())
    {
        bail!("worker identity proof does not match manifest");
    }
    let process_pid = result
        .get("processPid")
        .and_then(Value::as_u64)
        .map(u32::try_from)
        .transpose()
        .context("worker processPid exceeds the v1 boundary")?;
    let process_started_at_ticks = result.get("processStartedAtTicks").and_then(Value::as_u64);
    if process_pid.is_some() != process_started_at_ticks.is_some() {
        bail!("worker child identity proof is incomplete");
    }
    Ok(WorkerProof {
        process_pid,
        process_started_at_ticks,
    })
}

fn proxy_to_worker(route: &Route, request: &RequestEnvelope) -> Result<ResponseEnvelope> {
    let mut pipe = windows::connect_named_pipe(&route.manifest.pipe_name, Duration::from_secs(2))?;
    let hello_id = Uuid::new_v4().to_string();
    super::protocol::write_frame(
        &mut pipe,
        &RequestEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: hello_id.clone(),
            method: "host.hello".to_string(),
            params: serde_json::to_value(WorkerHelloParams {
                nonce: route.manifest.nonce.clone(),
            })?,
        },
    )?;
    let hello: ResponseEnvelope =
        super::protocol::read_json_frame(&mut pipe)?.context("worker closed during handshake")?;
    if hello.request_id != hello_id || hello.error.is_some() {
        bail!("worker authentication failed");
    }
    super::protocol::write_frame(&mut pipe, request)?;
    super::protocol::read_json_frame(&mut pipe)?.context("worker closed before response")
}

fn mark_lost(manifest_path: &Path, manifest: &mut ExecutionManifest, reason: &str) -> Result<()> {
    let mut spool = EventSpool::open(
        manifest_path.parent().context("manifest has no parent")?,
        &manifest.execution_id,
        manifest.spool_quota_bytes,
        manifest.segment_bytes,
        manifest.last_acked_host_seq,
        manifest.last_host_seq,
    )?;
    if let Some(event) = spool.append(
        "execution.lost",
        json!({ "reason": reason, "workerPid": manifest.worker_pid }),
    )? {
        manifest.last_host_seq = event.host_seq;
    }
    manifest.status = ExecutionStatus::Lost;
    manifest.attach_state = AttachState::Lost;
    manifest.ended_at = super::now_rfc3339();
    write_json_atomic(manifest_path, manifest)
}

fn validate_manifest(path: &Path, manifest: &ExecutionManifest) -> Result<()> {
    if manifest.protocol_version != PROTOCOL_VERSION {
        bail!("manifest protocol version is unsupported");
    }
    Uuid::parse_str(&manifest.execution_id).context("manifest executionId is not a UUID")?;
    Uuid::parse_str(&manifest.worker_instance_id)
        .context("manifest workerInstanceId is not a UUID")?;
    if path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        != Some(manifest.execution_id.as_str())
    {
        bail!("manifest executionId does not match its directory");
    }
    if manifest.worker_pid == 0
        || manifest.worker_started_at_ticks == 0
        || manifest.nonce.len() < 32
    {
        bail!("manifest worker identity is incomplete");
    }
    windows::validate_pipe_name(&manifest.pipe_name)
}

fn load_manifest(path: &Path) -> Result<ExecutionManifest> {
    let bytes = fs::read(path)
        .with_context(|| format!("failed to read execution manifest {}", path.display()))?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid execution manifest {}", path.display()))
}

fn refresh_routes(state: &HostState) {
    let paths = state
        .routes
        .lock()
        .map(|routes| {
            routes
                .values()
                .map(|route| route.manifest_path.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for path in paths {
        if let Ok(route) = reconcile_path(&path) {
            let _ = replace_route(state, path, route.manifest, route.reachable);
        }
    }
}

fn route_for(state: &HostState, execution_id: &str) -> Result<Route> {
    let execution_id = Uuid::parse_str(execution_id)
        .context("MESSAGE_INVALID: executionId must be a UUID")?
        .to_string();
    let path = state
        .executions_dir
        .join(&execution_id)
        .join("manifest.json");
    if path.exists() {
        let route = reconcile_path(&path)?;
        replace_route(state, path, route.manifest.clone(), route.reachable)?;
        return Ok(route);
    }
    state
        .routes
        .lock()
        .map_err(|_| anyhow::anyhow!("route lock poisoned"))?
        .get(&execution_id)
        .cloned()
        .context("EXECUTION_NOT_FOUND")
}

fn replace_route(
    state: &HostState,
    manifest_path: PathBuf,
    manifest: ExecutionManifest,
    reachable: bool,
) -> Result<()> {
    state
        .routes
        .lock()
        .map_err(|_| anyhow::anyhow!("route lock poisoned"))?
        .insert(
            manifest.execution_id.clone(),
            Route {
                manifest_path,
                manifest,
                reachable,
            },
        );
    Ok(())
}

fn set_attach_state(state: &HostState, execution_id: &str, attach_state: AttachState) {
    if let Ok(mut routes) = state.routes.lock() {
        if let Some(route) = routes.get_mut(execution_id) {
            route.reachable = false;
            route.manifest.attach_state = attach_state;
        }
    }
}

fn execution_id_from_params(params: &Value) -> Result<String> {
    params
        .get("executionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .context("MESSAGE_INVALID: executionId is required")
}

fn random_nonce() -> Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| anyhow::anyhow!("failed to generate worker handshake nonce: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn response_from_error(request_id: String, error: anyhow::Error) -> ResponseEnvelope {
    let message = error.to_string();
    let mut code = "INTERNAL_ERROR";
    let mut retryable = false;
    for candidate in [
        "PROTOCOL_VERSION_UNSUPPORTED",
        "MESSAGE_INVALID",
        "EXECUTION_NOT_FOUND",
        "EXECUTION_NOT_ATTACHED",
        "EXECUTION_STATE_CONFLICT",
        "OPERATION_CONFLICT",
        "CAPABILITY_UNSUPPORTED",
        "OUTCOME_UNKNOWN",
    ] {
        if message.contains(candidate) {
            code = candidate;
            retryable = candidate == "EXECUTION_NOT_ATTACHED";
            break;
        }
    }
    let public_message = if code == "INTERNAL_ERROR" {
        "Execution host failed without exposing process or credential details.".to_string()
    } else {
        message
    };
    ResponseEnvelope::error(request_id, code, public_message, retryable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_worker_nonce_has_256_bits_of_hex_material() {
        let nonce = random_nonce().unwrap();
        assert_eq!(nonce.len(), 64);
        assert!(nonce.chars().all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn manifest_directory_must_match_execution_identity() {
        let manifest: ExecutionManifest = serde_json::from_value(json!({
            "protocolVersion": 1,
            "executionId": "db5fd9a0-9f04-440b-811c-56fa364d1132",
            "startOperationId": "op-1",
            "startFingerprint": "fingerprint",
            "kind": "command",
            "backend": "stdio",
            "owner": "execution-host",
            "status": "running",
            "attachState": "attached",
            "workerInstanceId": "b30ece67-0cc2-4513-9e61-1ae66217a61f",
            "workerPid": 123,
            "workerStartedAtTicks": 123,
            "pipeName": "\\\\.\\pipe\\vibelink-worker-test",
            "nonce": "a".repeat(64),
            "processPid": 456,
            "processStartedAtTicks": 456,
            "processStartedAt": "",
            "lastHostSeq": 0,
            "lastAckedHostSeq": 0,
            "capabilities": {},
            "startedAt": "",
            "endedAt": "",
            "exitCode": null,
            "signal": "",
            "spoolQuotaBytes": 4096,
            "segmentBytes": 1024
        }))
        .unwrap();
        let path = Path::new("C:/data/executions/not-the-id/manifest.json");
        assert!(validate_manifest(path, &manifest).is_err());
    }

    #[test]
    fn lost_execution_keeps_the_lost_attach_state_when_offline() {
        assert_eq!(
            offline_attach_state(ExecutionStatus::Lost),
            AttachState::Lost
        );
        assert_eq!(
            offline_attach_state(ExecutionStatus::Completed),
            AttachState::Unreachable
        );
    }
}
