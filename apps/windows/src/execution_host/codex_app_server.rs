use super::{backend::EventCallback, backend::ExitCallback, protocol::StartParams, windows::Job};
use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    net::{TcpListener, TcpStream},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{connect, stream::MaybeTlsStream, Message, WebSocket};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const SUPPORTED_MINORS: &[&str] = &["0.117", "0.144"];

pub struct LaunchedAppServer {
    pub pid: u32,
    pub process_started_at_ticks: u64,
    pub job: Arc<Job>,
    pub activation: Arc<(Mutex<bool>, Condvar)>,
    pub approval: ApprovalControl,
}

#[derive(Clone)]
pub struct ApprovalControl {
    sender: mpsc::Sender<ApprovalCommand>,
}

struct ApprovalCommand {
    approval_id: String,
    continuation_ref: String,
    expected_version: u64,
    decision: Value,
    result: mpsc::SyncSender<Result<Value, String>>,
}

#[derive(Clone)]
struct PendingApproval {
    request_id: Value,
    method: String,
    thread_id: String,
    turn_id: String,
    item_id: String,
    continuation_ref: String,
    version: u64,
    available_decisions: Vec<Value>,
    requested_permissions: Value,
}

impl ApprovalControl {
    pub fn resolve(
        &self,
        approval_id: String,
        continuation_ref: String,
        expected_version: u64,
        decision: Value,
    ) -> Result<Value> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(ApprovalCommand {
                approval_id,
                continuation_ref,
                expected_version,
                decision,
                result: sender,
            })
            .map_err(|_| anyhow::anyhow!("APPROVAL_STALE: app-server connection is closed"))?;
        receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| {
                anyhow::anyhow!("EXECUTION_NOT_ATTACHED: app-server did not accept the decision")
            })?
            .map_err(anyhow::Error::msg)
    }
}

pub fn start(
    start: &StartParams,
    on_event: EventCallback,
    on_exit: ExitCallback,
) -> Result<LaunchedAppServer> {
    let app_server = start
        .app_server
        .as_ref()
        .context("appServer params are required")?;
    let version = probe_supported_version(start)?;
    let port = reserve_loopback_port()?;
    let url = format!("ws://127.0.0.1:{port}");
    let job = Arc::new(Job::create()?);
    let activation = Arc::new((Mutex::new(false), Condvar::new()));
    let mut command = Command::new(&start.command);
    command
        .args(&start.args)
        .arg("app-server")
        .arg("--listen")
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = &start.cwd {
        command.current_dir(cwd);
    }
    command.envs(&start.env);
    #[cfg(windows)]
    command.creation_flags(
        super::windows::CREATE_NEW_PROCESS_GROUP | super::windows::CREATE_NO_WINDOW,
    );

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start Codex app-server {}", start.command))?;
    let pid = child.id();
    if let Err(error) = job.assign_pid(pid) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let process_started_at_ticks = super::windows::process_creation_ticks(pid)?;

    let mut socket =
        match connect_with_retry(&url, Duration::from_millis(app_server.connect_timeout_ms)) {
            Ok(socket) => socket,
            Err(error) => {
                let _ = job.terminate(1);
                let _ = child.wait();
                return Err(error);
            }
        };
    set_socket_timeout(
        &mut socket,
        Some(Duration::from_millis(app_server.connect_timeout_ms)),
    )?;
    if let Err(error) = initialize_session(
        &mut socket,
        &app_server.thread_resume_params,
        &app_server.turn_start_params,
        &on_event,
    ) {
        let _ = socket.close(None);
        let _ = job.terminate(1);
        let _ = child.wait();
        return Err(error);
    }
    set_socket_timeout(&mut socket, None)?;

    let (approval_sender, approval_receiver) = mpsc::channel();
    let approval = ApprovalControl {
        sender: approval_sender,
    };

    on_event(
        "provider.event",
        provider_event(
            "provider.connection.started",
            None,
            None,
            None,
            None,
            json!({ "cliVersion": version, "url": url }),
        ),
    );

    let reader_job = Arc::clone(&job);
    thread::Builder::new()
        .name(format!("codex-app-server-{pid}-websocket"))
        .spawn(move || {
            let reason = read_notifications(&mut socket, &on_event, approval_receiver)
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "websocket_closed".to_string());
            on_event(
                "provider.event",
                provider_event(
                    "provider.connection.closed",
                    None,
                    None,
                    None,
                    None,
                    json!({ "reason": reason }),
                ),
            );
            let _ = reader_job.terminate(1);
        })
        .context("failed to start Codex app-server WebSocket reader")?;

    let exit_activation = Arc::clone(&activation);
    thread::Builder::new()
        .name(format!("codex-app-server-{pid}-wait"))
        .spawn(move || {
            let exit_code = child
                .wait()
                .ok()
                .and_then(|status| status.code())
                .unwrap_or(1) as u32;
            wait_for_activation(&exit_activation);
            on_exit(exit_code);
        })
        .context("failed to start Codex app-server wait thread")?;

    Ok(LaunchedAppServer {
        pid,
        process_started_at_ticks,
        job,
        activation,
        approval,
    })
}

fn probe_supported_version(start: &StartParams) -> Result<String> {
    let output = Command::new(&start.command)
        .args(&start.args)
        .arg("--version")
        .output()
        .with_context(|| format!("failed to probe Codex CLI version using {}", start.command))?;
    if !output.status.success() {
        bail!("unsupported Codex app-server version: version probe failed");
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = parse_version(&stdout)
        .context("unsupported Codex app-server version: invalid CLI version")?;
    if !is_supported_version(&version) {
        bail!("unsupported Codex app-server version {version}");
    }
    Ok(version)
}

fn is_supported_version(version: &str) -> bool {
    version
        .rsplit_once('.')
        .map(|(minor, _)| SUPPORTED_MINORS.contains(&minor))
        .unwrap_or(false)
}

fn parse_version(value: &str) -> Option<String> {
    value.split_whitespace().find_map(|part| {
        let candidate =
            part.trim_matches(|character: char| !character.is_ascii_digit() && character != '.');
        let mut pieces = candidate.split('.');
        let major = pieces.next()?;
        let minor = pieces.next()?;
        let patch = pieces
            .next()?
            .split(|character: char| !character.is_ascii_digit())
            .next()?;
        if pieces.next().is_some()
            || major.is_empty()
            || minor.is_empty()
            || patch.is_empty()
            || !major.chars().all(|character| character.is_ascii_digit())
            || !minor.chars().all(|character| character.is_ascii_digit())
            || !patch.chars().all(|character| character.is_ascii_digit())
        {
            return None;
        }
        Some(format!("{major}.{minor}.{patch}"))
    })
}

fn reserve_loopback_port() -> Result<u16> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).context("failed to reserve app-server port")?;
    Ok(listener.local_addr()?.port())
}

type AppSocket = WebSocket<MaybeTlsStream<TcpStream>>;

fn set_socket_timeout(socket: &mut AppSocket, timeout: Option<Duration>) -> Result<()> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            stream.set_read_timeout(timeout)?;
            stream.set_write_timeout(timeout)?;
            Ok(())
        }
        _ => bail!("Codex app-server must use a loopback ws:// connection"),
    }
}

fn connect_with_retry(url: &str, timeout: Duration) -> Result<AppSocket> {
    let deadline = Instant::now() + timeout;
    let mut last_error = None;
    while Instant::now() < deadline {
        match connect(url) {
            Ok((socket, _)) => return Ok(socket),
            Err(error) => last_error = Some(error),
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(anyhow::anyhow!(
        "Codex app-server WebSocket did not become ready: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "timeout".to_string())
    ))
}

fn initialize_session(
    socket: &mut AppSocket,
    resume_params: &Value,
    turn_params: &Value,
    on_event: &EventCallback,
) -> Result<()> {
    request(
        socket,
        1,
        "initialize",
        json!({
            "clientInfo": { "name": "vibelink-execution-worker", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": {
                "experimentalApi": true,
                "requestAttestation": false,
                "optOutNotificationMethods": []
            }
        }),
        on_event,
    )?;
    send_json(socket, &json!({ "method": "initialized", "params": {} }))?;
    request(socket, 2, "thread/resume", resume_params.clone(), on_event)?;
    request(socket, 3, "turn/start", turn_params.clone(), on_event)?;
    Ok(())
}

fn request(
    socket: &mut AppSocket,
    id: u64,
    method: &str,
    params: Value,
    on_event: &EventCallback,
) -> Result<Value> {
    send_json(
        socket,
        &json!({ "id": id, "method": method, "params": params }),
    )?;
    loop {
        let message = read_json(socket)?;
        if message.get("id").and_then(Value::as_u64) == Some(id) {
            if let Some(error) = message.get("error") {
                bail!("Codex app-server {method} failed: {error}");
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
        emit_normalized(&message, on_event)?;
    }
}

fn send_json(socket: &mut AppSocket, value: &Value) -> Result<()> {
    let payload = serde_json::to_string(value)?;
    if payload.len() > MAX_MESSAGE_BYTES {
        bail!("Codex app-server outbound message exceeds the protocol boundary");
    }
    socket
        .send(Message::Text(payload.into()))
        .context("failed to send app-server JSON-RPC message")
}

fn read_json(socket: &mut AppSocket) -> Result<Value> {
    loop {
        match socket
            .read()
            .context("failed to read app-server WebSocket")?
        {
            Message::Text(payload) => {
                if payload.len() > MAX_MESSAGE_BYTES {
                    bail!("Codex app-server message exceeds the protocol boundary");
                }
                return serde_json::from_str(&payload).context("invalid app-server JSON-RPC JSON");
            }
            Message::Binary(payload) => {
                if payload.len() > MAX_MESSAGE_BYTES {
                    bail!("Codex app-server message exceeds the protocol boundary");
                }
                return serde_json::from_slice(&payload)
                    .context("invalid app-server JSON-RPC JSON");
            }
            Message::Close(_) => bail!("Codex app-server WebSocket closed"),
            Message::Ping(payload) => socket.send(Message::Pong(payload))?,
            Message::Pong(_) | Message::Frame(_) => {}
        }
    }
}

fn read_notifications(
    socket: &mut AppSocket,
    on_event: &EventCallback,
    approvals: mpsc::Receiver<ApprovalCommand>,
) -> Result<()> {
    set_socket_timeout(socket, Some(Duration::from_millis(50)))?;
    let mut pending = HashMap::<String, PendingApproval>::new();
    let mut awaiting_applied = HashMap::<String, PendingApproval>::new();
    loop {
        while let Ok(command) = approvals.try_recv() {
            let result = deliver_approval(
                socket,
                on_event,
                &mut pending,
                &mut awaiting_applied,
                &command,
            )
            .map_err(|error| error.to_string());
            let _ = command.result.send(result);
        }
        match read_json(socket) {
            Ok(message) => {
                register_pending_approval(&message, &mut pending)?;
                settle_approval_from_message(&message, on_event, &mut awaiting_applied);
                emit_normalized(&message, on_event)?;
            }
            Err(error) if is_socket_timeout(&error) => {}
            Err(error) => return Err(error),
        }
    }
}

fn is_socket_timeout(error: &anyhow::Error) -> bool {
    error.chain().any(|source| {
        source.downcast_ref::<std::io::Error>().is_some_and(|io| {
            matches!(
                io.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            )
        })
    })
}

fn register_pending_approval(
    message: &Value,
    pending: &mut HashMap<String, PendingApproval>,
) -> Result<()> {
    let Some(object) = message.as_object() else {
        return Ok(());
    };
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Ok(());
    };
    if !matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
    ) {
        return Ok(());
    }
    let params = required_object(object, "params")?;
    let request_id = object
        .get("id")
        .cloned()
        .context("app-server approval request id is required")?;
    let thread_id = required_string(params, "threadId")?.to_string();
    let turn_id = required_string(params, "turnId")?.to_string();
    let item_id = required_string(params, "itemId")?.to_string();
    let continuation_ref = params
        .get("continuationRef")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("codex:{thread_id}:{turn_id}:{item_id}:{request_id}"));
    let available_decisions = params
        .get("availableDecisions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| default_approval_decisions(method));
    pending.insert(
        continuation_ref.clone(),
        PendingApproval {
            request_id,
            method: method.to_string(),
            thread_id,
            turn_id,
            item_id,
            continuation_ref,
            version: params
                .get("decisionVersion")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            available_decisions,
            requested_permissions: params
                .get("permissions")
                .or_else(|| params.get("additionalPermissions"))
                .cloned()
                .unwrap_or_else(|| json!({})),
        },
    );
    Ok(())
}

fn decision_name(decision: &Value) -> Option<&str> {
    decision
        .as_str()
        .or_else(|| decision.get("decision").and_then(Value::as_str))
        .or_else(|| decision.get("type").and_then(Value::as_str))
}

fn default_approval_decisions(method: &str) -> Vec<Value> {
    if method == "item/permissions/requestApproval" {
        vec![json!("grant"), json!("decline")]
    } else {
        vec![
            json!("accept"),
            json!("acceptForSession"),
            json!("decline"),
            json!("cancel"),
        ]
    }
}

fn normalized_decision(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphabetic())
        .flat_map(char::to_lowercase)
        .collect()
}

fn approval_response(approval: &PendingApproval, decision: &Value) -> Result<Value> {
    if !approval.available_decisions.is_empty() {
        let requested = decision_name(decision)
            .context("APPROVAL_DECISION_INVALID: decision type is required")?;
        let requested = normalized_decision(requested);
        let available = approval.available_decisions.iter().filter_map(|value| {
            value
                .as_str()
                .or_else(|| value.get("decision").and_then(Value::as_str))
        });
        if !available
            .map(normalized_decision)
            .any(|value| value == requested)
        {
            bail!("APPROVAL_DECISION_INVALID: decision is not available for this approval");
        }
    }
    if approval.method == "item/permissions/requestApproval" {
        let permissions = decision
            .get("permissions")
            .cloned()
            .or_else(|| {
                decision_name(decision)
                    .filter(|name| {
                        matches!(
                            normalized_decision(name).as_str(),
                            "accept" | "approved" | "grant" | "granted"
                        )
                    })
                    .map(|_| approval.requested_permissions.clone())
            })
            .or_else(|| {
                decision_name(decision)
                    .filter(|name| {
                        matches!(normalized_decision(name).as_str(), "decline" | "cancel")
                    })
                    .map(|_| json!({}))
            })
            .context("APPROVAL_DECISION_INVALID: permission decisions require permissions")?;
        return Ok(json!({ "permissions": permissions }));
    }
    let name =
        decision_name(decision).context("APPROVAL_DECISION_INVALID: decision type is required")?;
    Ok(json!({ "decision": name }))
}

fn deliver_approval(
    socket: &mut AppSocket,
    on_event: &EventCallback,
    pending: &mut HashMap<String, PendingApproval>,
    awaiting_applied: &mut HashMap<String, PendingApproval>,
    command: &ApprovalCommand,
) -> Result<Value> {
    let approval = pending
        .get(&command.continuation_ref)
        .cloned()
        .context("APPROVAL_STALE: approval continuation is no longer pending")?;
    if approval.version != command.expected_version {
        bail!("APPROVAL_STALE: approval decision version changed");
    }
    let response = approval_response(&approval, &command.decision)?;
    send_json(
        socket,
        &json!({ "id": approval.request_id, "result": response }),
    )?;
    pending.remove(&command.continuation_ref);
    awaiting_applied.insert(command.continuation_ref.clone(), approval.clone());
    on_event(
        "provider.event",
        provider_event(
            "provider.approval.delivered",
            Some(&approval.thread_id),
            Some(&approval.turn_id),
            Some(&approval.item_id),
            None,
            json!({
                "approvalId": command.approval_id,
                "continuationRef": approval.continuation_ref,
                "expectedDecisionVersion": command.expected_version,
                "decision": command.decision,
                "response": response
            }),
        ),
    );
    Ok(json!({ "delivered": true, "continuationRef": command.continuation_ref }))
}

fn settle_approval_from_message(
    message: &Value,
    on_event: &EventCallback,
    awaiting: &mut HashMap<String, PendingApproval>,
) {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let Some(params) = message.get("params").and_then(Value::as_object) else {
        return;
    };
    let turn_id = params.get("turnId").and_then(Value::as_str).or_else(|| {
        params
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
    });
    let item_id = params.get("itemId").and_then(Value::as_str).or_else(|| {
        params
            .get("item")
            .and_then(|item| item.get("id"))
            .and_then(Value::as_str)
    });
    let refs = awaiting
        .iter()
        .filter_map(|(reference, approval)| {
            if turn_id != Some(approval.turn_id.as_str()) {
                return None;
            }
            let stale = method == "turn/completed";
            let applied = item_id == Some(approval.item_id.as_str());
            (stale || applied).then(|| (reference.clone(), stale))
        })
        .collect::<Vec<_>>();
    for (reference, stale) in refs {
        if let Some(approval) = awaiting.remove(&reference) {
            on_event(
                "provider.event",
                provider_event(
                    if stale {
                        "provider.approval.stale"
                    } else {
                        "provider.approval.applied"
                    },
                    Some(&approval.thread_id),
                    Some(&approval.turn_id),
                    Some(&approval.item_id),
                    None,
                    json!({ "continuationRef": reference, "sourceMethod": method }),
                ),
            );
        }
    }
}

fn emit_normalized(message: &Value, on_event: &EventCallback) -> Result<()> {
    for event in normalize_message(message)? {
        on_event("provider.event", event);
    }
    Ok(())
}

fn normalize_message(message: &Value) -> Result<Vec<Value>> {
    let object = message
        .as_object()
        .context("app-server message must be an object")?;
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Ok(Vec::new());
    };
    let params = object
        .get("params")
        .and_then(Value::as_object)
        .context("app-server message params must be an object")?;
    match method {
        "thread/started" => {
            let thread = required_object(params, "thread")?;
            let thread_id = required_string(thread, "id")?;
            Ok(vec![provider_event(
                "provider.thread.started",
                Some(thread_id),
                None,
                None,
                timestamp_seconds(thread.get("createdAt")),
                json!({ "thread": thread }),
            )])
        }
        "turn/started" | "turn/completed" => {
            let thread_id = required_string(params, "threadId")?;
            let turn = required_object(params, "turn")?;
            let turn_id = required_string(turn, "id")?;
            let phase = if method == "turn/completed" {
                "completed"
            } else {
                "started"
            };
            Ok(vec![provider_event(
                &format!("provider.turn.{phase}"),
                Some(thread_id),
                Some(turn_id),
                None,
                timestamp_seconds(turn.get(if phase == "completed" {
                    "completedAt"
                } else {
                    "startedAt"
                })),
                json!({
                    "status": turn.get("status").cloned().unwrap_or(Value::Null),
                    "error": turn.get("error").cloned().unwrap_or(Value::Null),
                    "turn": turn
                }),
            )])
        }
        "item/started" | "item/completed" => normalize_item(method, params),
        "item/agentMessage/delta"
        | "item/commandExecution/outputDelta"
        | "item/fileChange/outputDelta"
        | "item/mcpToolCall/progress" => {
            let thread_id = required_string(params, "threadId")?;
            let turn_id = required_string(params, "turnId")?;
            let item_id = required_string(params, "itemId")?;
            let progress = method == "item/mcpToolCall/progress";
            let delta = params
                .get(if progress { "message" } else { "delta" })
                .and_then(Value::as_str)
                .context("app-server output delta must be a string")?;
            Ok(vec![provider_event(
                "provider.output.delta",
                Some(thread_id),
                Some(turn_id),
                Some(item_id),
                None,
                json!({
                    "channel": if method == "item/agentMessage/delta" { "assistant" } else { "tool" },
                    "delta": delta,
                    "progress": progress,
                    "sourceMethod": method
                }),
            )])
        }
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval" => normalize_approval(object, method, params),
        _ => Ok(Vec::new()),
    }
}

fn normalize_item(method: &str, params: &Map<String, Value>) -> Result<Vec<Value>> {
    let thread_id = required_string(params, "threadId")?;
    let turn_id = required_string(params, "turnId")?;
    let item = required_object(params, "item")?;
    let item_id = required_string(item, "id")?;
    let item_type = required_string(item, "type")?;
    let phase = if method == "item/completed" {
        "completed"
    } else {
        "started"
    };
    let status = item.get("status").cloned().unwrap_or(Value::Null);
    let mut events = vec![provider_event(
        &format!("provider.item.{phase}"),
        Some(thread_id),
        Some(turn_id),
        Some(item_id),
        timestamp_millis(params.get(if phase == "completed" {
            "completedAtMs"
        } else {
            "startedAtMs"
        })),
        json!({ "itemType": item_type, "status": status, "item": item }),
    )];
    if let Some(tool) = tool_identity(item_type, item) {
        let mut payload = tool;
        payload.insert("status".to_string(), status);
        payload.insert("item".to_string(), Value::Object(item.clone()));
        events.push(provider_event(
            &format!("provider.tool.{phase}"),
            Some(thread_id),
            Some(turn_id),
            Some(item_id),
            timestamp_millis(params.get(if phase == "completed" {
                "completedAtMs"
            } else {
                "startedAtMs"
            })),
            Value::Object(payload),
        ));
    }
    Ok(events)
}

fn tool_identity(item_type: &str, item: &Map<String, Value>) -> Option<Map<String, Value>> {
    let (name, namespace) = match item_type {
        "commandExecution" => (
            item.get("command")
                .and_then(Value::as_str)
                .unwrap_or("command"),
            None,
        ),
        "fileChange" => ("apply_patch", None),
        "mcpToolCall" => (
            item.get("tool").and_then(Value::as_str).unwrap_or(""),
            Some(item.get("server").cloned().unwrap_or(Value::Null)),
        ),
        "dynamicToolCall" => (
            item.get("tool").and_then(Value::as_str).unwrap_or(""),
            Some(item.get("namespace").cloned().unwrap_or(Value::Null)),
        ),
        "collabAgentToolCall" => (
            item.get("tool")
                .and_then(Value::as_str)
                .unwrap_or("collaboration"),
            None,
        ),
        "webSearch" => ("web_search", None),
        "imageGeneration" => ("image_generation", None),
        _ => return None,
    };
    let mut result = Map::new();
    result.insert("kind".to_string(), Value::String(item_type.to_string()));
    result.insert("name".to_string(), Value::String(name.to_string()));
    if let Some(namespace) = namespace {
        result.insert("namespace".to_string(), namespace);
    }
    Some(result)
}

fn normalize_approval(
    message: &Map<String, Value>,
    method: &str,
    params: &Map<String, Value>,
) -> Result<Vec<Value>> {
    let request_id = message
        .get("id")
        .context("app-server approval request id is required")?;
    if !request_id.is_string() && !request_id.is_number() {
        bail!("app-server approval request id must be a string or number");
    }
    let thread_id = required_string(params, "threadId")?;
    let turn_id = required_string(params, "turnId")?;
    let item_id = required_string(params, "itemId")?;
    let kind = match method {
        "item/commandExecution/requestApproval" => "commandExecution",
        "item/fileChange/requestApproval" => "fileChange",
        _ => "permissions",
    };
    let continuation_ref = params
        .get("continuationRef")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("codex:{thread_id}:{turn_id}:{item_id}:{}", request_id));
    Ok(vec![provider_event(
        "provider.approval.required",
        Some(thread_id),
        Some(turn_id),
        Some(item_id),
        timestamp_millis(params.get("startedAtMs")),
        json!({
            "kind": kind,
            "requestId": request_id,
            "requestIdType": if request_id.is_string() { "string" } else { "number" },
            "connectionScoped": true,
            "approvalId": params.get("approvalId").cloned().unwrap_or(Value::Null),
            "continuationRef": continuation_ref,
            "expectedDecisionVersion": params.get("decisionVersion").cloned().unwrap_or(json!(0)),
            "reason": params.get("reason").cloned().unwrap_or(Value::Null),
            "availableDecisions": params.get("availableDecisions").cloned().unwrap_or_else(|| Value::Array(default_approval_decisions(method))),
            "requestedPermissions": params.get("permissions").or_else(|| params.get("additionalPermissions")).cloned().unwrap_or(Value::Null),
            "request": params
        }),
    )])
}

fn provider_event(
    event_type: &str,
    thread_id: Option<&str>,
    turn_id: Option<&str>,
    item_id: Option<&str>,
    at: Option<String>,
    payload: Value,
) -> Value {
    json!({
        "type": event_type,
        "provider": "codex",
        "protocol": "codex-app-server",
        "threadId": thread_id,
        "turnId": turn_id,
        "itemId": item_id,
        "at": at.unwrap_or_else(super::now_rfc3339),
        "payload": payload
    })
}

fn timestamp_seconds(value: Option<&Value>) -> Option<String> {
    let seconds = value.and_then(Value::as_f64)?;
    let millis = (seconds * 1000.0) as i64;
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn timestamp_millis(value: Option<&Value>) -> Option<String> {
    let millis = value.and_then(Value::as_i64)?;
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn required_object<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Map<String, Value>> {
    object
        .get(field)
        .and_then(Value::as_object)
        .with_context(|| format!("app-server {field} must be an object"))
}

fn required_string<'a>(object: &'a Map<String, Value>, field: &str) -> Result<&'a str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("app-server {field} must be a non-empty string"))
}

fn wait_for_activation(activation: &Arc<(Mutex<bool>, Condvar)>) {
    let (active, condition) = &**activation;
    if let Ok(mut active) = active.lock() {
        while !*active {
            match condition.wait(active) {
                Ok(next) => active = next,
                Err(_) => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn version_gate_accepts_reviewed_minor_and_rejects_unknown_minor() {
        assert_eq!(
            parse_version("codex-cli 0.144.5\n").as_deref(),
            Some("0.144.5")
        );
        assert!(is_supported_version("0.144.5"));
        assert!(is_supported_version("0.117.0"));
        assert!(!is_supported_version("0.145.0"));
    }

    #[test]
    fn normalizes_reviewed_0144_tool_lifecycle_and_output() {
        let started = normalize_message(&json!({
            "method": "item/started",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": { "id": "item-1", "type": "commandExecution", "command": "cargo test", "status": "inProgress" }
            }
        })).unwrap();
        assert_eq!(started.len(), 2);
        assert_eq!(started[0]["type"], "provider.item.started");
        assert_eq!(started[1]["type"], "provider.tool.started");
        assert_eq!(started[1]["payload"]["name"], "cargo test");

        let output = normalize_message(&json!({
            "method": "item/commandExecution/outputDelta",
            "params": { "threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1", "delta": "ok\n" }
        })).unwrap();
        assert_eq!(output[0]["type"], "provider.output.delta");
        assert_eq!(output[0]["payload"]["delta"], "ok\n");
    }

    #[test]
    fn approval_is_observed_without_a_response_or_outbox_state() {
        let events = normalize_message(&json!({
            "id": 42,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "availableDecisions": ["accept", "decline"]
            }
        }))
        .unwrap();
        assert_eq!(events[0]["type"], "provider.approval.required");
        assert_eq!(events[0]["payload"]["requestId"], 42);
        assert_eq!(events[0]["payload"]["connectionScoped"], true);
        assert_eq!(
            events[0]["payload"]["availableDecisions"],
            json!(["accept", "acceptForSession", "decline", "cancel"])
        );
    }

    fn pending_approval(method: &str, available_decisions: Vec<Value>) -> PendingApproval {
        PendingApproval {
            request_id: json!(42),
            method: method.to_string(),
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            item_id: "item-1".to_string(),
            continuation_ref: "continuation-1".to_string(),
            version: 0,
            available_decisions,
            requested_permissions: json!({ "network": { "enabled": true } }),
        }
    }

    #[test]
    fn maps_command_file_and_permission_approval_responses() {
        let command = pending_approval(
            "item/commandExecution/requestApproval",
            default_approval_decisions("item/commandExecution/requestApproval"),
        );
        assert_eq!(
            approval_response(&command, &json!({ "decision": "acceptForSession" })).unwrap(),
            json!({ "decision": "acceptForSession" })
        );

        let file = pending_approval(
            "item/fileChange/requestApproval",
            default_approval_decisions("item/fileChange/requestApproval"),
        );
        assert_eq!(
            approval_response(&file, &json!({ "decision": "decline" })).unwrap(),
            json!({ "decision": "decline" })
        );

        let permissions = pending_approval(
            "item/permissions/requestApproval",
            default_approval_decisions("item/permissions/requestApproval"),
        );
        assert_eq!(
            approval_response(&permissions, &json!({ "decision": "grant" })).unwrap(),
            json!({ "permissions": { "network": { "enabled": true } } })
        );
        assert_eq!(
            approval_response(&permissions, &json!({ "decision": "decline" })).unwrap(),
            json!({ "permissions": {} })
        );
        assert!(approval_response(&permissions, &json!({ "decision": "accept" })).is_err());
    }

    #[test]
    fn websocket_session_initializes_resumes_and_starts_turn() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            let mut methods = Vec::new();
            for _ in 0..4 {
                let message: Value = match socket.read().unwrap() {
                    Message::Text(payload) => serde_json::from_str(&payload).unwrap(),
                    other => panic!("unexpected client message {other:?}"),
                };
                methods.push(message["method"].as_str().unwrap().to_string());
                if let Some(id) = message.get("id") {
                    if message["method"] == "turn/start" {
                        socket
                            .send(Message::Text(
                                json!({
                                    "method": "turn/started",
                                    "params": {
                                        "threadId": "thread-1",
                                        "turn": { "id": "turn-1", "status": "inProgress" }
                                    }
                                })
                                .to_string()
                                .into(),
                            ))
                            .unwrap();
                    }
                    socket
                        .send(Message::Text(
                            json!({ "id": id, "result": {} }).to_string().into(),
                        ))
                        .unwrap();
                }
            }
            methods
        });

        let (mut socket, _) = connect(&url).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let on_event: EventCallback = Arc::new(move |event_type, payload| {
            captured
                .lock()
                .unwrap()
                .push((event_type.to_string(), payload));
        });
        initialize_session(
            &mut socket,
            &json!({ "threadId": "thread-1" }),
            &json!({
                "threadId": "thread-1",
                "input": [{ "type": "text", "text": "hello", "text_elements": [] }]
            }),
            &on_event,
        )
        .unwrap();

        assert_eq!(
            server.join().unwrap(),
            vec!["initialize", "initialized", "thread/resume", "turn/start"]
        );
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "provider.event");
        assert_eq!(events[0].1["type"], "provider.turn.started");
    }
}
