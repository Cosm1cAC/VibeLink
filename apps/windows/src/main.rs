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
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
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
    sessions: HashMap<String, McpStdioSession>,
}

struct EventStoreSidecar {
    db: Connection,
    started_at: String,
    requests: u64,
    responses: u64,
    failures: u64,
    last_request_at: String,
    last_response_at: String,
    last_failure_at: String,
    last_error: String,
}

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
    let mut stdout = io::stdout();
    let mut manager = McpSidecarManager {
        sessions: HashMap::new(),
    };

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
            manager.close_all();
            write_sidecar_result(&mut stdout, &request.id, json!({ "ok": true }))?;
            break;
        }

        match manager.handle(&request.method, &request.args) {
            Ok(result) => write_sidecar_result(&mut stdout, &request.id, result)?,
            Err(error) => write_sidecar_error(&mut stdout, &request.id, &format!("{error:#}"))?,
        }
    }

    manager.close_all();
    Ok(())
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

        sidecar.record_request();
        if request.method == "__close" {
            sidecar.record_response();
            write_sidecar_result(&mut stdout, &request.id, Value::Bool(true))?;
            break;
        }

        match sidecar.handle(&request.method, &request.args) {
            Ok(result) => {
                sidecar.record_response();
                write_sidecar_result(&mut stdout, &request.id, result)?;
            }
            Err(error) => {
                sidecar.record_failure(&format!("{error:#}"));
                write_sidecar_error(&mut stdout, &request.id, &format!("{error:#}"))?;
            }
        }
    }

    Ok(())
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

impl EventStoreSidecar {
    fn open(db_path: &Path) -> Result<Self> {
        let db = Connection::open(db_path).with_context(|| {
            format!("Failed to open event store database: {}", db_path.display())
        })?;
        db.busy_timeout(Duration::from_millis(5000))?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
        )?;
        Ok(Self {
            db,
            started_at: now_iso(),
            requests: 0,
            responses: 0,
            failures: 0,
            last_request_at: String::new(),
            last_response_at: String::new(),
            last_failure_at: String::new(),
            last_error: String::new(),
        })
    }

    fn record_request(&mut self) {
        self.requests += 1;
        self.last_request_at = now_iso();
    }

    fn record_response(&mut self) {
        self.responses += 1;
        self.last_response_at = now_iso();
    }

    fn record_failure(&mut self, message: &str) {
        self.failures += 1;
        self.last_failure_at = now_iso();
        self.last_error = message.to_string();
    }

    fn handle(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        match method {
            "__health" => Ok(json!({
                "ok": true,
                "implementation": "rust",
                "protocolVersion": 1,
                "supportedMethods": [
                    "insertTaskEvent",
                    "insertTaskEvents",
                    "listTaskEvents",
                    "getTaskEventCount",
                    "insertToolEvent",
                    "insertToolEvents",
                    "listToolEvents",
                    "getToolEventStats",
                    "pruneToolEvents",
                    "insertLiveCallEvent",
                    "insertLiveCallEvents",
                    "listLiveCallEvents",
                    "pruneLiveCallEvents",
                    "listUnifiedEvents",
                    "replayWindow"
                ],
                "controlMethods": ["__health", "stats", "__close"],
                "schemaReady": self.schema_ready()?,
                "startedAt": self.started_at
            })),
            "stats" => Ok(json!({
                "implementation": "rust",
                "protocolVersion": 1,
                "startedAt": self.started_at,
                "pending": 0,
                "requests": self.requests,
                "responses": self.responses,
                "failures": self.failures,
                "lastRequestAt": self.last_request_at,
                "lastResponseAt": self.last_response_at,
                "lastFailureAt": self.last_failure_at,
                "lastError": self.last_error
            })),
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
            "listUnifiedEvents" => {
                let options: EventStoreUnifiedOptions = sidecar_arg_or_default(args, 0)?;
                Ok(Value::Array(self.list_unified_events(&options)?))
            }
            "replayWindow" => {
                let options: EventStoreUnifiedOptions = sidecar_arg_or_default(args, 0)?;
                Ok(self.replay_window(&options)?)
            }
            "getToolEventStats" => Ok(self.get_tool_event_stats()?),
            "pruneToolEvents" => Ok(json!({
                "cutoff": "",
                "keepLatest": 0,
                "maxPrunableCursor": 0,
                "prunable": 0,
                "deleted": 0,
                "dryRun": true,
                "stats": self.get_tool_event_stats()?
            })),
            "pruneLiveCallEvents" => Ok(Value::Null),
            _ => bail!("Unsupported event store sidecar method: {method}"),
        }
    }

    fn schema_ready(&self) -> Result<bool> {
        for table in [
            "task_events",
            "tool_runs",
            "tool_events",
            "live_calls",
            "live_call_events",
        ] {
            let exists: Option<i64> = self
                .db
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                    params![table],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn insert_task_event(&self, task_id: &str, event: &Value) -> Result<Option<i64>> {
        let current = now_iso();
        let event_at = event_string_or(event, "at", &current);
        let event_id = event_string_or(event, "id", &format!("{task_id}:{event_at}:rust"));
        let event_kind = event_string_or(event, "kind", &classify_task_event_kind(event));
        let turn_id = event_string(event, "turnId");
        let block_id = event_string(event, "blockId");
        let mut event_json = event_object(event);
        set_json_string(&mut event_json, "id", event_id.clone());
        set_json_string(&mut event_json, "at", event_at.clone());
        set_json_string(&mut event_json, "kind", event_kind.clone());
        set_json_string(&mut event_json, "turnId", turn_id.clone());
        set_json_string(&mut event_json, "blockId", block_id.clone());

        let inserted = self.db.execute(
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
                payload_json(event)?,
                serde_json::to_string(&event_json)?,
                current,
                event_kind,
                turn_id,
                block_id
            ],
        )?;
        if inserted > 0 {
            return Ok(Some(self.db.last_insert_rowid()));
        }
        self.cursor_for("task_events", "task_id", task_id, &event_id)
    }

    fn insert_task_events(&mut self, task_id: &str, events: &[Value]) -> Result<Vec<Option<i64>>> {
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

    fn list_task_events(
        &self,
        task_id: &str,
        options: &EventStoreListTaskOptions,
    ) -> Result<Vec<Value>> {
        let mut statement = self.db.prepare(
            "SELECT cursor, event_json FROM task_events WHERE task_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?",
        )?;
        let rows = statement.query_map(
            params![
                task_id,
                options.after.unwrap_or(0),
                event_limit(options.limit, 500, 5000)
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )?;
        rows.map(|row| event_json_with_cursor(row?)).collect()
    }

    fn get_task_event_count(&self, task_id: &str) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT COUNT(*) FROM task_events WHERE task_id = ?",
            params![task_id],
            |row| row.get::<_, i64>(0),
        )?)
    }

    fn tool_run_owner(&self, tool_run_id: &str) -> Result<Option<(String, String)>> {
        self.db
            .query_row(
                "SELECT task_id, workspace_id FROM tool_runs WHERE id = ?",
                params![tool_run_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    ))
                },
            )
            .optional()
            .map_err(Into::into)
    }

    fn insert_tool_event(&self, tool_run_id: &str, event: &Value) -> Result<Option<i64>> {
        let Some((task_id, workspace_id)) = self.tool_run_owner(tool_run_id)? else {
            return Ok(None);
        };
        self.insert_tool_event_with_owner(tool_run_id, event, &task_id, &workspace_id)
    }

    fn insert_tool_event_with_owner(
        &self,
        tool_run_id: &str,
        event: &Value,
        default_task_id: &str,
        default_workspace_id: &str,
    ) -> Result<Option<i64>> {
        let current = now_iso();
        let event_at = event_string_or(event, "at", &current);
        let event_id = event_string_or(event, "id", &format!("{tool_run_id}:{event_at}:rust"));
        let task_id = event_string_or(event, "taskId", default_task_id);
        let workspace_id = event_string_or(event, "workspaceId", default_workspace_id);
        let mut event_json = event_object(event);
        set_json_string(&mut event_json, "id", event_id.clone());
        set_json_string(&mut event_json, "at", event_at.clone());
        set_json_string(&mut event_json, "toolRunId", tool_run_id.to_string());
        set_json_string(&mut event_json, "taskId", task_id.clone());
        set_json_string(&mut event_json, "workspaceId", workspace_id.clone());

        let inserted = self.db.execute(
            "INSERT OR IGNORE INTO tool_events (
                    tool_run_id, task_id, workspace_id, event_id, event_type, event_at,
                    text, payload_json, event_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                tool_run_id,
                task_id,
                workspace_id,
                event_id,
                event_string_or(event, "type", "tool.event"),
                event_at,
                event_string(event, "text"),
                payload_json(event)?,
                serde_json::to_string(&event_json)?,
                current
            ],
        )?;
        if inserted > 0 {
            return Ok(Some(self.db.last_insert_rowid()));
        }
        self.cursor_for("tool_events", "tool_run_id", tool_run_id, &event_id)
    }

    fn insert_tool_events(
        &mut self,
        tool_run_id: &str,
        events: &[Value],
    ) -> Result<Vec<Option<i64>>> {
        let Some((task_id, workspace_id)) = self.tool_run_owner(tool_run_id)? else {
            return Ok(vec![None; events.len()]);
        };
        let mut cursors = Vec::with_capacity(events.len());
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        for event in events {
            match self.insert_tool_event_with_owner(tool_run_id, event, &task_id, &workspace_id) {
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
        let tool_run_id = clean_option(&options.tool_run_id);
        let workspace_id = clean_option(&options.workspace_id);
        let task_id = clean_option(&options.task_id);
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
                event_limit(options.limit, 500, 5000)
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )?;
        rows.map(|row| event_json_with_cursor(row?)).collect()
    }

    fn live_call_exists(&self, session_id: &str) -> Result<bool> {
        let exists: Option<String> = self
            .db
            .query_row(
                "SELECT id FROM live_calls WHERE id = ?",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(exists.is_some())
    }

    fn insert_live_call_event(&self, session_id: &str, event: &Value) -> Result<Option<i64>> {
        if !self.live_call_exists(session_id)? {
            return Ok(None);
        }
        self.insert_live_call_event_existing(session_id, event)
    }

    fn insert_live_call_event_existing(
        &self,
        session_id: &str,
        event: &Value,
    ) -> Result<Option<i64>> {
        let current = now_iso();
        let event_at = event_string_or(event, "at", &current);
        let event_id = event_string_or(event, "id", &format!("{session_id}:{event_at}:rust"));
        let mut event_json = event_object(event);
        set_json_string(&mut event_json, "id", event_id.clone());
        set_json_string(&mut event_json, "at", event_at.clone());
        set_json_string(&mut event_json, "sessionId", session_id.to_string());

        let inserted = self.db.execute(
            "INSERT OR IGNORE INTO live_call_events (
                    session_id, event_id, event_type, event_at, text, payload_json, event_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                session_id,
                event_id,
                event_string_or(event, "type", "live_call.event"),
                event_at,
                event_string(event, "text"),
                payload_json(event)?,
                serde_json::to_string(&event_json)?,
                current
            ],
        )?;
        if inserted > 0 {
            return Ok(Some(self.db.last_insert_rowid()));
        }
        self.cursor_for("live_call_events", "session_id", session_id, &event_id)
    }

    fn insert_live_call_events(
        &mut self,
        session_id: &str,
        events: &[Value],
    ) -> Result<Vec<Option<i64>>> {
        if !self.live_call_exists(session_id)? {
            return Ok(vec![None; events.len()]);
        }
        let mut cursors = Vec::with_capacity(events.len());
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        for event in events {
            match self.insert_live_call_event_existing(session_id, event) {
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
        let session_id = clean_option(&options.session_id);
        if session_id.is_empty() {
            return Ok(Vec::new());
        }
        let mut statement = self.db.prepare(
            "SELECT cursor, event_json FROM live_call_events
             WHERE session_id = ? AND cursor > ?
             ORDER BY cursor ASC LIMIT ?",
        )?;
        let rows = statement.query_map(
            params![
                session_id,
                options.after.unwrap_or(0),
                event_limit(options.limit, 500, 2000)
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )?;
        rows.map(|row| event_json_with_cursor(row?)).collect()
    }

    fn list_unified_events(&self, options: &EventStoreUnifiedOptions) -> Result<Vec<Value>> {
        let limit = event_limit(options.limit, 200, 2000);
        let after = options.after.unwrap_or(0);
        let task_id = clean_option(&options.task_id);
        let session_id = clean_option(&options.live_call_session_id);
        let tool_run_id = clean_option(&options.tool_run_id);
        let mut items = Vec::new();

        if options.live_call_session_id.is_none() && options.tool_run_id.is_none() {
            let mut statement = self.db.prepare(
                "SELECT cursor, task_id, event_id, event_type, event_kind, turn_id, block_id, event_at, text
                 FROM task_events WHERE (? = '' OR task_id = ?) AND cursor > ? ORDER BY cursor ASC LIMIT ?",
            )?;
            let rows =
                statement.query_map(params![task_id, task_id, after, limit], unified_task_row)?;
            for row in rows {
                items.push(row?);
            }
        }

        if options.live_call_session_id.is_none() && items.len() < limit as usize {
            let remaining = limit - items.len() as i64;
            let mut statement = self.db.prepare(
                "SELECT cursor, task_id, tool_run_id, event_id, event_type, event_at, text
                 FROM tool_events
                 WHERE (? = '' OR task_id = ?) AND (? = '' OR tool_run_id = ?) AND cursor > ?
                 ORDER BY cursor ASC LIMIT ?",
            )?;
            let rows = statement.query_map(
                params![task_id, task_id, tool_run_id, tool_run_id, after, remaining],
                unified_tool_row,
            )?;
            for row in rows {
                items.push(row?);
            }
        }

        if options.task_id.is_none()
            && options.tool_run_id.is_none()
            && items.len() < limit as usize
        {
            let remaining = limit - items.len() as i64;
            let mut statement = self.db.prepare(
                "SELECT cursor, session_id, event_id, event_type, event_at, text
                 FROM live_call_events WHERE (? = '' OR session_id = ?) AND cursor > ? ORDER BY cursor ASC LIMIT ?",
            )?;
            let rows = statement.query_map(
                params![session_id, session_id, after, remaining],
                unified_live_row,
            )?;
            for row in rows {
                items.push(row?);
            }
        }

        items.sort_by_key(|item| item.get("cursor").and_then(Value::as_i64).unwrap_or(0));
        items.truncate(limit as usize);
        Ok(items)
    }

    fn replay_window(&self, options: &EventStoreUnifiedOptions) -> Result<Value> {
        let limit = event_limit(options.limit, 200, 2000);
        let options = EventStoreUnifiedOptions {
            task_id: options.task_id.clone(),
            live_call_session_id: options.live_call_session_id.clone(),
            tool_run_id: options.tool_run_id.clone(),
            after: options.after.map(|value| value / 10),
            limit: Some(limit + 1),
        };
        let mut items = self.list_unified_events(&options)?;
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        for item in &mut items {
            if let Some(object) = item.as_object_mut() {
                let raw_cursor = object.get("cursor").and_then(Value::as_i64).unwrap_or(0);
                let source_rank = match object.get("kind").and_then(Value::as_str).unwrap_or("") {
                    "tool" => 2,
                    "live_call" => 3,
                    _ => 1,
                };
                object.insert("rawCursor".to_string(), json!(raw_cursor));
                object.insert("cursor".to_string(), json!((raw_cursor * 10) + source_rank));
            }
        }
        let next_cursor = items
            .last()
            .and_then(|item| item.get("cursor").and_then(Value::as_i64))
            .unwrap_or(options.after.unwrap_or(0));
        Ok(
            json!({ "items": items, "nextCursor": next_cursor, "hasMore": has_more, "limit": limit }),
        )
    }

    fn get_tool_event_stats(&self) -> Result<Value> {
        let row = self.db.query_row(
            "SELECT COUNT(*), MIN(cursor), MAX(cursor), MIN(event_at), MAX(event_at) FROM tool_events",
            [],
            |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            )),
        )?;
        Ok(json!({
            "count": row.0,
            "minCursor": row.1.unwrap_or(0),
            "maxCursor": row.2.unwrap_or(0),
            "oldestAt": row.3.unwrap_or_default(),
            "newestAt": row.4.unwrap_or_default()
        }))
    }

    fn cursor_for(
        &self,
        table: &str,
        owner_col: &str,
        owner_id: &str,
        event_id: &str,
    ) -> Result<Option<i64>> {
        let sql = format!("SELECT cursor FROM {table} WHERE {owner_col} = ? AND event_id = ?");
        Ok(self
            .db
            .query_row(&sql, params![owner_id, event_id], |row| {
                row.get::<_, i64>(0)
            })
            .optional()?)
    }
}

fn event_limit(value: Option<i64>, default_limit: i64, max_limit: i64) -> i64 {
    match value {
        Some(value) if value > 0 => value.min(max_limit.max(1)),
        _ => default_limit.max(1).min(max_limit.max(1)),
    }
}

fn clean_option(value: &Option<String>) -> String {
    value
        .as_deref()
        .unwrap_or("")
        .trim()
        .chars()
        .take(160)
        .collect()
}

fn event_string(event: &Value, key: &str) -> String {
    event
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn event_string_or(event: &Value, key: &str, fallback: &str) -> String {
    match event.get(key).and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => fallback.to_string(),
    }
}

fn event_object(event: &Value) -> Value {
    if event.is_object() {
        event.clone()
    } else {
        json!({})
    }
}

fn set_json_string(value: &mut Value, key: &str, text: String) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.to_string(), Value::String(text));
    }
}

fn payload_json(event: &Value) -> Result<String> {
    Ok(serde_json::to_string(
        event.get("payload").unwrap_or(&Value::Null),
    )?)
}

fn classify_task_event_kind(event: &Value) -> String {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "user_message" | "user" | "attachment" => "user",
        "assistant_message" | "assistant" => "assistant",
        "system" => "system",
        "error" => "error",
        "summarization" => "summary",
        "stderr" | "stdout" => "output",
        _ if event_type.starts_with("live_call.") => "live_call",
        _ if event_type.starts_with("approval.") => "approval",
        _ if event_type.starts_with("tool.") => "tool",
        _ => "system",
    }
    .to_string()
}

fn event_json_with_cursor((cursor, event_json): (i64, String)) -> Result<Value> {
    let mut value = serde_json::from_str::<Value>(&event_json).unwrap_or_else(|_| json!({}));
    if !value.is_object() {
        value = json!({});
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("cursor".to_string(), json!(cursor));
    }
    Ok(value)
}

fn unified_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "cursor": row.get::<_, i64>(0)?,
        "taskId": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        "eventId": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        "type": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        "kind": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        "turnId": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        "blockId": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        "at": row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        "text": row.get::<_, Option<String>>(8)?.unwrap_or_default(),
        "sessionId": "",
        "toolRunId": ""
    }))
}

fn unified_tool_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "cursor": row.get::<_, i64>(0)?,
        "taskId": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        "toolRunId": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        "eventId": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        "type": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        "kind": "tool",
        "at": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        "text": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        "sessionId": "",
        "turnId": "",
        "blockId": ""
    }))
}

fn unified_live_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "cursor": row.get::<_, i64>(0)?,
        "sessionId": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        "eventId": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        "type": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        "kind": "live_call",
        "at": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        "text": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        "taskId": "",
        "toolRunId": "",
        "turnId": "",
        "blockId": ""
    }))
}

impl McpSidecarManager {
    fn handle(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        match method {
            "probeStdioServer" => {
                let server: McpServerConfig = sidecar_arg(args, 0)?;
                let options: McpSidecarOptions = sidecar_arg_or_default(args, 1)?;
                let session = self.session_for(server, &options)?;
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
                let session = self.session_for(server, &options)?;
                Ok(Value::Array(session.list_tools()?))
            }
            "callTool" => {
                let server: McpServerConfig = sidecar_arg(args, 0)?;
                let tool_name: String = sidecar_arg(args, 1)?;
                let tool_arguments: Value = args.get(2).cloned().unwrap_or_else(|| json!({}));
                let options: McpSidecarOptions = sidecar_arg_or_default(args, 3)?;
                let session = self.session_for(server, &options)?;
                session.call_tool(&tool_name, tool_arguments)
            }
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

    fn session_for(
        &mut self,
        server: McpServerConfig,
        options: &McpSidecarOptions,
    ) -> Result<&mut McpStdioSession> {
        let key = mcp_server_key(&server);
        let replace = self
            .sessions
            .get_mut(&key)
            .map(|session| session.is_closed())
            .unwrap_or(true);
        if replace {
            self.sessions
                .insert(key.clone(), McpStdioSession::spawn(server, options)?);
        }
        let session = self
            .sessions
            .get_mut(&key)
            .context("MCP session was not available after spawn")?;
        session.apply_options(options);
        Ok(session)
    }

    fn close_idle(&mut self, max_idle_ms: u64) -> usize {
        let max_idle = Duration::from_millis(max_idle_ms);
        let idle_keys: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| session.last_used.elapsed() >= max_idle)
            .map(|(key, _)| key.clone())
            .collect();
        let closed = idle_keys.len();
        for key in idle_keys {
            if let Some(mut session) = self.sessions.remove(&key) {
                session.close();
            }
        }
        closed
    }

    fn close_all(&mut self) {
        for (_, mut session) in self.sessions.drain() {
            session.close();
        }
    }

    fn stats(&self) -> Value {
        let items: Vec<Value> = self.sessions.values().map(McpStdioSession::stats).collect();
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
            .map(|item| {
                item.get("backpressureRejects")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            })
            .sum();
        let max_pending_observed = items
            .iter()
            .filter_map(|item| item.get("maxPendingObserved").and_then(Value::as_u64))
            .max()
            .unwrap_or(0);
        json!({
            "sessions": self.sessions.len(),
            "activeSessions": items.iter().filter(|item| item.get("closed").and_then(Value::as_bool) == Some(false)).count(),
            "totalPending": 0,
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
    let mut queue = VecDeque::from([(
        target.clone(),
        0usize,
        gitignore_rules_for_dir(&root, &root),
    )]);
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
            ignore_rules.extend(gitignore_rules_for_dir(&root, &current));
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
            let full_path = entry.path();
            let rel = slash_path(full_path.strip_prefix(&root).unwrap_or(&full_path));
            if ignore_rules.is_ignored(&name, &rel, file_type.is_dir()) {
                continue;
            }
            children.push((name, full_path, file_type.is_dir()));
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
    match_path: bool,
    directory_only: bool,
    negated: bool,
}

impl WorkspaceIgnoreRules {
    fn extend(&mut self, other: WorkspaceIgnoreRules) {
        self.rules.extend(other.rules);
    }

    fn is_ignored(&self, name: &str, rel_path: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for rule in &self.rules {
            if rule.directory_only && !is_dir {
                continue;
            }
            let matches = if rule.match_path {
                gitignore_path_matches(&rule.pattern, rel_path)
            } else {
                gitignore_basename_matches(&rule.pattern, name)
            };
            if matches {
                ignored = !rule.negated;
            }
        }
        ignored
    }
}

fn gitignore_rules_for_dir(root: &Path, dir: &Path) -> WorkspaceIgnoreRules {
    let mut rules = WorkspaceIgnoreRules::default();
    let Ok(content) = std::fs::read_to_string(dir.join(".gitignore")) else {
        return rules;
    };
    let base = slash_path(dir.strip_prefix(root).unwrap_or(Path::new("")));

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
        let anchored = body.starts_with('/');
        let pattern = body.trim_start_matches('/').trim_end_matches('/');
        if pattern.is_empty() {
            continue;
        }
        let match_path = anchored || pattern.contains('/');
        let pattern = if match_path && !base.is_empty() {
            format!("{base}/{pattern}")
        } else {
            pattern.to_string()
        };
        rules.rules.push(WorkspaceIgnoreRule {
            pattern,
            match_path,
            directory_only,
            negated,
        });
    }

    rules
}

fn gitignore_path_matches(pattern: &str, path: &str) -> bool {
    let pattern_parts: Vec<_> = pattern.split('/').collect();
    let path_parts: Vec<_> = path.split('/').collect();
    if pattern_parts.len() != path_parts.len() {
        return false;
    }
    pattern_parts
        .iter()
        .zip(path_parts.iter())
        .all(|(pattern_part, path_part)| gitignore_basename_matches(pattern_part, path_part))
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
    fn workspace_tree_honors_gitignore_path_patterns() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-gitignore-paths-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src").join("generated")).unwrap();
        fs::write(
            root.join(".gitignore"),
            "src/generated/*.tmp\n!src/generated/keep.tmp\n",
        )
        .unwrap();
        fs::write(root.join("src").join("app.rs"), "fn main() {}").unwrap();
        fs::write(
            root.join("src").join("generated").join("noise.tmp"),
            "ignored",
        )
        .unwrap();
        fs::write(root.join("src").join("generated").join("keep.tmp"), "kept").unwrap();
        fs::write(root.join("src").join("generated").join("note.txt"), "kept").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 3, 20).unwrap();

        let paths: Vec<_> = tree.items.iter().map(|item| item.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "src",
                "src/generated",
                "src/app.rs",
                "src/generated/keep.tmp",
                "src/generated/note.txt",
            ]
        );

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
