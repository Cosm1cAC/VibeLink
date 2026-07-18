use super::{
    backend::BackendControl,
    protocol::{
        operation_fingerprint, parse_params, start_fingerprint, validate_operation_id,
        validate_request, AckParams, AttachState, EventsParams, ExecutionManifest, ExecutionParams,
        ExecutionSnapshot, ExecutionStatus, HostEvent, InputParams, RequestEnvelope, ResizeParams,
        ResponseEnvelope, SignalParams, WorkerBootstrap, WorkerHelloParams, PROTOCOL_VERSION,
    },
    spool::{write_json_atomic, EventSpool},
    windows,
};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};

#[derive(Clone)]
struct OperationRecord {
    fingerprint: String,
    result: Value,
}

struct WorkerState {
    manifest_path: PathBuf,
    manifest: Mutex<ExecutionManifest>,
    spool: Mutex<EventSpool>,
    backend: Mutex<Option<Arc<BackendControl>>>,
    operations: Mutex<HashMap<String, OperationRecord>>,
}

impl WorkerState {
    fn snapshot(&self) -> Result<ExecutionSnapshot> {
        let manifest = self
            .manifest
            .lock()
            .map_err(|_| anyhow::anyhow!("manifest lock poisoned"))?;
        Ok(ExecutionSnapshot::from(&*manifest))
    }

    fn ensure_execution(&self, execution_id: &str) -> Result<()> {
        let manifest = self
            .manifest
            .lock()
            .map_err(|_| anyhow::anyhow!("manifest lock poisoned"))?;
        if manifest.execution_id != execution_id {
            bail!("EXECUTION_NOT_FOUND");
        }
        Ok(())
    }

    fn append_event(&self, event_type: &str, payload: Value) -> Result<Option<HostEvent>> {
        let event = {
            let mut spool = self
                .spool
                .lock()
                .map_err(|_| anyhow::anyhow!("spool lock poisoned"))?;
            spool.append(event_type, payload)?
        };
        if let Some(event) = &event {
            let mut manifest = self
                .manifest
                .lock()
                .map_err(|_| anyhow::anyhow!("manifest lock poisoned"))?;
            manifest.last_host_seq = event.host_seq;
            write_json_atomic(&self.manifest_path, &*manifest)?;
        }
        Ok(event)
    }

    fn mark_spool_failure(&self) {
        if let Ok(mut manifest) = self.manifest.lock() {
            if !manifest.status.is_terminal() {
                manifest.status = ExecutionStatus::Lost;
                manifest.attach_state = AttachState::Lost;
                manifest.ended_at = super::now_rfc3339();
                let _ = write_json_atomic(&self.manifest_path, &*manifest);
            }
        }
        if let Ok(backend) = self.backend.lock() {
            if let Some(backend) = backend.as_ref() {
                let _ = backend.signal("terminate");
            }
        }
    }

    fn finish(&self, exit_code: u32) {
        let signal = self
            .manifest
            .lock()
            .map(|manifest| manifest.signal.clone())
            .unwrap_or_default();
        if self
            .append_event(
                "execution.exited",
                json!({ "exitCode": exit_code, "signal": signal }),
            )
            .is_err()
        {
            self.mark_spool_failure();
            return;
        }
        if let Ok(mut manifest) = self.manifest.lock() {
            manifest.exit_code = Some(exit_code);
            manifest.ended_at = super::now_rfc3339();
            manifest.attach_state = AttachState::Attached;
            manifest.status = if !manifest.signal.is_empty() {
                ExecutionStatus::Cancelled
            } else if exit_code == 0 {
                ExecutionStatus::Completed
            } else {
                ExecutionStatus::Failed
            };
            let _ = write_json_atomic(&self.manifest_path, &*manifest);
        }
    }

    fn run_operation<F>(
        &self,
        operation_id: &str,
        method: &str,
        raw_params: &Value,
        action: F,
    ) -> Result<Value>
    where
        F: FnOnce() -> Result<Value>,
    {
        validate_operation_id(operation_id)?;
        let fingerprint = operation_fingerprint(method, raw_params)?;
        {
            let operations = self
                .operations
                .lock()
                .map_err(|_| anyhow::anyhow!("operation lock poisoned"))?;
            if let Some(record) = operations.get(operation_id) {
                if record.fingerprint != fingerprint {
                    bail!("OPERATION_CONFLICT");
                }
                return Ok(record.result.clone());
            }
        }
        let result = action()?;
        self.operations
            .lock()
            .map_err(|_| anyhow::anyhow!("operation lock poisoned"))?
            .insert(
                operation_id.to_string(),
                OperationRecord {
                    fingerprint,
                    result: result.clone(),
                },
            );
        Ok(result)
    }
}

pub fn run(bootstrap_path: &Path) -> Result<()> {
    let bytes = fs::read(bootstrap_path).with_context(|| {
        format!(
            "failed to read worker bootstrap {}",
            bootstrap_path.display()
        )
    })?;
    let bootstrap: WorkerBootstrap = serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid worker bootstrap {}", bootstrap_path.display()))?;
    bootstrap.start.validate()?;
    windows::validate_pipe_name(&bootstrap.pipe_name)?;
    if bootstrap.nonce.len() < 32 || bootstrap.worker_instance_id.is_empty() {
        bail!("worker bootstrap identity is invalid");
    }
    let execution_id = bootstrap
        .start
        .execution_id
        .clone()
        .context("worker bootstrap is missing executionId")?;
    let manifest_path = PathBuf::from(&bootstrap.manifest_path);
    let execution_dir = manifest_path
        .parent()
        .context("worker manifest path has no parent")?;
    fs::create_dir_all(execution_dir)?;
    let worker_pid = std::process::id();
    let worker_started_at_ticks = windows::current_process_creation_ticks()?;
    let started_at = super::now_rfc3339();
    let manifest = ExecutionManifest {
        protocol_version: PROTOCOL_VERSION,
        execution_id: execution_id.clone(),
        start_operation_id: bootstrap.start.operation_id.clone(),
        start_fingerprint: start_fingerprint(&bootstrap.start)?,
        kind: bootstrap.start.kind.clone(),
        backend: bootstrap.start.backend,
        owner: "execution-host".to_string(),
        status: ExecutionStatus::Starting,
        attach_state: AttachState::Attached,
        worker_instance_id: bootstrap.worker_instance_id.clone(),
        worker_pid,
        worker_started_at_ticks,
        pipe_name: bootstrap.pipe_name.clone(),
        nonce: bootstrap.nonce.clone(),
        process_pid: None,
        process_started_at_ticks: None,
        process_started_at: String::new(),
        last_host_seq: 0,
        last_acked_host_seq: 0,
        capabilities: json!({
            "input": bootstrap.start.backend != super::protocol::BackendKind::AppServer,
            "resize": bootstrap.start.backend == super::protocol::BackendKind::ConPty,
            "interrupt": bootstrap.start.backend == super::protocol::BackendKind::ConPty,
            "terminate": true,
            "eventReplay": true,
            "reattach": true,
            "backend": bootstrap.start.backend
        }),
        started_at,
        ended_at: String::new(),
        exit_code: None,
        signal: String::new(),
        spool_quota_bytes: bootstrap.start.spool_quota_bytes,
        segment_bytes: bootstrap.start.segment_bytes,
    };
    write_json_atomic(&manifest_path, &manifest)?;
    let spool = EventSpool::open(
        execution_dir,
        &execution_id,
        bootstrap.start.spool_quota_bytes,
        bootstrap.start.segment_bytes,
        0,
        0,
    )?;
    let state = Arc::new(WorkerState {
        manifest_path,
        manifest: Mutex::new(manifest),
        spool: Mutex::new(spool),
        backend: Mutex::new(None),
        operations: Mutex::new(HashMap::new()),
    });

    state.append_event(
        "execution.started",
        json!({
            "workerPid": worker_pid,
            "workerInstanceId": bootstrap.worker_instance_id,
            "backend": bootstrap.start.backend
        }),
    )?;

    let event_state = Arc::clone(&state);
    let on_event = Arc::new(move |event_type: &str, payload: Value| {
        if let Err(error) = event_state.append_event(event_type, payload) {
            eprintln!("execution spool append failed: {error:#}");
            event_state.mark_spool_failure();
        }
    });
    let exit_state = Arc::clone(&state);
    let on_exit = Arc::new(move |exit_code: u32| exit_state.finish(exit_code));
    let backend = match BackendControl::start(&bootstrap.start, on_event, on_exit) {
        Ok(backend) => backend,
        Err(error) => {
            let _ = state.append_event(
                "execution.exited",
                json!({ "exitCode": null, "reason": "start_failed" }),
            );
            if let Ok(mut manifest) = state.manifest.lock() {
                manifest.status = ExecutionStatus::Failed;
                manifest.ended_at = super::now_rfc3339();
                manifest.attach_state = AttachState::Attached;
                let _ = write_json_atomic(&state.manifest_path, &*manifest);
            }
            return Err(error);
        }
    };
    {
        let mut manifest = state
            .manifest
            .lock()
            .map_err(|_| anyhow::anyhow!("manifest lock poisoned"))?;
        manifest.process_pid = Some(backend.pid());
        manifest.process_started_at_ticks = Some(backend.process_started_at_ticks());
        manifest.process_started_at = super::now_rfc3339();
        manifest.capabilities = backend.capabilities();
        manifest.status = ExecutionStatus::Running;
        write_json_atomic(&state.manifest_path, &*manifest)?;
    }
    *state
        .backend
        .lock()
        .map_err(|_| anyhow::anyhow!("backend lock poisoned"))? = Some(Arc::clone(&backend));
    backend.activate();
    let _ = fs::remove_file(bootstrap_path);

    loop {
        let pipe = windows::accept_named_pipe(&bootstrap.pipe_name)?;
        let connection_state = Arc::clone(&state);
        let nonce = bootstrap.nonce.clone();
        thread::Builder::new()
            .name(format!("execution-{execution_id}-pipe"))
            .spawn(move || {
                let _ = serve_connection(pipe, connection_state, &nonce);
            })
            .context("failed to start worker named-pipe connection")?;
    }
}

fn serve_connection(
    mut pipe: fs::File,
    state: Arc<WorkerState>,
    expected_nonce: &str,
) -> Result<()> {
    let hello =
        super::protocol::read_frame(&mut pipe)?.context("worker connection closed before hello")?;
    if validate_request(&hello).is_err() || hello.method != "host.hello" {
        super::protocol::write_frame(
            &mut pipe,
            &ResponseEnvelope::error(
                hello.request_id,
                "AUTHENTICATION_FAILED",
                "Worker connections must begin with an authenticated host.hello.",
                false,
            ),
        )?;
        return Ok(());
    }
    let params: WorkerHelloParams = match parse_params(hello.params) {
        Ok(params) => params,
        Err(_) => {
            super::protocol::write_frame(
                &mut pipe,
                &ResponseEnvelope::error(
                    hello.request_id,
                    "AUTHENTICATION_FAILED",
                    "Worker handshake proof is invalid.",
                    false,
                ),
            )?;
            return Ok(());
        }
    };
    if !constant_time_eq(params.nonce.as_bytes(), expected_nonce.as_bytes()) {
        super::protocol::write_frame(
            &mut pipe,
            &ResponseEnvelope::error(
                hello.request_id,
                "AUTHENTICATION_FAILED",
                "Worker handshake proof is invalid.",
                false,
            ),
        )?;
        return Ok(());
    }
    let manifest = state
        .manifest
        .lock()
        .map_err(|_| anyhow::anyhow!("manifest lock poisoned"))?
        .clone();
    super::protocol::write_frame(
        &mut pipe,
        &ResponseEnvelope::success(
            hello.request_id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "workerInstanceId": manifest.worker_instance_id,
                "workerPid": manifest.worker_pid,
                "workerStartedAtTicks": manifest.worker_started_at_ticks,
                "processPid": manifest.process_pid,
                "processStartedAtTicks": manifest.process_started_at_ticks,
                "executionId": manifest.execution_id
            }),
        ),
    )?;

    while let Some(request) = super::protocol::read_frame(&mut pipe)? {
        let response = dispatch(&state, request);
        super::protocol::write_frame(&mut pipe, &response)?;
    }
    Ok(())
}

fn dispatch(state: &WorkerState, request: RequestEnvelope) -> ResponseEnvelope {
    let request_id = request.request_id.clone();
    if let Err(error) = validate_request(&request) {
        let code = if request.protocol_version != PROTOCOL_VERSION {
            "PROTOCOL_VERSION_UNSUPPORTED"
        } else {
            "MESSAGE_INVALID"
        };
        return ResponseEnvelope::error(request_id, code, error.to_string(), false);
    }
    match dispatch_inner(state, &request.method, request.params) {
        Ok(result) => ResponseEnvelope::success(request_id, result),
        Err(error) => {
            let message = error.to_string();
            let (code, retryable) = classify_error(&message);
            ResponseEnvelope::error(
                request_id,
                code,
                public_error_message(code, &message),
                retryable,
            )
        }
    }
}

fn dispatch_inner(state: &WorkerState, method: &str, raw_params: Value) -> Result<Value> {
    match method {
        "host.health" => Ok(json!({ "ok": true, "snapshot": state.snapshot()? })),
        "execution.get" => {
            let params: ExecutionParams = parse_params(raw_params)?;
            state.ensure_execution(&params.execution_id)?;
            Ok(serde_json::to_value(state.snapshot()?)?)
        }
        "execution.events" => {
            let params: EventsParams = parse_params(raw_params)?;
            state.ensure_execution(&params.execution_id)?;
            let events = state
                .spool
                .lock()
                .map_err(|_| anyhow::anyhow!("spool lock poisoned"))?
                .replay(params.after_host_seq, params.limit)?;
            Ok(json!({ "events": events, "lastHostSeq": state.snapshot()?.last_host_seq }))
        }
        "execution.ack" => {
            let params: AckParams = parse_params(raw_params.clone())?;
            state.ensure_execution(&params.execution_id)?;
            state.run_operation(&params.operation_id, method, &raw_params, || {
                let acked_seq = {
                    let mut spool = state
                        .spool
                        .lock()
                        .map_err(|_| anyhow::anyhow!("spool lock poisoned"))?;
                    spool.acknowledge(params.host_seq)?;
                    spool.acked_seq()
                };
                let mut manifest = state
                    .manifest
                    .lock()
                    .map_err(|_| anyhow::anyhow!("manifest lock poisoned"))?;
                manifest.last_acked_host_seq = acked_seq;
                write_json_atomic(&state.manifest_path, &*manifest)?;
                Ok(json!({ "ackedHostSeq": acked_seq }))
            })
        }
        "execution.input" => {
            let params: InputParams = parse_params(raw_params.clone())?;
            state.ensure_execution(&params.execution_id)?;
            state.run_operation(&params.operation_id, method, &raw_params, || {
                let bytes = match params.encoding.as_str() {
                    "utf8" => params.data.as_bytes().to_vec(),
                    "base64" => BASE64
                        .decode(params.data.as_bytes())
                        .context("invalid base64 input")?,
                    _ => bail!("CAPABILITY_UNSUPPORTED: unsupported input encoding"),
                };
                let backend = state
                    .backend
                    .lock()
                    .map_err(|_| anyhow::anyhow!("backend lock poisoned"))?
                    .clone()
                    .context("EXECUTION_NOT_ATTACHED")?;
                backend.write_input(&bytes)?;
                Ok(json!({ "writtenBytes": bytes.len() }))
            })
        }
        "execution.resize" => {
            let params: ResizeParams = parse_params(raw_params.clone())?;
            state.ensure_execution(&params.execution_id)?;
            state.run_operation(&params.operation_id, method, &raw_params, || {
                let backend = state
                    .backend
                    .lock()
                    .map_err(|_| anyhow::anyhow!("backend lock poisoned"))?
                    .clone()
                    .context("EXECUTION_NOT_ATTACHED")?;
                backend.resize(params.cols, params.rows)?;
                Ok(json!({ "cols": params.cols, "rows": params.rows }))
            })
        }
        "execution.signal" => {
            let params: SignalParams = parse_params(raw_params.clone())?;
            state.ensure_execution(&params.execution_id)?;
            state.run_operation(&params.operation_id, method, &raw_params, || {
                {
                    let mut manifest = state
                        .manifest
                        .lock()
                        .map_err(|_| anyhow::anyhow!("manifest lock poisoned"))?;
                    if manifest.status.is_terminal() {
                        bail!("EXECUTION_STATE_CONFLICT");
                    }
                    manifest.status = ExecutionStatus::Stopping;
                    manifest.signal = params.signal.clone();
                    write_json_atomic(&state.manifest_path, &*manifest)?;
                }
                let backend = state
                    .backend
                    .lock()
                    .map_err(|_| anyhow::anyhow!("backend lock poisoned"))?
                    .clone()
                    .context("EXECUTION_NOT_ATTACHED")?;
                backend.signal(&params.signal)?;
                Ok(json!({ "signal": params.signal, "accepted": true }))
            })
        }
        _ => bail!("unknown worker method {method}"),
    }
}

fn classify_error(message: &str) -> (&'static str, bool) {
    for code in [
        "EXECUTION_NOT_FOUND",
        "EXECUTION_NOT_ATTACHED",
        "EXECUTION_STATE_CONFLICT",
        "OPERATION_CONFLICT",
        "CAPABILITY_UNSUPPORTED",
    ] {
        if message.contains(code) {
            return (code, code == "EXECUTION_NOT_ATTACHED");
        }
    }
    if message.contains("strict v1 schema")
        || message.contains("must")
        || message.contains("invalid")
    {
        ("MESSAGE_INVALID", false)
    } else {
        ("INTERNAL_ERROR", false)
    }
}

fn public_error_message(code: &str, message: &str) -> String {
    if code == "INTERNAL_ERROR" {
        "Execution worker failed without exposing process or credential details.".to_string()
    } else {
        message.to_string()
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_nonce_comparison_rejects_length_and_content_mismatch() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
        assert!(!constant_time_eq(b"same", b"longer"));
    }

    #[test]
    fn internal_errors_are_redacted() {
        let source = "failed with VIBELINK_TOKEN=secret";
        assert_eq!(classify_error(source).0, "INTERNAL_ERROR");
        assert!(!public_error_message("INTERNAL_ERROR", source).contains("secret"));
    }
}
