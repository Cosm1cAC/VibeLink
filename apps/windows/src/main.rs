use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use qrcode::{render::unicode, QrCode};
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{self, BufRead, BufReader, Write};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc::{self, Receiver, RecvTimeoutError},
    Arc, Mutex, MutexGuard, TryLockError,
};
use std::{
    env,
    hash::{Hash, Hasher},
    net::UdpSocket,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Parser)]
#[command(name = "vibelink", version, about = "VibeLink Windows single entry")]
struct Cli {
    #[command(subcommand)]
    command: Option<Mode>,

    #[arg(long, global = true, default_value = "0.0.0.0")]
    host: String,

    #[arg(long, global = true, default_value_t = 8787)]
    port: u16,

    #[arg(long, global = true, default_value = "VibeLink Windows")]
    device_label: String,
}

#[derive(Debug, Clone, Subcommand)]
enum Mode {
    /// User-facing default mode: supervise bridge and show pairing QR.
    Run,
    /// Internal role: host the existing bridge process.
    Bridge,
    /// Create and print a QR pairing session for a running bridge.
    Pair,
    /// Check bridge health.
    Doctor,
    /// List a workspace directory using the Rust filesystem scanner.
    WorkspaceTree {
        #[arg(long)]
        root: PathBuf,
        #[arg(long, default_value = "")]
        dir: PathBuf,
        #[arg(long, default_value_t = 1)]
        depth: usize,
        #[arg(long = "max-entries", default_value_t = 240)]
        max_entries: usize,
    },
    /// Run the MCP stdio session JSONL sidecar.
    McpSessionSidecar,
    /// Run the event-store SQLite JSONL sidecar.
    EventStoreSidecar {
        #[arg(value_name = "DB_PATH")]
        db_path: PathBuf,
    },
}

#[derive(Debug, Serialize)]
struct CreatePairingRequest<'a> {
    #[serde(rename = "deviceLabel")]
    device_label: &'a str,
    #[serde(rename = "trustLocalLauncher")]
    trust_local_launcher: bool,
}

#[derive(Debug, Deserialize)]
struct CreatePairingResponse {
    ok: bool,
    session: Option<PairingSession>,
}

#[derive(Debug, Deserialize)]
struct PairingSession {
    id: String,
    code: String,
    status: String,
    #[serde(rename = "expiresAt")]
    expires_at: String,
}

#[derive(Debug, Serialize)]
struct WorkspaceTree {
    ok: bool,
    dir: String,
    truncated: bool,
    signature: String,
    items: Vec<WorkspaceTreeItem>,
}

#[derive(Debug, Serialize)]
struct WorkspaceTreeItem {
    name: String,
    path: String,
    #[serde(rename = "type")]
    kind: String,
    size: u64,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct SidecarRequest {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    args: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct McpServerConfig {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct McpSidecarOptions {
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    #[serde(rename = "maxIdleMs")]
    max_idle_ms: Option<u64>,
    #[serde(rename = "maxPendingRequests")]
    max_pending_requests: Option<usize>,
    timeout: Option<u64>,
}

struct McpStdioSession {
    server: McpServerConfig,
    child: Child,
    stdin: ChildStdin,
    stdout_rx: Receiver<Value>,
    closed: bool,
    next_id: u64,
    initialized: Option<Value>,
    tools: Option<Vec<Value>>,
    started_at: String,
    last_used_at: String,
    last_request_at: String,
    last_response_at: String,
    last_failure_at: String,
    last_backpressure_at: String,
    requests: u64,
    responses: u64,
    failures: u64,
    timeouts: u64,
    backpressure_rejects: u64,
    timeout_ms: u64,
    max_pending_requests: usize,
    max_pending_observed: usize,
    last_used: Instant,
}

struct McpSidecarManager {
    sessions: HashMap<String, Arc<Mutex<McpStdioSession>>>,
    active_requests: usize,
    max_active_requests: usize,
    max_active_observed: usize,
    sidecar_backpressure_rejects: u64,
    last_sidecar_backpressure_at: String,
}

const IGNORED_WORKSPACE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "target",
    "coverage",
    ".agent-mobile-terminal",
];

fn run_workspace_tree(root: &Path, dir: &Path, depth: usize, max_entries: usize) -> Result<()> {
    let tree = list_workspace_tree(root, dir, depth, max_entries)?;
    println!("{}", serde_json::to_string_pretty(&tree)?);
    Ok(())
}

fn run_mcp_session_sidecar() -> Result<()> {
    let stdin = io::stdin();
    let manager = Arc::new(Mutex::new(McpSidecarManager::new()));
    let (write_tx, write_rx) = mpsc::channel::<SidecarWrite>();
    let writer = thread::spawn(move || -> Result<()> {
        let mut stdout = io::stdout();
        for message in write_rx {
            match message {
                SidecarWrite::Result { id, result } => {
                    write_sidecar_result(&mut stdout, &id, result)?;
                }
                SidecarWrite::Error { id, message } => {
                    write_sidecar_error(&mut stdout, &id, &message)?;
                }
            }
        }
        Ok(())
    });

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: SidecarRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_tx.send(SidecarWrite::Error {
                    id: Value::Null,
                    message: error.to_string(),
                })?;
                continue;
            }
        };

        if request.method == "__close" {
            lock_mcp_manager(&manager)?.close_all();
            write_tx.send(SidecarWrite::Result {
                id: request.id,
                result: json!({ "ok": true }),
            })?;
            break;
        }

        match request.method.as_str() {
            "stats" | "closeIdleSessions" | "closeAll" => {
                let result = lock_mcp_manager(&manager)?.handle_control(&request.method, &request.args);
                send_sidecar_result(&write_tx, request.id, result)?;
            }
            _ => {
                let id = request.id;
                let method = request.method;
                let args = request.args;
                let should_run = lock_mcp_manager(&manager)?.try_start_sidecar_request(&method);
                if let Err(error) = should_run {
                    write_tx.send(SidecarWrite::Error {
                        id,
                        message: format!("{error:#}"),
                    })?;
                    continue;
                }

                let manager_for_worker = Arc::clone(&manager);
                let write_tx_for_worker = write_tx.clone();
                thread::spawn(move || {
                    let result = handle_mcp_sidecar_request(&manager_for_worker, &method, &args);
                    if let Ok(mut manager) = lock_mcp_manager(&manager_for_worker) {
                        manager.finish_sidecar_request();
                    }
                    let _ = send_sidecar_result(&write_tx_for_worker, id, result);
                });
            }
        }
    }

    lock_mcp_manager(&manager)?.close_all();
    drop(write_tx);
    writer
        .join()
        .map_err(|_| anyhow::anyhow!("MCP session sidecar writer thread panicked"))??;
    Ok(())
}

#[derive(Debug)]
enum SidecarWrite {
    Result { id: Value, result: Value },
    Error { id: Value, message: String },
}

fn send_sidecar_result(
    write_tx: &mpsc::Sender<SidecarWrite>,
    id: Value,
    result: Result<Value>,
) -> Result<()> {
    match result {
        Ok(result) => write_tx.send(SidecarWrite::Result { id, result })?,
        Err(error) => write_tx.send(SidecarWrite::Error {
            id,
            message: format!("{error:#}"),
        })?,
    }
    Ok(())
}

fn lock_mcp_manager(
    manager: &Arc<Mutex<McpSidecarManager>>,
) -> Result<MutexGuard<'_, McpSidecarManager>> {
    manager
        .lock()
        .map_err(|_| anyhow::anyhow!("MCP session sidecar manager lock was poisoned"))
}

fn lock_mcp_session(
    session: &Arc<Mutex<McpStdioSession>>,
) -> Result<MutexGuard<'_, McpStdioSession>> {
    session
        .lock()
        .map_err(|_| anyhow::anyhow!("MCP stdio session lock was poisoned"))
}

fn write_sidecar_result(stdout: &mut io::Stdout, id: &Value, result: Value) -> Result<()> {
    writeln!(stdout, "{}", json!({ "id": id, "result": result }))?;
    stdout.flush()?;
    Ok(())
}

fn write_sidecar_error(stdout: &mut io::Stdout, id: &Value, message: &str) -> Result<()> {
    writeln!(
        stdout,
        "{}",
        json!({
            "id": id,
            "error": {
                "name": "Error",
                "message": message,
                "stack": "",
                "code": ""
            }
        })
    )?;
    stdout.flush()?;
    Ok(())
}

fn sidecar_arg<T: DeserializeOwned>(args: &[Value], index: usize) -> Result<T> {
    let value = args
        .get(index)
        .cloned()
        .with_context(|| format!("Missing MCP session sidecar arg {index}"))?;
    Ok(serde_json::from_value(value)?)
}

fn sidecar_arg_or_default<T: DeserializeOwned + Default>(
    args: &[Value],
    index: usize,
) -> Result<T> {
    match args.get(index) {
        Some(value) if !value.is_null() => Ok(serde_json::from_value(value.clone())?),
        _ => Ok(T::default()),
    }
}

fn mcp_server_key(server: &McpServerConfig) -> String {
    let mut env = BTreeMap::new();
    for (key, value) in &server.env {
        env.insert(key, value);
    }
    serde_json::to_string(&json!({
        "id": server.id,
        "name": server.name,
        "command": server.command,
        "args": server.args,
        "cwd": server.cwd,
        "env": env
    }))
    .unwrap_or_default()
}

fn now_iso() -> String {
    let datetime: DateTime<Utc> = std::time::SystemTime::now().into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

static EVENT_STORE_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Default, Deserialize)]
struct EventStoreListTaskOptions {
    after: Option<i64>,
    limit: Option<i64>,
}

#[derive(Default, Deserialize)]
struct EventStoreListToolOptions {
    #[serde(rename = "toolRunId")]
    tool_run_id: Option<String>,
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
    #[serde(rename = "taskId")]
    task_id: Option<String>,
    after: Option<i64>,
    limit: Option<i64>,
}

#[derive(Default, Deserialize)]
struct EventStoreListLiveOptions {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    after: Option<i64>,
    limit: Option<i64>,
}

#[derive(Default, Deserialize)]
struct EventStoreUnifiedOptions {
    #[serde(rename = "taskId")]
    task_id: Option<String>,
    #[serde(rename = "liveCallSessionId")]
    live_call_session_id: Option<String>,
    #[serde(rename = "toolRunId")]
    tool_run_id: Option<String>,
    after: Option<i64>,
    limit: Option<i64>,
}

#[derive(Default, Deserialize)]
struct EventStorePruneToolOptions {
    before: Option<String>,
    #[serde(rename = "keepLatest")]
    keep_latest: Option<i64>,
    #[serde(rename = "dryRun")]
    dry_run: Option<bool>,
}

#[derive(Default, Deserialize)]
struct EventStorePruneLiveOptions {
    #[serde(rename = "retentionDays")]
    retention_days: Option<i64>,
    #[serde(rename = "keepLatest")]
    keep_latest: Option<i64>,
}

struct EventStoreSidecar {
    db: Connection,
}

#[derive(Clone)]
struct EventStoreUnifiedItem {
    cursor: i64,
    event_id: String,
    event_type: String,
    kind: String,
    at: String,
    text: String,
    session_id: String,
    task_id: String,
    tool_run_id: String,
    turn_id: String,
    block_id: String,
}

#[derive(Clone)]
struct EventStoreReplayItem {
    cursor: i64,
    raw_cursor: i64,
    event_id: String,
    event_type: String,
    kind: String,
    at: String,
    text: String,
    session_id: String,
    task_id: String,
    tool_run_id: String,
    turn_id: String,
    block_id: String,
}

fn normalize_event_replay_limit(value: Option<i64>, default_limit: i64, max_limit: i64) -> i64 {
    let fallback = default_limit.max(1).min(max_limit.max(1));
    match value {
        Some(value) if value > 0 => value.min(max_limit.max(1)),
        _ => fallback,
    }
}

fn clean_string(value: Option<&str>, max: usize) -> String {
    value.unwrap_or("").trim().chars().take(max).collect()
}

fn event_string(event: &Value, key: &str) -> String {
    event.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn event_payload_json(event: &Value) -> Result<String> {
    Ok(serde_json::to_string(event.get("payload").unwrap_or(&Value::Null))?)
}

fn classify_task_event_kind(event: &Value) -> String {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "user_message" | "user" | "attachment" => "user".to_string(),
        "assistant_message" | "assistant" => "assistant".to_string(),
        "system" => "system".to_string(),
        "error" => "error".to_string(),
        "summarization" => "summary".to_string(),
        "stderr" | "stdout" => "output".to_string(),
        _ if event_type.starts_with("live_call.") => "live_call".to_string(),
        _ if event_type.starts_with("approval.") => "approval".to_string(),
        _ if event_type.starts_with("tool.") => "tool".to_string(),
        _ => "system".to_string(),
    }
}

fn generated_event_id(prefix: &str) -> String {
    let counter = EVENT_STORE_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}:{}:{counter}", now_iso())
}

fn set_json_string(value: &mut Value, key: &str, text: String) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.to_string(), Value::String(text));
    }
}

fn encode_replay_cursor(cursor: i64, source_rank: i64) -> i64 {
    (cursor.max(0) * 10) + source_rank
}

fn replay_cursor_parts(value: Option<i64>) -> (i64, i64) {
    let cursor = value.unwrap_or(0).max(0);
    (cursor / 10, cursor % 10)
}

fn run_event_store_sidecar(db_path: &Path) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut sidecar = EventStoreSidecar::open(db_path)?;

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: SidecarRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_sidecar_error(&mut stdout, &Value::Null, &error.to_string())?;
                continue;
            }
        };

        if request.method == "__close" {
            write_sidecar_result(&mut stdout, &request.id, Value::Bool(true))?;
            break;
        }

        match sidecar.handle(&request.method, &request.args) {
            Ok(result) => write_sidecar_result(&mut stdout, &request.id, result)?,
            Err(error) => write_sidecar_error(&mut stdout, &request.id, &format!("{error:#}"))?,
        }
    }

    Ok(())
}

impl EventStoreSidecar {
    fn open(db_path: &Path) -> Result<Self> {
        let db = Connection::open(db_path)
            .with_context(|| format!("Failed to open event store database: {}", db_path.display()))?;
        db.busy_timeout(Duration::from_millis(5000))?;
        db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
        Ok(Self { db })
    }

    fn handle(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        match method {
            "insertTaskEvent" => {
                let task_id: String = sidecar_arg(args, 0)?;
                let event: Value = sidecar_arg(args, 1)?;
                Ok(json!(self.insert_task_event(&task_id, &event)?))
            }
            "insertTaskEvents" => {
                let task_id: String = sidecar_arg(args, 0)?;
                let events: Vec<Value> = sidecar_arg_or_default(args, 1)?;
                Ok(json!(self.insert_task_events(&task_id, &events)?))
            }
            "listTaskEvents" => {
                let task_id: String = sidecar_arg(args, 0)?;
                let options: EventStoreListTaskOptions = sidecar_arg_or_default(args, 1)?;
                Ok(Value::Array(self.list_task_events(&task_id, &options)?))
            }
            "getTaskEventCount" => {
                let task_id: String = sidecar_arg(args, 0)?;
                Ok(json!(self.get_task_event_count(&task_id)?))
            }
            "insertToolEvent" => {
                let tool_run_id: String = sidecar_arg(args, 0)?;
                let event: Value = sidecar_arg(args, 1)?;
                Ok(json!(self.insert_tool_event(&tool_run_id, &event)?))
            }
            "insertToolEvents" => {
                let tool_run_id: String = sidecar_arg(args, 0)?;
                let events: Vec<Value> = sidecar_arg_or_default(args, 1)?;
                Ok(json!(self.insert_tool_events(&tool_run_id, &events)?))
            }
            "listToolEvents" => {
                let options: EventStoreListToolOptions = sidecar_arg_or_default(args, 0)?;
                Ok(Value::Array(self.list_tool_events(&options)?))
            }
            "getToolEventStats" => Ok(self.get_tool_event_stats()?),
            "pruneToolEvents" => {
                let options: EventStorePruneToolOptions = sidecar_arg_or_default(args, 0)?;
                Ok(self.prune_tool_events(&options)?)
            }
            "insertLiveCallEvent" => {
                let session_id: String = sidecar_arg(args, 0)?;
                let event: Value = sidecar_arg(args, 1)?;
                Ok(json!(self.insert_live_call_event(&session_id, &event)?))
            }
            "insertLiveCallEvents" => {
                let session_id: String = sidecar_arg(args, 0)?;
                let events: Vec<Value> = sidecar_arg_or_default(args, 1)?;
                Ok(json!(self.insert_live_call_events(&session_id, &events)?))
            }
            "listLiveCallEvents" => {
                let options: EventStoreListLiveOptions = sidecar_arg_or_default(args, 0)?;
                Ok(Value::Array(self.list_live_call_events(&options)?))
            }
            "pruneLiveCallEvents" => {
                let options: EventStorePruneLiveOptions = sidecar_arg_or_default(args, 0)?;
                self.prune_live_call_events(&options)?;
                Ok(Value::Null)
            }
            "listUnifiedEvents" => {
                let options: EventStoreUnifiedOptions = sidecar_arg_or_default(args, 0)?;
                Ok(Value::Array(self.list_unified_events(&options)?))
            }
            "replayWindow" => {
                let options: EventStoreUnifiedOptions = sidecar_arg_or_default(args, 0)?;
                Ok(self.replay_window(&options)?)
            }
            _ => bail!("Unsupported event store sidecar method: {method}"),
        }
    }

    fn insert_task_event(&self, task_id: &str, event: &Value) -> Result<Option<i64>> {
        let current = now_iso();
        let event_at = event
            .get("at")
            .and_then(Value::as_str)
            .unwrap_or(&current)
            .to_string();
        let event_id = match event.get("id").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => generated_event_id(task_id),
        };
        let event_kind = match event.get("kind").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => classify_task_event_kind(event),
        };
        let turn_id = event_string(event, "turnId");
        let block_id = event_string(event, "blockId");
        let mut event_json = event.clone();
        if !event_json.is_object() {
            event_json = json!({});
        }
        set_json_string(&mut event_json, "id", event_id.clone());
        set_json_string(&mut event_json, "at", event_at.clone());
        set_json_string(&mut event_json, "kind", event_kind.clone());
        set_json_string(&mut event_json, "turnId", turn_id.clone());
        set_json_string(&mut event_json, "blockId", block_id.clone());
        let event_json_text = serde_json::to_string(&event_json)?;
        let payload_json = event_payload_json(event)?;

        self.db.execute(
            "INSERT OR IGNORE INTO task_events (
                task_id, event_id, event_type, event_at, text, payload_json, event_json,
                created_at, event_kind, turn_id, block_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                task_id,
                event_id,
                event_string(event, "type"),
                event_at,
                event_string(event, "text"),
                payload_json,
                event_json_text,
                current,
                event_kind,
                turn_id,
                block_id
            ],
        )?;
        let cursor = self
            .db
            .query_row(
                "SELECT cursor FROM task_events WHERE task_id = ? AND event_id = ?",
                params![task_id, event_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(cursor)
    }

    fn insert_task_events(&mut self, task_id: &str, events: &[Value]) -> Result<Vec<Option<i64>>> {
        if events.is_empty() {
            return Ok(Vec::new());
        }
        let mut cursors = Vec::with_capacity(events.len());
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        for event in events {
            match self.insert_task_event(task_id, event) {
                Ok(cursor) => cursors.push(cursor),
                Err(error) => {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(error);
                }
            }
        }
        self.db.execute_batch("COMMIT")?;
        Ok(cursors)
    }

    fn list_task_events(&self, task_id: &str, options: &EventStoreListTaskOptions) -> Result<Vec<Value>> {
        let mut statement = self.db.prepare(
            "SELECT cursor, event_json FROM task_events WHERE task_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?",
        )?;
        let rows = statement.query_map(
            params![
                task_id,
                options.after.unwrap_or(0),
                normalize_event_replay_limit(options.limit, 500, 5000)
            ],
            |row| {
                let cursor: i64 = row.get(0)?;
                let event_json: String = row.get(1)?;
                Ok((cursor, event_json))
            },
        )?;
        rows.map(|row| event_json_with_cursor(row?, false)).collect()
    }

    fn get_task_event_count(&self, task_id: &str) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT COUNT(*) FROM task_events WHERE task_id = ?",
            params![task_id],
            |row| row.get::<_, i64>(0),
        )?)
    }

    fn insert_tool_event(&self, tool_run_id: &str, event: &Value) -> Result<Option<i64>> {
        let run = self
            .db
            .query_row(
                "SELECT task_id, workspace_id FROM tool_runs WHERE id = ?",
                params![tool_run_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        let Some((run_task_id, run_workspace_id)) = run else {
            return Ok(None);
        };
        let current = now_iso();
        let event_at = event
            .get("at")
            .and_then(Value::as_str)
            .unwrap_or(&current)
            .to_string();
        let event_id = match event.get("id").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => generated_event_id(tool_run_id),
        };
        let task_id = match event.get("taskId").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => run_task_id.unwrap_or_default(),
        };
        let workspace_id = match event.get("workspaceId").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => run_workspace_id.unwrap_or_default(),
        };
        let mut event_json = event.clone();
        if !event_json.is_object() {
            event_json = json!({});
        }
        set_json_string(&mut event_json, "id", event_id.clone());
        set_json_string(&mut event_json, "at", event_at.clone());
        set_json_string(&mut event_json, "toolRunId", tool_run_id.to_string());
        set_json_string(&mut event_json, "taskId", task_id.clone());
        set_json_string(&mut event_json, "workspaceId", workspace_id.clone());
        let event_type = clean_string(
            event.get("type").and_then(Value::as_str).or(Some("tool.event")),
            120,
        );

        self.db.execute(
            "INSERT OR IGNORE INTO tool_events (
                tool_run_id, task_id, workspace_id, event_id, event_type, event_at,
                text, payload_json, event_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                tool_run_id,
                task_id,
                workspace_id,
                event_id,
                event_type,
                event_at,
                event_string(event, "text"),
                event_payload_json(event)?,
                serde_json::to_string(&event_json)?,
                current
            ],
        )?;
        Ok(self
            .db
            .query_row(
                "SELECT cursor FROM tool_events WHERE tool_run_id = ? AND event_id = ?",
                params![tool_run_id, event_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?)
    }

    fn insert_tool_events(&mut self, tool_run_id: &str, events: &[Value]) -> Result<Vec<Option<i64>>> {
        if events.is_empty() {
            return Ok(Vec::new());
        }
        let mut cursors = Vec::with_capacity(events.len());
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        for event in events {
            match self.insert_tool_event(tool_run_id, event) {
                Ok(cursor) => cursors.push(cursor),
                Err(error) => {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(error);
                }
            }
        }
        self.db.execute_batch("COMMIT")?;
        Ok(cursors)
    }

    fn list_tool_events(&self, options: &EventStoreListToolOptions) -> Result<Vec<Value>> {
        let tool_run_id = clean_string(options.tool_run_id.as_deref(), 160);
        let workspace_id = clean_string(options.workspace_id.as_deref(), 160);
        let task_id = clean_string(options.task_id.as_deref(), 160);
        let mut statement = self.db.prepare(
            "SELECT cursor, event_json FROM tool_events
             WHERE cursor > ?
               AND (? = '' OR tool_run_id = ?)
               AND (? = '' OR workspace_id = ?)
               AND (? = '' OR task_id = ?)
             ORDER BY cursor ASC LIMIT ?",
        )?;
        let rows = statement.query_map(
            params![
                options.after.unwrap_or(0),
                tool_run_id,
                tool_run_id,
                workspace_id,
                workspace_id,
                task_id,
                task_id,
                normalize_event_replay_limit(options.limit, 500, 5000)
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )?;
        rows.map(|row| event_json_with_cursor(row?, false)).collect()
    }

    fn get_tool_event_stats(&self) -> Result<Value> {
        let row = self.db.query_row(
            "SELECT COUNT(*), MIN(cursor), MAX(cursor), MIN(event_at), MAX(event_at) FROM tool_events",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )?;
        Ok(json!({
            "count": row.0,
            "minCursor": row.1.unwrap_or(0),
            "maxCursor": row.2.unwrap_or(0),
            "oldestAt": row.3.unwrap_or_default(),
            "newestAt": row.4.unwrap_or_default()
        }))
    }

    fn prune_tool_events(&self, options: &EventStorePruneToolOptions) -> Result<Value> {
        let cutoff = options.before.clone().unwrap_or_else(|| default_retention_cutoff(30));
        let keep = options.keep_latest.unwrap_or(5000).max(0);
        let dry_run = options.dry_run.unwrap_or(true);
        let max_prunable_cursor = self
            .db
            .query_row(
                "SELECT cursor FROM tool_events ORDER BY cursor DESC LIMIT 1 OFFSET ?",
                params![keep],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0);
        let prunable = self.db.query_row(
            "SELECT COUNT(*) FROM tool_events WHERE event_at < ? AND (? = 0 OR cursor <= ?)",
            params![cutoff, max_prunable_cursor, max_prunable_cursor],
            |row| row.get::<_, i64>(0),
        )?;
        let deleted = if dry_run || prunable <= 0 {
            0
        } else {
            self.db.execute(
                "DELETE FROM tool_events WHERE event_at < ? AND (? = 0 OR cursor <= ?)",
                params![cutoff, max_prunable_cursor, max_prunable_cursor],
            )? as i64
        };
        Ok(json!({
            "cutoff": cutoff,
            "keepLatest": keep,
            "maxPrunableCursor": max_prunable_cursor,
            "prunable": prunable,
            "deleted": deleted,
            "dryRun": dry_run,
            "stats": self.get_tool_event_stats()?
        }))
    }

    fn insert_live_call_event(&self, session_id: &str, event: &Value) -> Result<Option<i64>> {
        let exists = self
            .db
            .query_row("SELECT id FROM live_calls WHERE id = ?", params![session_id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?;
        if exists.is_none() {
            return Ok(None);
        }
        let current = now_iso();
        let event_at = event
            .get("at")
            .and_then(Value::as_str)
            .unwrap_or(&current)
            .to_string();
        let event_id = match event.get("id").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => generated_event_id(session_id),
        };
        let mut event_json = event.clone();
        if !event_json.is_object() {
            event_json = json!({});
        }
        set_json_string(&mut event_json, "id", event_id.clone());
        set_json_string(&mut event_json, "at", event_at.clone());
        set_json_string(&mut event_json, "sessionId", session_id.to_string());
        let event_type = clean_string(
            event.get("type").and_then(Value::as_str).or(Some("live_call.event")),
            120,
        );

        self.db.execute(
            "INSERT OR IGNORE INTO live_call_events (
                session_id, event_id, event_type, event_at, text, payload_json, event_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                session_id,
                event_id,
                event_type,
                event_at,
                event_string(event, "text"),
                event_payload_json(event)?,
                serde_json::to_string(&event_json)?,
                current
            ],
        )?;
        Ok(self
            .db
            .query_row(
                "SELECT cursor FROM live_call_events WHERE session_id = ? AND event_id = ?",
                params![session_id, event_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?)
    }

    fn insert_live_call_events(&mut self, session_id: &str, events: &[Value]) -> Result<Vec<Option<i64>>> {
        if events.is_empty() {
            return Ok(Vec::new());
        }
        let mut cursors = Vec::with_capacity(events.len());
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        for event in events {
            match self.insert_live_call_event(session_id, event) {
                Ok(cursor) => cursors.push(cursor),
                Err(error) => {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(error);
                }
            }
        }
        self.db.execute_batch("COMMIT")?;
        Ok(cursors)
    }

    fn list_live_call_events(&self, options: &EventStoreListLiveOptions) -> Result<Vec<Value>> {
        let session_id = options.session_id.as_deref().unwrap_or("");
        if session_id.is_empty() {
            return Ok(Vec::new());
        }
        let mut statement = self.db.prepare(
            "SELECT cursor, event_json FROM live_call_events WHERE session_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?",
        )?;
        let rows = statement.query_map(
            params![
                session_id,
                options.after.unwrap_or(0),
                normalize_event_replay_limit(options.limit, 500, 2000)
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )?;
        rows.map(|row| event_json_with_cursor(row?, false)).collect()
    }

    fn prune_live_call_events(&self, options: &EventStorePruneLiveOptions) -> Result<()> {
        let cutoff = default_retention_cutoff(options.retention_days.unwrap_or(30));
        let keep_latest = options.keep_latest.unwrap_or(5000).max(0);
        self.db.execute(
            "DELETE FROM live_call_events WHERE event_at < ? AND cursor NOT IN (
                SELECT cursor FROM live_call_events WHERE session_id IN (SELECT id FROM live_calls) ORDER BY cursor DESC LIMIT ?
            )",
            params![cutoff, keep_latest],
        )?;
        Ok(())
    }

    fn list_unified_events(&self, options: &EventStoreUnifiedOptions) -> Result<Vec<Value>> {
        let limit = normalize_event_replay_limit(options.limit, 200, 2000);
        let mut items = self.collect_unified_items(options, options.after.unwrap_or(0), limit, false)?;
        items.sort_by_key(|item| item.cursor);
        Ok(items.into_iter().take(limit as usize).map(unified_item_json).collect())
    }

    fn replay_window(&self, options: &EventStoreUnifiedOptions) -> Result<Value> {
        let limit = normalize_event_replay_limit(options.limit, 200, 2000);
        let query_limit = limit + 1;
        let items = self.collect_replay_items(options, query_limit)?;
        let has_more = items.len() > limit as usize;
        let window_items: Vec<EventStoreReplayItem> = items.into_iter().take(limit as usize).collect();
        let next_cursor = window_items
            .last()
            .map(|item| item.cursor)
            .unwrap_or_else(|| options.after.unwrap_or(0));
        Ok(json!({
            "items": window_items.iter().map(replay_item_json).collect::<Vec<Value>>(),
            "nextCursor": next_cursor,
            "hasMore": has_more,
            "limit": limit
        }))
    }

    fn collect_unified_items(
        &self,
        options: &EventStoreUnifiedOptions,
        after: i64,
        query_limit: i64,
        include_equal: bool,
    ) -> Result<Vec<EventStoreUnifiedItem>> {
        let task_id = clean_string(options.task_id.as_deref(), 160);
        let session_id = clean_string(options.live_call_session_id.as_deref(), 160);
        let tool_run_id = clean_string(options.tool_run_id.as_deref(), 160);
        let comparator = if include_equal { ">=" } else { ">" };
        let mut results = Vec::new();

        if options.live_call_session_id.is_none() && options.tool_run_id.is_none() {
            let sql = format!(
                "SELECT cursor, task_id, event_id, event_type, event_kind, turn_id, block_id, event_at, text
                 FROM task_events WHERE (? = '' OR task_id = ?) AND cursor {comparator} ? ORDER BY cursor ASC LIMIT ?"
            );
            let mut statement = self.db.prepare(&sql)?;
            let rows = statement.query_map(params![task_id, task_id, after, query_limit], |row| {
                Ok(EventStoreUnifiedItem {
                    cursor: row.get(0)?,
                    task_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    event_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    event_type: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    kind: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    turn_id: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    block_id: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    at: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                    text: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                    session_id: String::new(),
                    tool_run_id: String::new(),
                })
            })?;
            for row in rows {
                results.push(row?);
            }
        }

        if options.live_call_session_id.is_none() {
            let remaining = query_limit - results.len() as i64;
            if remaining > 0 {
                let sql = format!(
                    "SELECT cursor, task_id, tool_run_id, event_id, event_type, event_at, text
                     FROM tool_events
                     WHERE (? = '' OR task_id = ?) AND (? = '' OR tool_run_id = ?) AND cursor {comparator} ?
                     ORDER BY cursor ASC LIMIT ?"
                );
                let mut statement = self.db.prepare(&sql)?;
                let rows = statement.query_map(params![task_id, task_id, tool_run_id, tool_run_id, after, remaining], |row| {
                    Ok(EventStoreUnifiedItem {
                        cursor: row.get(0)?,
                        task_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        tool_run_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        event_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        event_type: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        at: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                        text: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        kind: "tool".to_string(),
                        session_id: String::new(),
                        turn_id: String::new(),
                        block_id: String::new(),
                    })
                })?;
                for row in rows {
                    results.push(row?);
                }
            }
        }

        if options.task_id.is_none() && options.tool_run_id.is_none() {
            let remaining = query_limit - results.len() as i64;
            if remaining > 0 {
                let sql = format!(
                    "SELECT cursor, session_id, event_id, event_type, event_at, text
                     FROM live_call_events WHERE (? = '' OR session_id = ?) AND cursor {comparator} ? ORDER BY cursor ASC LIMIT ?"
                );
                let mut statement = self.db.prepare(&sql)?;
                let rows = statement.query_map(params![session_id, session_id, after, remaining], |row| {
                    Ok(EventStoreUnifiedItem {
                        cursor: row.get(0)?,
                        session_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        event_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        event_type: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        at: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        text: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                        kind: "live_call".to_string(),
                        task_id: String::new(),
                        tool_run_id: String::new(),
                        turn_id: String::new(),
                        block_id: String::new(),
                    })
                })?;
                for row in rows {
                    results.push(row?);
                }
            }
        }

        Ok(results)
    }

    fn collect_replay_items(&self, options: &EventStoreUnifiedOptions, query_limit: i64) -> Result<Vec<EventStoreReplayItem>> {
        let (raw_after, source_after) = replay_cursor_parts(options.after);
        let mut items = Vec::new();
        for source_rank in [1, 2, 3] {
            let min_cursor = if source_rank > source_after { raw_after } else { raw_after + 1 };
            match source_rank {
                1 if options.live_call_session_id.is_none() && options.tool_run_id.is_none() => {
                    for item in self.collect_unified_items(options, min_cursor, query_limit, true)? {
                        if item.session_id.is_empty() && item.tool_run_id.is_empty() {
                            items.push(replay_from_unified(item, source_rank));
                        }
                    }
                }
                2 if options.live_call_session_id.is_none() => {
                    let mut tool_options = EventStoreUnifiedOptions {
                        task_id: options.task_id.clone(),
                        tool_run_id: options.tool_run_id.clone(),
                        live_call_session_id: None,
                        after: Some(min_cursor),
                        limit: Some(query_limit),
                    };
                    let task_id_filter = tool_options.task_id.clone();
                    let tool_run_filter = tool_options.tool_run_id.clone();
                    let tool_rows = self.list_tool_rows(&mut tool_options, task_id_filter, tool_run_filter, min_cursor, query_limit)?;
                    items.extend(tool_rows.into_iter().map(|item| replay_from_unified(item, source_rank)));
                }
                3 if options.task_id.is_none() && options.tool_run_id.is_none() => {
                    let live_rows = self.list_live_rows(options.live_call_session_id.clone(), min_cursor, query_limit)?;
                    items.extend(live_rows.into_iter().map(|item| replay_from_unified(item, source_rank)));
                }
                _ => {}
            }
        }
        items.sort_by_key(|item| item.cursor);
        Ok(items)
    }

    fn list_tool_rows(
        &self,
        _options: &mut EventStoreUnifiedOptions,
        task_id: Option<String>,
        tool_run_id: Option<String>,
        min_cursor: i64,
        query_limit: i64,
    ) -> Result<Vec<EventStoreUnifiedItem>> {
        let task_id = clean_string(task_id.as_deref(), 160);
        let tool_run_id = clean_string(tool_run_id.as_deref(), 160);
        let mut statement = self.db.prepare(
            "SELECT cursor, task_id, tool_run_id, event_id, event_type, event_at, text
             FROM tool_events WHERE (? = '' OR task_id = ?) AND (? = '' OR tool_run_id = ?) AND cursor >= ? ORDER BY cursor ASC LIMIT ?",
        )?;
        let rows = statement.query_map(params![task_id, task_id, tool_run_id, tool_run_id, min_cursor, query_limit], |row| {
            Ok(EventStoreUnifiedItem {
                cursor: row.get(0)?,
                task_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                tool_run_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                event_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                event_type: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                at: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                text: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                kind: "tool".to_string(),
                session_id: String::new(),
                turn_id: String::new(),
                block_id: String::new(),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    fn list_live_rows(
        &self,
        session_id: Option<String>,
        min_cursor: i64,
        query_limit: i64,
    ) -> Result<Vec<EventStoreUnifiedItem>> {
        let session_id = clean_string(session_id.as_deref(), 160);
        let mut statement = self.db.prepare(
            "SELECT cursor, session_id, event_id, event_type, event_at, text
             FROM live_call_events WHERE (? = '' OR session_id = ?) AND cursor >= ? ORDER BY cursor ASC LIMIT ?",
        )?;
        let rows = statement.query_map(params![session_id, session_id, min_cursor, query_limit], |row| {
            Ok(EventStoreUnifiedItem {
                cursor: row.get(0)?,
                session_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                event_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                event_type: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                at: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                text: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                kind: "live_call".to_string(),
                task_id: String::new(),
                tool_run_id: String::new(),
                turn_id: String::new(),
                block_id: String::new(),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }
}

fn event_json_with_cursor((cursor, event_json): (i64, String), raw_cursor: bool) -> Result<Value> {
    let mut value = serde_json::from_str::<Value>(&event_json).unwrap_or_else(|_| json!({}));
    if !value.is_object() {
        value = json!({});
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("cursor".to_string(), json!(cursor));
        if raw_cursor {
            object.insert("rawCursor".to_string(), json!(cursor));
        }
    }
    Ok(value)
}

fn unified_item_json(item: EventStoreUnifiedItem) -> Value {
    json!({
        "cursor": item.cursor,
        "eventId": item.event_id,
        "type": item.event_type,
        "kind": item.kind,
        "at": item.at,
        "text": item.text,
        "sessionId": item.session_id,
        "taskId": item.task_id,
        "toolRunId": item.tool_run_id,
        "turnId": item.turn_id,
        "blockId": item.block_id
    })
}

fn replay_from_unified(item: EventStoreUnifiedItem, source_rank: i64) -> EventStoreReplayItem {
    EventStoreReplayItem {
        cursor: encode_replay_cursor(item.cursor, source_rank),
        raw_cursor: item.cursor,
        event_id: item.event_id,
        event_type: item.event_type,
        kind: item.kind,
        at: item.at,
        text: item.text,
        session_id: item.session_id,
        task_id: item.task_id,
        tool_run_id: item.tool_run_id,
        turn_id: item.turn_id,
        block_id: item.block_id,
    }
}

fn replay_item_json(item: &EventStoreReplayItem) -> Value {
    json!({
        "cursor": item.cursor,
        "rawCursor": item.raw_cursor,
        "eventId": item.event_id,
        "type": item.event_type,
        "kind": item.kind,
        "at": item.at,
        "text": item.text,
        "sessionId": item.session_id,
        "taskId": item.task_id,
        "toolRunId": item.tool_run_id,
        "turnId": item.turn_id,
        "blockId": item.block_id
    })
}

fn default_retention_cutoff(days: i64) -> String {
    let now = std::time::SystemTime::now();
    let duration = Duration::from_secs(days.max(0) as u64 * 24 * 60 * 60);
    let cutoff = now.checked_sub(duration).unwrap_or(now);
    let datetime: DateTime<Utc> = cutoff.into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn mcp_sidecar_max_active_requests() -> usize {
    env::var("VIBELINK_MCP_SESSION_SIDECAR_MAX_ACTIVE_REQUESTS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(64)
}

fn handle_mcp_sidecar_request(
    manager: &Arc<Mutex<McpSidecarManager>>,
    method: &str,
    args: &[Value],
) -> Result<Value> {
    match method {
        "probeStdioServer" => {
            let server: McpServerConfig = sidecar_arg(args, 0)?;
            let options: McpSidecarOptions = sidecar_arg_or_default(args, 1)?;
            let session = {
                let mut manager = lock_mcp_manager(manager)?;
                manager.session_for(server, &options)?
            };
            let mut session = lock_mcp_session(&session)?;
            session.apply_options(&options);
            let initialize = session.ensure_initialized()?;
            let tools = session.list_tools()?;
            Ok(json!({
                "ok": true,
                "transport": "stdio",
                "protocolVersion": initialize.get("protocolVersion").and_then(Value::as_str).unwrap_or(""),
                "serverInfo": initialize.get("serverInfo").cloned().unwrap_or(Value::Null),
                "capabilities": initialize.get("capabilities").cloned().unwrap_or(Value::Null),
                "tools": tools,
                "stderr": ""
            }))
        }
        "listTools" => {
            let server: McpServerConfig = sidecar_arg(args, 0)?;
            let options: McpSidecarOptions = sidecar_arg_or_default(args, 1)?;
            let session = {
                let mut manager = lock_mcp_manager(manager)?;
                manager.session_for(server, &options)?
            };
            let mut session = lock_mcp_session(&session)?;
            session.apply_options(&options);
            Ok(Value::Array(session.list_tools()?))
        }
        "callTool" => {
            let server: McpServerConfig = sidecar_arg(args, 0)?;
            let tool_name: String = sidecar_arg(args, 1)?;
            let tool_arguments: Value = args.get(2).cloned().unwrap_or_else(|| json!({}));
            let options: McpSidecarOptions = sidecar_arg_or_default(args, 3)?;
            let session = {
                let mut manager = lock_mcp_manager(manager)?;
                manager.session_for(server, &options)?
            };
            let mut session = lock_mcp_session(&session)?;
            session.apply_options(&options);
            session.call_tool(&tool_name, tool_arguments)
        }
        _ => bail!("Unsupported MCP session sidecar method: {method}"),
    }
}

impl McpSidecarManager {
    fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            active_requests: 0,
            max_active_requests: mcp_sidecar_max_active_requests(),
            max_active_observed: 0,
            sidecar_backpressure_rejects: 0,
            last_sidecar_backpressure_at: String::new(),
        }
    }

    fn handle_control(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        match method {
            "closeIdleSessions" => {
                let options: McpSidecarOptions = sidecar_arg_or_default(args, 0)?;
                let closed = self.close_idle(options.max_idle_ms.unwrap_or(10 * 60 * 1000));
                Ok(json!({ "closed": closed, "remaining": self.sessions.len() }))
            }
            "closeAll" => {
                self.close_all();
                Ok(json!({ "ok": true }))
            }
            "stats" => Ok(self.stats()),
            _ => bail!("Unsupported MCP session sidecar method: {method}"),
        }
    }

    fn try_start_sidecar_request(&mut self, method: &str) -> Result<()> {
        if self.active_requests >= self.max_active_requests {
            self.sidecar_backpressure_rejects += 1;
            self.last_sidecar_backpressure_at = now_iso();
            bail!(
                "MCP session sidecar backpressure: {method} rejected because {} request(s) are already active (max {}).",
                self.active_requests,
                self.max_active_requests
            );
        }
        self.active_requests += 1;
        self.max_active_observed = self.max_active_observed.max(self.active_requests);
        Ok(())
    }

    fn finish_sidecar_request(&mut self) {
        self.active_requests = self.active_requests.saturating_sub(1);
    }

    fn session_for(
        &mut self,
        server: McpServerConfig,
        options: &McpSidecarOptions,
    ) -> Result<Arc<Mutex<McpStdioSession>>> {
        let key = mcp_server_key(&server);
        let replace = match self.sessions.get(&key) {
            Some(session) => match session.try_lock() {
                Ok(mut session) => session.is_closed(),
                Err(TryLockError::WouldBlock) => false,
                Err(TryLockError::Poisoned(_)) => true,
            },
            None => true,
        };
        if replace {
            self.sessions.insert(
                key.clone(),
                Arc::new(Mutex::new(McpStdioSession::spawn(server, options)?)),
            );
        }
        self.sessions
            .get(&key)
            .cloned()
            .context("MCP session was not available after spawn")
    }

    fn close_idle(&mut self, max_idle_ms: u64) -> usize {
        let max_idle = Duration::from_millis(max_idle_ms);
        let idle_keys: Vec<String> = self
            .sessions
            .iter()
            .filter_map(|(key, session)| match session.try_lock() {
                Ok(session) if session.last_used.elapsed() >= max_idle => Some(key.clone()),
                _ => None,
            })
            .collect();
        let closed = idle_keys.len();
        for key in idle_keys {
            if let Some(session) = self.sessions.remove(&key) {
                let Ok(mut session) = lock_mcp_session(&session) else {
                    continue;
                };
                session.close();
            }
        }
        closed
    }

    fn close_all(&mut self) {
        for (_, session) in self.sessions.drain() {
            let Ok(mut session) = lock_mcp_session(&session) else {
                continue;
            };
            session.close();
        }
    }

    fn stats(&self) -> Value {
        let items: Vec<Value> = self
            .sessions
            .values()
            .map(|session| match session.try_lock() {
                Ok(session) => session.stats(),
                Err(TryLockError::WouldBlock) => json!({
                    "id": "",
                    "name": "",
                    "closed": false,
                    "busy": true,
                    "pending": 1,
                    "maxPendingRequests": 1,
                    "maxPendingObserved": 1,
                    "timeoutMs": 0,
                    "requests": 0,
                    "responses": 0,
                    "failures": 0,
                    "timeouts": 0,
                    "backpressureRejects": 0,
                    "toolsCached": false,
                    "toolCount": 0,
                    "startedAt": "",
                    "lastUsedAt": "",
                    "lastRequestAt": "",
                    "lastResponseAt": "",
                    "lastFailureAt": "",
                    "lastBackpressureAt": "",
                    "stderr": ""
                }),
                Err(TryLockError::Poisoned(_)) => json!({
                    "id": "",
                    "name": "",
                    "closed": true,
                    "statsUnavailable": true,
                    "pending": 0,
                    "requests": 0,
                    "responses": 0,
                    "failures": 1,
                    "timeouts": 0,
                    "backpressureRejects": 0
                }),
            })
            .collect();
        let total_requests: u64 = items
            .iter()
            .map(|item| item.get("requests").and_then(Value::as_u64).unwrap_or(0))
            .sum();
        let total_responses: u64 = items
            .iter()
            .map(|item| item.get("responses").and_then(Value::as_u64).unwrap_or(0))
            .sum();
        let total_failures: u64 = items
            .iter()
            .map(|item| item.get("failures").and_then(Value::as_u64).unwrap_or(0))
            .sum();
        let total_timeouts: u64 = items
            .iter()
            .map(|item| item.get("timeouts").and_then(Value::as_u64).unwrap_or(0))
            .sum();
        let total_backpressure_rejects: u64 = items
            .iter()
            .map(|item| item.get("backpressureRejects").and_then(Value::as_u64).unwrap_or(0))
            .sum();
        let max_pending_observed = items
            .iter()
            .filter_map(|item| item.get("maxPendingObserved").and_then(Value::as_u64))
            .max()
            .unwrap_or(0);
        json!({
            "sessions": self.sessions.len(),
            "activeSessions": items.iter().filter(|item| item.get("closed").and_then(Value::as_bool) == Some(false)).count(),
            "activeRequests": self.active_requests,
            "maxActiveRequests": self.max_active_requests,
            "maxActiveObserved": self.max_active_observed,
            "sidecarBackpressureRejects": self.sidecar_backpressure_rejects,
            "lastSidecarBackpressureAt": self.last_sidecar_backpressure_at,
            "totalPending": self.active_requests,
            "totalRequests": total_requests,
            "totalResponses": total_responses,
            "totalFailures": total_failures,
            "totalTimeouts": total_timeouts,
            "totalBackpressureRejects": total_backpressure_rejects,
            "maxPendingObserved": max_pending_observed,
            "items": items
        })
    }
}

impl McpStdioSession {
    fn spawn(server: McpServerConfig, options: &McpSidecarOptions) -> Result<Self> {
        if server.command.trim().is_empty() {
            bail!("MCP stdio server command is empty.");
        }

        let mut command = Command::new(&server.command);
        command.args(&server.args);
        if !server.cwd.trim().is_empty() {
            command.current_dir(&server.cwd);
        }
        for (key, value) in &server.env {
            command.env(key, value);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command
            .spawn()
            .with_context(|| format!("Failed to spawn MCP stdio server: {}", server.command))?;
        let stdin = child
            .stdin
            .take()
            .context("MCP stdio server stdin was not piped")?;
        let stdout = child
            .stdout
            .take()
            .context("MCP stdio server stdout was not piped")?;
        let (stdout_tx, stdout_rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                if stdout_tx.send(message).is_err() {
                    break;
                }
            }
        });
        let now = now_iso();
        let timeout_ms = options.timeout_ms.or(options.timeout).unwrap_or(10_000);
        let max_pending_requests = options.max_pending_requests.unwrap_or(1).max(1);

        Ok(Self {
            server,
            child,
            stdin,
            stdout_rx,
            closed: false,
            next_id: 1,
            initialized: None,
            tools: None,
            started_at: now.clone(),
            last_used_at: now,
            last_request_at: String::new(),
            last_response_at: String::new(),
            last_failure_at: String::new(),
            last_backpressure_at: String::new(),
            requests: 0,
            responses: 0,
            failures: 0,
            timeouts: 0,
            backpressure_rejects: 0,
            timeout_ms,
            max_pending_requests,
            max_pending_observed: 0,
            last_used: Instant::now(),
        })
    }

    fn ensure_initialized(&mut self) -> Result<Value> {
        if let Some(value) = &self.initialized {
            return Ok(value.clone());
        }
        let result = self.request(
            "initialize",
            Some(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "vibelink-rust",
                    "version": "0.1.0"
                }
            })),
        )?;
        self.notify("notifications/initialized", None)?;
        self.initialized = Some(result.clone());
        Ok(result)
    }

    fn apply_options(&mut self, options: &McpSidecarOptions) {
        if let Some(timeout_ms) = options.timeout_ms.or(options.timeout) {
            self.timeout_ms = timeout_ms.max(1);
        }
        if let Some(max_pending_requests) = options.max_pending_requests {
            self.max_pending_requests = max_pending_requests.max(1);
        }
    }

    fn list_tools(&mut self) -> Result<Vec<Value>> {
        self.ensure_initialized()?;
        if let Some(tools) = &self.tools {
            let tools = tools.clone();
            self.touch();
            return Ok(tools);
        }
        let result = self.request("tools/list", None)?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.tools = Some(tools.clone());
        Ok(tools)
    }

    fn call_tool(&mut self, name: &str, arguments: Value) -> Result<Value> {
        self.ensure_initialized()?;
        self.request(
            "tools/call",
            Some(json!({
                "name": name,
                "arguments": arguments
            })),
        )
    }

    fn notify(&mut self, method: &str, params: Option<Value>) -> Result<()> {
        if self.closed {
            bail!("MCP stdio session is closed.");
        }
        let message = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        if let Err(error) = writeln!(self.stdin, "{}", message).and_then(|_| self.stdin.flush()) {
            self.mark_failed();
            return Err(error).context("Failed to write MCP stdio notification");
        }
        self.touch();
        Ok(())
    }

    fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value> {
        if self.closed {
            bail!("MCP stdio session is closed.");
        }
        let id = self.next_id;
        self.next_id += 1;
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        if let Err(error) = writeln!(self.stdin, "{}", message).and_then(|_| self.stdin.flush()) {
            self.mark_failed();
            return Err(error).context(format!("Failed to write MCP stdio request: {method}"));
        }
        self.requests += 1;
        self.max_pending_observed = self.max_pending_observed.max(1);
        self.last_request_at = now_iso();
        self.touch();

        loop {
            let message = match self
                .stdout_rx
                .recv_timeout(Duration::from_millis(self.timeout_ms.max(1)))
            {
                Ok(message) => message,
                Err(RecvTimeoutError::Timeout) => {
                    self.timeouts += 1;
                    self.mark_failed();
                    bail!(
                        "MCP stdio request timed out: {method} after {}ms",
                        self.timeout_ms
                    );
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.mark_failed();
                    bail!("MCP stdio session exited before replying to {method}");
                }
            };
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                self.mark_failed();
                bail!(
                    "{}",
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("MCP stdio request failed")
                );
            }
            self.responses += 1;
            self.last_response_at = now_iso();
            self.touch();
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn touch(&mut self) {
        self.last_used = Instant::now();
        self.last_used_at = now_iso();
    }

    fn mark_failed(&mut self) {
        self.failures += 1;
        self.last_failure_at = now_iso();
        self.closed = true;
        let _ = self.child.kill();
    }

    fn is_closed(&mut self) -> bool {
        if self.closed {
            return true;
        }
        match self.child.try_wait() {
            Ok(Some(_)) => {
                self.closed = true;
                true
            }
            Ok(None) => false,
            Err(_) => {
                self.closed = true;
                true
            }
        }
    }

    fn close(&mut self) {
        self.closed = true;
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn stats(&self) -> Value {
        json!({
            "id": if self.server.id.is_empty() { &self.server.name } else { &self.server.id },
            "name": if self.server.name.is_empty() { &self.server.id } else { &self.server.name },
            "closed": self.closed,
            "pending": 0,
            "maxPendingRequests": self.max_pending_requests,
            "maxPendingObserved": self.max_pending_observed,
            "timeoutMs": self.timeout_ms,
            "requests": self.requests,
            "responses": self.responses,
            "failures": self.failures,
            "timeouts": self.timeouts,
            "backpressureRejects": self.backpressure_rejects,
            "toolsCached": self.tools.is_some(),
            "toolCount": self.tools.as_ref().map(Vec::len).unwrap_or(0),
            "startedAt": self.started_at,
            "lastUsedAt": self.last_used_at,
            "lastRequestAt": self.last_request_at,
            "lastResponseAt": self.last_response_at,
            "lastFailureAt": self.last_failure_at,
            "lastBackpressureAt": self.last_backpressure_at,
            "stderr": ""
        })
    }
}

fn list_workspace_tree(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_entries: usize,
) -> Result<WorkspaceTree> {
    let root = root
        .canonicalize()
        .with_context(|| format!("Cannot resolve workspace root {}", root.display()))?;
    let target = safe_workspace_child(&root, dir)?;
    if !target.is_dir() {
        bail!(
            "Workspace tree path must be a directory: {}",
            target.display()
        );
    }

    let mut items = Vec::new();
    let mut signature_parts = Vec::new();
    let mut truncated = false;
    let mut queue = VecDeque::from([(target.clone(), 0usize, gitignore_rules_for_dir(&root))]);
    let max_entries = max_entries.max(1);
    let depth = depth.max(1);

    while let Some((current, current_depth, inherited_rules)) = queue.pop_front() {
        if items.len() >= max_entries {
            truncated = true;
            break;
        }

        let mut ignore_rules = inherited_rules;
        signature_parts.push(metadata_signature_part("dir", &root, &current));
        signature_parts.push(metadata_signature_part(
            "gitignore",
            &root,
            &current.join(".gitignore"),
        ));
        if current != root {
            ignore_rules.extend(gitignore_rules_for_dir(&current));
        }

        let mut children = Vec::new();
        for entry in std::fs::read_dir(&current)
            .with_context(|| format!("Cannot read {}", current.display()))?
        {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = entry.file_type()?;
            if name.starts_with('.') && name != ".env" {
                continue;
            }
            if file_type.is_dir() && IGNORED_WORKSPACE_DIRS.contains(&name.as_str()) {
                continue;
            }
            if ignore_rules.is_ignored(&name, file_type.is_dir()) {
                continue;
            }
            children.push((name, entry.path(), file_type.is_dir()));
        }

        children.sort_by(|a, b| {
            b.2.cmp(&a.2)
                .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
        });

        for (name, full_path, is_dir) in children {
            if items.len() >= max_entries {
                truncated = true;
                break;
            }
            let metadata = std::fs::metadata(&full_path)?;
            let rel = slash_path(full_path.strip_prefix(&root).unwrap_or(&full_path));
            signature_parts.push(metadata_signature_part("entry", &root, &full_path));
            items.push(WorkspaceTreeItem {
                name,
                path: rel,
                kind: if is_dir { "directory" } else { "file" }.to_string(),
                size: metadata.len(),
                updated_at: system_time_iso(metadata.modified().ok()),
            });
            if is_dir && current_depth + 1 < depth {
                queue.push_back((full_path, current_depth + 1, ignore_rules.clone()));
            }
        }
    }

    Ok(WorkspaceTree {
        ok: true,
        dir: slash_path(target.strip_prefix(&root).unwrap_or(Path::new(""))),
        truncated,
        signature: scan_signature(&signature_parts),
        items,
    })
}

fn metadata_signature_part(kind: &str, root: &Path, path: &Path) -> String {
    let rel = slash_path(path.strip_prefix(root).unwrap_or(path));
    match std::fs::metadata(path) {
        Ok(metadata) => {
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            format!(
                "{kind}:{rel}:{}:{}:{modified_ms}",
                if metadata.is_dir() { "d" } else { "f" },
                metadata.len()
            )
        }
        Err(_) => format!("{kind}:{rel}:missing"),
    }
}

fn scan_signature(parts: &[String]) -> String {
    let mut hasher = Fnv64::default();
    for part in parts {
        part.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

#[derive(Default)]
struct Fnv64(u64);

impl Hasher for Fnv64 {
    fn write(&mut self, bytes: &[u8]) {
        if self.0 == 0 {
            self.0 = 0xcbf29ce484222325;
        }
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

#[derive(Clone, Debug, Default)]
struct WorkspaceIgnoreRules {
    rules: Vec<WorkspaceIgnoreRule>,
}

#[derive(Clone, Debug)]
struct WorkspaceIgnoreRule {
    pattern: String,
    directory_only: bool,
    negated: bool,
}

impl WorkspaceIgnoreRules {
    fn extend(&mut self, other: WorkspaceIgnoreRules) {
        self.rules.extend(other.rules);
    }

    fn is_ignored(&self, name: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for rule in &self.rules {
            if rule.directory_only && !is_dir {
                continue;
            }
            if gitignore_basename_matches(&rule.pattern, name) {
                ignored = !rule.negated;
            }
        }
        ignored
    }
}

fn gitignore_rules_for_dir(dir: &Path) -> WorkspaceIgnoreRules {
    let mut rules = WorkspaceIgnoreRules::default();
    let Ok(content) = std::fs::read_to_string(dir.join(".gitignore")) else {
        return rules;
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let negated = trimmed.starts_with('!');
        let body = if negated {
            trimmed[1..].trim()
        } else {
            trimmed
        };
        if body.is_empty() {
            continue;
        }
        let directory_only = body.ends_with('/');
        let pattern = body.trim_start_matches('/').trim_end_matches('/');
        if pattern.is_empty() || pattern.contains('/') {
            continue;
        }
        rules.rules.push(WorkspaceIgnoreRule {
            pattern: pattern.to_string(),
            directory_only,
            negated,
        });
    }

    rules
}

fn gitignore_basename_matches(pattern: &str, name: &str) -> bool {
    if !pattern.contains('*') {
        return pattern == name;
    }
    if pattern == "*" {
        return true;
    }

    let mut remaining = name;
    let mut parts = pattern.split('*').peekable();
    let mut first_part = true;

    while let Some(part) = parts.next() {
        if part.is_empty() {
            first_part = false;
            continue;
        }
        if first_part && !pattern.starts_with('*') {
            let Some(next_remaining) = remaining.strip_prefix(part) else {
                return false;
            };
            remaining = next_remaining;
        } else if parts.peek().is_none() && !pattern.ends_with('*') {
            return remaining.ends_with(part);
        } else {
            let Some(index) = remaining.find(part) else {
                return false;
            };
            remaining = &remaining[index + part.len()..];
        }
        first_part = false;
    }

    pattern.ends_with('*') || remaining.is_empty()
}

fn safe_workspace_child(root: &Path, child: &Path) -> Result<PathBuf> {
    let mut target = PathBuf::from(root);
    for component in child.components() {
        match component {
            std::path::Component::Normal(part) => target.push(part),
            std::path::Component::CurDir => {}
            _ => bail!("Path is outside workspace: {}", child.display()),
        }
    }
    let canonical = target
        .canonicalize()
        .with_context(|| format!("Cannot resolve {}", target.display()))?;
    if !canonical.starts_with(root) {
        bail!("Path is outside workspace: {}", child.display());
    }
    Ok(canonical)
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn system_time_iso(value: Option<std::time::SystemTime>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    let datetime: DateTime<Utc> = value.into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn main() {
    if let Err(error) = run() {
        eprintln!("VibeLink failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command.clone().unwrap_or(Mode::Run) {
        Mode::Run => run_user_entry(&cli),
        Mode::Bridge => run_bridge_role(&cli),
        Mode::Pair => run_pairing_flow(&cli),
        Mode::Doctor => run_doctor(&cli),
        Mode::WorkspaceTree {
            root,
            dir,
            depth,
            max_entries,
        } => run_workspace_tree(&root, &dir, depth, max_entries),
        Mode::McpSessionSidecar => run_mcp_session_sidecar(),
        Mode::EventStoreSidecar { db_path } => run_event_store_sidecar(&db_path),
    }
}

fn run_user_entry(cli: &Cli) -> Result<()> {
    println!("Starting VibeLink bridge on {}:{}", cli.host, cli.port);
    let mut bridge = spawn_bridge_role(cli)?;
    let base_url = local_base_url(cli.port);

    if let Err(error) = wait_for_bridge(&base_url, Duration::from_secs(30)) {
        let _ = bridge.kill();
        return Err(error);
    }

    println!("Bridge is ready: {base_url}");
    let pairing_base_url = pairing_base_url(cli.port);
    println!("Android pairing URL base: {pairing_base_url}");
    print_pairing_qr(&base_url, &pairing_base_url, &cli.device_label)?;
    println!();
    println!("Development mode: keep this process open to keep the supervised bridge running.");
    println!("Next milestone: replace this console surface with a native Windows tray/window.");

    let status = bridge
        .wait()
        .context("Bridge role failed to exit cleanly")?;
    if !status.success() {
        bail!("Bridge role exited with status {status}");
    }
    Ok(())
}

fn run_bridge_role(cli: &Cli) -> Result<()> {
    let root = project_root()?;
    let server = root.join("src").join("server.js");
    if !server.exists() {
        bail!("Cannot find bridge server at {}", server.display());
    }

    let mut command = Command::new("node");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .arg(&server)
        .current_dir(&root)
        .env("MOBILE_AGENT_HOST", &cli.host)
        .env("MOBILE_AGENT_PORT", cli.port.to_string())
        .stdin(Stdio::null());

    let status = command
        .spawn()
        .context("Failed to launch Node bridge. Is node.exe on PATH?")?
        .wait()
        .context("Failed while waiting for Node bridge")?;

    if !status.success() {
        bail!("Node bridge exited with status {status}");
    }
    Ok(())
}

fn run_pairing_flow(cli: &Cli) -> Result<()> {
    let base_url = local_base_url(cli.port);
    wait_for_bridge(&base_url, Duration::from_secs(3))?;
    let pairing_base_url = pairing_base_url(cli.port);
    print_pairing_qr(&base_url, &pairing_base_url, &cli.device_label)
}

fn run_doctor(cli: &Cli) -> Result<()> {
    let base_url = local_base_url(cli.port);
    wait_for_bridge(&base_url, Duration::from_secs(3))?;
    println!("Bridge reachable: {base_url}");
    Ok(())
}

fn spawn_bridge_role(cli: &Cli) -> Result<Child> {
    let exe = env::current_exe().context("Cannot resolve current executable path")?;
    let mut command = Command::new(exe);
    command
        .arg("--host")
        .arg(&cli.host)
        .arg("--port")
        .arg(cli.port.to_string())
        .arg("bridge")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.spawn().context("Failed to start bridge role")
}

fn print_pairing_qr(api_base_url: &str, pairing_base_url: &str, label: &str) -> Result<()> {
    let session = create_pairing_session(api_base_url, label)?;
    let payload = android_pairing_uri(pairing_base_url, &session);
    let code = QrCode::new(payload.as_bytes()).context("Failed to encode QR payload")?;
    let image = code.render::<unicode::Dense1x2>().quiet_zone(true).build();

    println!();
    println!("Android pairing QR");
    println!("Session: {}", session.id);
    println!("Status: {}", session.status);
    println!("Expires: {}", session.expires_at);
    println!("Payload: {payload}");
    println!("{image}");
    Ok(())
}

fn create_pairing_session(base_url: &str, label: &str) -> Result<PairingSession> {
    let endpoint = format!("{}/api/pairing-sessions", base_url.trim_end_matches('/'));
    let body = CreatePairingRequest {
        device_label: label,
        trust_local_launcher: true,
    };
    let response: CreatePairingResponse = ureq::post(&endpoint)
        .set("Content-Type", "application/json")
        .send_json(serde_json::to_value(body)?)
        .with_context(|| format!("Failed to create pairing session at {endpoint}"))?
        .into_json()
        .context("Failed to parse pairing response")?;

    if !response.ok {
        bail!("Bridge rejected pairing session creation");
    }

    response
        .session
        .context("Bridge response did not include a pairing session")
}

fn android_pairing_uri(base_url: &str, session: &PairingSession) -> String {
    format!(
        "vibelink://pair?server={}&session={}&code={}",
        urlencoding::encode(base_url.trim_end_matches('/')),
        urlencoding::encode(&session.id),
        urlencoding::encode(&session.code)
    )
}

fn wait_for_bridge(base_url: &str, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let endpoint = format!("{}/api/status", base_url.trim_end_matches('/'));

    loop {
        match ureq::get(&endpoint).timeout(Duration::from_secs(2)).call() {
            Ok(response) if response.status() == 200 => return Ok(()),
            Ok(response) if response.status() == 401 => return Ok(()),
            Ok(response) => {
                if Instant::now() >= deadline {
                    bail!("Bridge status returned HTTP {}", response.status());
                }
            }
            Err(ureq::Error::Status(401, _)) => return Ok(()),
            Err(error) => {
                if Instant::now() >= deadline {
                    return Err(error).context("Timed out waiting for bridge status");
                }
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
}

fn local_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn pairing_base_url(port: u16) -> String {
    let host = lan_ipv4().unwrap_or_else(|| "127.0.0.1".to_string());
    format!("http://{host}:{port}")
}

fn lan_ipv4() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    let ip = addr.ip().to_string();
    if ip.starts_with("127.") || ip == "0.0.0.0" {
        None
    } else {
        Some(ip)
    }
}
fn project_root() -> Result<PathBuf> {
    if let Ok(root) = env::var("VIBELINK_ROOT") {
        return Ok(PathBuf::from(root));
    }

    let cwd = env::current_dir().context("Cannot read current directory")?;
    if let Some(root) = find_project_root_from(&cwd) {
        return Ok(root);
    }

    let exe = env::current_exe().context("Cannot resolve current executable path")?;
    if let Some(parent) = exe.parent() {
        if let Some(root) = find_project_root_from(parent) {
            return Ok(root);
        }
    }

    bail!("Cannot find VibeLink project root. Set VIBELINK_ROOT to the directory containing src/server.js.")
}

fn find_project_root_from(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|candidate| candidate.join("src").join("server.js").exists())
        .map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn android_pairing_uri_uses_deep_link_and_escapes_server() {
        let session = PairingSession {
            id: "session 1".to_string(),
            code: "ABC123".to_string(),
            status: "pending".to_string(),
            expires_at: "2026-07-07T00:00:00.000Z".to_string(),
        };

        let uri = android_pairing_uri("http://192.168.1.10:8787/", &session);

        assert_eq!(
            uri,
            "vibelink://pair?server=http%3A%2F%2F192.168.1.10%3A8787&session=session%201&code=ABC123"
        );
    }
    #[test]
    fn workspace_tree_lists_directories_first_and_skips_heavy_dirs() {
        let root = env::temp_dir().join(format!("vibelink-workspace-tree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::create_dir_all(root.join("tmp-cache")).unwrap();
        fs::write(root.join(".gitignore"), "tmp-cache/\n").unwrap();
        fs::write(root.join("README.md"), "hello").unwrap();
        fs::write(root.join("src").join("main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("node_modules").join("noise.js"), "ignored").unwrap();
        fs::write(root.join("target").join("noise.txt"), "ignored").unwrap();
        fs::write(root.join("tmp-cache").join("noise.txt"), "ignored").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 1, 20).unwrap();

        let names: Vec<_> = tree.items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, vec!["src", "README.md"]);
        assert_eq!(tree.items[0].kind, "directory");
        assert_eq!(tree.items[1].kind, "file");
        assert!(tree.items[1].updated_at.contains("T"));
        assert!(tree
            .items
            .iter()
            .all(|item| !item.path.starts_with("node_modules")));
        assert!(tree
            .items
            .iter()
            .all(|item| !item.path.starts_with("target")));
        assert!(tree
            .items
            .iter()
            .all(|item| !item.path.starts_with("tmp-cache")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_tree_honors_root_gitignore_file_patterns() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-gitignore-files-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("logs")).unwrap();
        fs::write(root.join(".gitignore"), "*.log\nsecrets.local\nlogs/\n").unwrap();
        fs::write(root.join("README.md"), "hello").unwrap();
        fs::write(root.join("debug.log"), "ignored").unwrap();
        fs::write(root.join("secrets.local"), "ignored").unwrap();
        fs::write(root.join("logs").join("debug.txt"), "ignored").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 1, 20).unwrap();

        let names: Vec<_> = tree.items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, vec!["README.md"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_tree_honors_gitignore_negation_rules() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-gitignore-negation-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(".gitignore"), "*.log\n!keep.log\n").unwrap();
        fs::write(root.join("README.md"), "hello").unwrap();
        fs::write(root.join("debug.log"), "ignored").unwrap();
        fs::write(root.join("keep.log"), "kept").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 1, 20).unwrap();

        let names: Vec<_> = tree.items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, vec!["keep.log", "README.md"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_tree_honors_nested_gitignore_rules() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-nested-gitignore-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src").join("private")).unwrap();
        fs::write(
            root.join("src").join(".gitignore"),
            "generated.tmp\nprivate/\n",
        )
        .unwrap();
        fs::write(root.join("src").join("README.md"), "hello").unwrap();
        fs::write(root.join("src").join("generated.tmp"), "ignored").unwrap();
        fs::write(root.join("src").join("private").join("note.txt"), "ignored").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 2, 20).unwrap();

        let paths: Vec<_> = tree.items.iter().map(|item| item.path.as_str()).collect();
        assert_eq!(paths, vec!["src", "src/README.md"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_tree_marks_truncated_when_max_entries_is_reached() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-truncated-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        fs::write(root.join("c.txt"), "c").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 1, 2).unwrap();

        assert_eq!(tree.items.len(), 2);
        assert!(tree.truncated);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_tree_signature_changes_when_metadata_changes() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-signature-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("README.md"), "hello").unwrap();

        let first = list_workspace_tree(&root, Path::new(""), 1, 20).unwrap();
        fs::write(root.join("README.md"), "hello with more bytes").unwrap();
        let second = list_workspace_tree(&root, Path::new(""), 1, 20).unwrap();

        assert!(!first.signature.is_empty());
        assert_ne!(first.signature, second.signature);

        let _ = fs::remove_dir_all(&root);
    }
}
