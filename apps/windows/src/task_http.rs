use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const MAX_BODY_BYTES: usize = 1024 * 1024;
const DEFAULT_EVENT_LIMIT: i64 = 200;
const MAX_EVENT_LIMIT: i64 = 2000;

#[derive(Clone)]
pub struct TaskRouteConfig {
    pub data_dir: PathBuf,
    metrics: Arc<TaskRouteMetrics>,
}

#[derive(Default)]
struct TaskRouteMetrics {
    attempts: AtomicU64,
    responses: AtomicU64,
    fallbacks: AtomicU64,
}

impl TaskRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            metrics: Arc::new(TaskRouteMetrics::default()),
        }
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.fallbacks.fetch_add(1, Ordering::SeqCst);
    }
}

pub fn task_request_requires_body(request: &ParsedRequest) -> bool {
    request.method == "POST"
        && (request.path() == "/api/tasks" || request.path().starts_with("/api/tasks/"))
}

pub fn route_task_request(
    request: &ParsedRequest,
    body: Option<&[u8]>,
    config: &TaskRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if !is_task_route(request.path()) {
        return Ok(None);
    }
    let auth = authenticate_route_request(request, &config.data_dir)?;
    if auth == RouteAuthentication::Pending {
        return Ok(None);
    }
    config.metrics.attempts.fetch_add(1, Ordering::SeqCst);
    match auth {
        RouteAuthentication::HostDenied => {
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")))
        }
        RouteAuthentication::Unauthorized => {
            return Ok(Some(HttpRouteResponse::error(401, "Unauthorized")))
        }
        RouteAuthentication::Device(_) => {}
        RouteAuthentication::Pending => unreachable!(),
    }

    let mut connection = open_task_db(&config.data_dir)?;
    let response = if request.path() == "/api/thread-state" && request.method == "GET" {
        HttpRouteResponse::json(200, thread_state(&connection)?)
    } else if request.path() == "/api/tasks" && request.method == "GET" {
        HttpRouteResponse::json(200, json!({ "items": list_tasks(&connection)? }))
    } else if request.path() == "/api/tasks" && request.method == "POST" {
        let payload = read_json_body(body)?;
        if request.query_parameter("dryRun").as_deref() == Some("1") {
            HttpRouteResponse::json(
                200,
                json!({
                    "dryRun": true,
                    "agent": payload.get("agent").and_then(Value::as_str).unwrap_or("codex"),
                    "prompt": payload.get("prompt").and_then(Value::as_str).unwrap_or(""),
                    "approvalRequired": false,
                    "wouldPersist": true
                }),
            )
        } else {
            let task = create_queued_task(&mut connection, &payload)?;
            HttpRouteResponse::json(
                201,
                json!({
                    "id": task["id"],
                    "status": task["status"],
                    "task": task
                }),
            )
        }
    } else if let Some((task_id, "events/catch-up")) = task_path_parts(request.path()) {
        let limit = bounded_limit(request.query_parameter("limit"));
        let after = request
            .query_parameter("after")
            .or_else(|| request.header("last-event-id").map(str::to_string))
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let events = list_task_events(&connection, &task_id, after, limit + 1)?;
        let has_more = events.len() as i64 > limit;
        let items = events.into_iter().take(limit as usize).collect::<Vec<_>>();
        let next_cursor = items
            .last()
            .and_then(|item| item.get("cursor"))
            .and_then(Value::as_i64)
            .unwrap_or(after);
        HttpRouteResponse::json(
            200,
            json!({
                "items": items,
                "nextCursor": next_cursor,
                "hasMore": has_more,
                "limit": limit
            }),
        )
    } else if let Some((task_id, "changes")) = task_path_parts(request.path()) {
        let Some(task) = task_by_id(&connection, &task_id)? else {
            return Ok(Some(HttpRouteResponse::error(404, "Task not found.")));
        };
        HttpRouteResponse::json(200, task_changes(&connection, &task)?)
    } else if let Some((task_id, "input")) = task_path_parts(request.path()) {
        let payload = read_json_body(body)?;
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if text.is_empty() {
            HttpRouteResponse::error(400, "Input is required.")
        } else if append_task_input(&connection, &task_id, text)? {
            HttpRouteResponse::json(200, json!({ "ok": true, "queued": true }))
        } else {
            HttpRouteResponse::error(404, "Task not found.")
        }
    } else if let Some((task_id, "stop")) = task_path_parts(request.path()) {
        if stop_queued_task_projection(&connection, &task_id)? {
            HttpRouteResponse::json(200, json!({ "ok": true, "stopped": true }))
        } else {
            return Ok(None);
        }
    } else if let Some((job_id, action)) = scheduler_path_parts(request.path()) {
        if request.method != "POST" {
            return Ok(None);
        }
        let job = match action {
            "retry" => retry_scheduler_job(&connection, &job_id)?,
            "cancel" => cancel_queued_scheduler_job(&connection, &job_id)?,
            _ => return Ok(None),
        };
        let Some(job) = job else {
            return Ok(None);
        };
        HttpRouteResponse::json(200, json!({ "ok": true, "job": job }))
    } else if request.path() == "/api/task-scheduler" && request.method == "GET" {
        HttpRouteResponse::json(200, scheduler_status(&connection)?)
    } else if request.path() == "/api/search/saved" && request.method == "GET" {
        let Some(items) = list_saved_searches(&connection)? else {
            return Ok(None);
        };
        HttpRouteResponse::json(200, json!({ "items": items }))
    } else if request.path() == "/api/search/history" && request.method == "GET" {
        let limit = request
            .query_parameter("limit")
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(50)
            .clamp(1, 200);
        let Some(items) = list_search_history(&connection, limit)? else {
            return Ok(None);
        };
        HttpRouteResponse::json(200, json!({ "items": items }))
    } else if request.path() == "/api/search/index" && request.method == "GET" {
        let Some(status) = search_index_status(&connection)? else {
            return Ok(None);
        };
        HttpRouteResponse::json(200, status)
    } else {
        return Ok(None);
    };
    config.metrics.responses.fetch_add(1, Ordering::SeqCst);
    Ok(Some(response))
}

pub fn stream_task_events_request(
    request: &ParsedRequest,
    config: &TaskRouteConfig,
    client: &mut TcpStream,
) -> Result<Option<()>> {
    let Some((task_id, "events")) = task_path_parts(request.path()) else {
        return Ok(None);
    };
    if request.method != "GET" {
        return Ok(None);
    }
    let auth = authenticate_route_request(request, &config.data_dir)?;
    if auth == RouteAuthentication::Pending {
        return Ok(None);
    }
    config.metrics.attempts.fetch_add(1, Ordering::SeqCst);
    match auth {
        RouteAuthentication::HostDenied => {
            HttpRouteResponse::error(403, "Host is not allowed.").write_to(client)?;
            return Ok(Some(()));
        }
        RouteAuthentication::Unauthorized => {
            HttpRouteResponse::error(401, "Unauthorized").write_to(client)?;
            return Ok(Some(()));
        }
        RouteAuthentication::Device(_) => {}
        RouteAuthentication::Pending => unreachable!(),
    }
    let connection = open_task_db(&config.data_dir)?;
    if task_by_id(&connection, &task_id)?.is_none() {
        HttpRouteResponse::error(404, "Task not found.").write_to(client)?;
        return Ok(Some(()));
    }
    let mut after = request
        .query_parameter("after")
        .or_else(|| request.header("last-event-id").map(str::to_string))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    client.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache, no-transform\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\nX-VibeLink-Control-Plane: rust\r\n\r\n")?;
    client.flush()?;
    let started = Instant::now();
    let mut heartbeat = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        let events = list_task_events(&connection, &task_id, after, 500)?;
        for event in events {
            let cursor = event.get("cursor").and_then(Value::as_i64).unwrap_or(after);
            let data = serde_json::to_string(&event).context("Cannot encode task event")?;
            write!(client, "id: {cursor}\nevent: task\ndata: {data}\n\n")?;
            after = cursor;
            heartbeat = Instant::now();
        }
        if heartbeat.elapsed() >= Duration::from_secs(25) {
            client.write_all(b"event: ping\ndata: {}\n\n")?;
            heartbeat = Instant::now();
        }
        client.flush()?;
        thread::sleep(Duration::from_millis(250));
    }
    config.metrics.responses.fetch_add(1, Ordering::SeqCst);
    Ok(Some(()))
}

fn is_task_route(path: &str) -> bool {
    path == "/api/tasks"
        || path == "/api/thread-state"
        || path == "/api/task-scheduler"
        || path == "/api/search/saved"
        || path == "/api/search/history"
        || path == "/api/search/index"
        || path.starts_with("/api/tasks/")
        || path.starts_with("/api/task-scheduler/")
}

fn task_path_parts(path: &str) -> Option<(String, &str)> {
    let rest = path.strip_prefix("/api/tasks/")?;
    let (id, action) = rest.split_once('/')?;
    Some((id.to_string(), action))
}

fn scheduler_path_parts(path: &str) -> Option<(String, &str)> {
    let rest = path.strip_prefix("/api/task-scheduler/")?;
    let (id, action) = rest.split_once('/')?;
    Some((id.to_string(), action))
}

fn read_json_body(body: Option<&[u8]>) -> Result<Value> {
    let body = body.ok_or_else(|| anyhow::anyhow!("Task request body is required"))?;
    if body.len() > MAX_BODY_BYTES {
        return Ok(json!({ "error": "Request body is too large." }));
    }
    serde_json::from_slice(body).context("Invalid task request JSON.")
}

fn open_task_db(data_dir: &Path) -> Result<Connection> {
    let db_path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", db_path.display()))?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, agent TEXT NOT NULL, title TEXT NOT NULL, cwd TEXT,
          workspace_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, exit_code INTEGER, session_id TEXT,
          command_label TEXT, log_path TEXT, meta_json TEXT
        );
        CREATE TABLE IF NOT EXISTS task_events (
          cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          event_id TEXT NOT NULL, event_type TEXT, event_at TEXT NOT NULL,
          text TEXT, payload_json TEXT, event_json TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE(task_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_events_task_cursor ON task_events(task_id, cursor);
        CREATE TABLE IF NOT EXISTS task_queue (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          next_attempt_at TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          last_error TEXT,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_task_queue_ready
          ON task_queue(status, next_attempt_at, priority DESC, created_at);",
    )?;
    Ok(connection)
}

fn create_queued_task(connection: &mut Connection, payload: &Value) -> Result<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let queue_id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let agent = payload
        .get("agent")
        .and_then(Value::as_str)
        .unwrap_or("codex")
        .trim();
    let agent = if agent.is_empty() { "codex" } else { agent };
    let prompt = payload.get("prompt").and_then(Value::as_str).unwrap_or("");
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(prompt)
        .chars()
        .take(96)
        .collect::<String>();
    let title = if title.trim().is_empty() {
        format!("{agent} task")
    } else {
        title
    };
    let cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or("");
    let workspace_id = payload
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let session_id = payload
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let launch_payload = task_launch_payload(payload);
    let meta = json!({
        "launchMode": payload.get("mode").and_then(Value::as_str).unwrap_or("new"),
        "sessionOrigin": "vibelink-cli",
        "rustOwner": "task-http",
        "pendingWorkerStart": true,
        "queueId": queue_id,
        "launchPayload": launch_payload
    });
    let priority = payload.get("priority").and_then(Value::as_i64).unwrap_or(0);
    let max_attempts = payload
        .get("maxAttempts")
        .and_then(Value::as_i64)
        .unwrap_or(3)
        .max(1);
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT INTO tasks (id,agent,title,cwd,workspace_id,status,created_at,updated_at,exit_code,session_id,command_label,log_path,meta_json)
         VALUES (?1,?2,?3,?4,?5,'queued',?6,?6,NULL,?7,?8,'',?9)",
        params![id, agent, title, cwd, workspace_id, now, session_id, agent, meta.to_string()],
    )?;
    transaction.execute(
        "INSERT INTO task_queue (
           id,task_id,status,priority,attempts,max_attempts,next_attempt_at,payload_json,created_at,updated_at
         ) VALUES (?1,?2,'queued',?3,0,?4,?5,?6,?5,?5)",
        params![queue_id, id, priority, max_attempts, now, launch_payload.to_string()],
    )?;
    insert_task_event(
        &transaction,
        &id,
        "system",
        &format!("Starting {agent} in {cwd}"),
        json!({ "agent": agent, "launchMode": meta["launchMode"] }),
    )?;
    insert_task_event(
        &transaction,
        &id,
        "security",
        "Security policy: rust durable projection",
        json!({ "owner": "rust" }),
    )?;
    if !prompt.trim().is_empty() {
        insert_task_event(&transaction, &id, "stdin", prompt, json!({}))?;
    }
    insert_task_event(
        &transaction,
        &id,
        "system",
        "Task added to the persistent execution queue.",
        json!({ "queueId": queue_id }),
    )?;
    transaction.commit()?;
    task_by_id(connection, &id)?.ok_or_else(|| anyhow::anyhow!("Created task is missing."))
}

fn task_launch_payload(payload: &Value) -> Value {
    let mut launch_payload = serde_json::Map::new();
    for key in [
        "agent",
        "title",
        "prompt",
        "cwd",
        "model",
        "mode",
        "sessionId",
        "reasoningEffort",
        "permissionMode",
        "security",
        "template",
        "name",
    ] {
        if let Some(value) = payload.get(key) {
            launch_payload.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(launch_payload)
}

fn append_task_input(connection: &Connection, task_id: &str, text: &str) -> Result<bool> {
    if task_by_id(connection, task_id)?.is_none() {
        return Ok(false);
    }
    insert_task_event(
        connection,
        task_id,
        "stdin",
        text,
        json!({ "queued": true }),
    )?;
    insert_task_event(
        connection,
        task_id,
        "system",
        "Input queued for the next resume turn.",
        json!({}),
    )?;
    connection.execute(
        "UPDATE tasks SET updated_at = ?1 WHERE id = ?2",
        params![now_iso(), task_id],
    )?;
    Ok(true)
}

fn stop_queued_task_projection(connection: &Connection, task_id: &str) -> Result<bool> {
    let Some(task) = task_by_id(connection, task_id)? else {
        return Ok(false);
    };
    if task["status"].as_str() != Some("queued") {
        return Ok(false);
    }
    let transaction = connection.unchecked_transaction()?;
    let changed = transaction.execute(
        "UPDATE tasks SET status = 'cancelled', updated_at = ?1 WHERE id = ?2",
        params![now_iso(), task_id],
    )?;
    if changed == 0 {
        return Ok(false);
    }
    transaction.execute(
        "UPDATE task_queue SET status = 'cancelled', updated_at = ?1, completed_at = ?1, next_attempt_at = NULL
         WHERE task_id = ?2 AND status = 'queued'",
        params![now_iso(), task_id],
    )?;
    insert_task_event(
        &transaction,
        task_id,
        "system",
        "Task stop requested.",
        json!({ "stopped": true }),
    )?;
    transaction.commit()?;
    Ok(true)
}

fn insert_task_event(
    connection: &Connection,
    task_id: &str,
    event_type: &str,
    text: &str,
    payload: Value,
) -> Result<i64> {
    let event_id = uuid::Uuid::new_v4().to_string();
    let at = now_iso();
    let event = json!({
        "id": event_id,
        "type": event_type,
        "at": at,
        "text": text,
        "payload": payload
    });
    connection.execute(
        "INSERT OR IGNORE INTO task_events (task_id,event_id,event_type,event_at,text,payload_json,event_json,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?4)",
        params![task_id, event_id, event_type, at, text, payload.to_string(), event.to_string()],
    )?;
    Ok(connection.last_insert_rowid())
}

fn list_tasks(connection: &Connection) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT id,agent,title,cwd,workspace_id,status,created_at,updated_at,exit_code,session_id,command_label,log_path,meta_json
         FROM tasks ORDER BY updated_at DESC, created_at DESC LIMIT 500",
    )?;
    let rows = statement
        .query_map([], task_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into);
    rows
}

fn task_by_id(connection: &Connection, id: &str) -> Result<Option<Value>> {
    connection
        .query_row(
            "SELECT id,agent,title,cwd,workspace_id,status,created_at,updated_at,exit_code,session_id,command_label,log_path,meta_json
             FROM tasks WHERE id = ?1",
            params![id],
            task_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn task_changes(connection: &Connection, task: &Value) -> Result<Value> {
    let task_id = task["id"].as_str().unwrap_or_default();
    let workspace_id = task["workspaceId"].as_str().unwrap_or_default();
    let cwd = task["cwd"].as_str().unwrap_or_default();
    if workspace_id.is_empty() || cwd.is_empty() {
        return Ok(json!({
            "ok": false, "error": "Task has no workspace directory.",
            "files": [], "fileCount": 0, "lineCount": 0, "diff": "", "taskId": task_id
        }));
    }
    let workspace = connection
        .query_row(
            "SELECT id,path,title FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "path": row.get::<_, String>(1)?,
                    "title": row.get::<_, String>(2)?
                }))
            },
        )
        .optional()?;
    let Some(workspace) = workspace else {
        return Ok(json!({
            "ok": false, "error": "Task workspace is not registered.",
            "files": [], "fileCount": 0, "lineCount": 0, "diff": "", "taskId": task_id
        }));
    };
    let workspace_path = workspace["path"].as_str().unwrap_or_default();
    if !same_canonical_path(cwd, workspace_path) {
        return Ok(json!({
            "ok": false, "error": "Task directory does not match its workspace.",
            "files": [], "fileCount": 0, "lineCount": 0, "diff": "", "taskId": task_id
        }));
    }
    let status = git_output(cwd, &["status", "--porcelain=v1", "-b"])?;
    let first_diff = git_output(
        cwd,
        &["diff", "HEAD", "--stat", "--patch", "--find-renames"],
    )?;
    let first_stderr = String::from_utf8_lossy(&first_diff.stderr);
    let diff = if first_diff.status.success()
        || !["bad revision", "ambiguous argument", "unknown revision"]
            .iter()
            .any(|needle| first_stderr.contains(needle))
    {
        first_diff
    } else {
        git_output(cwd, &["diff", "--stat", "--patch", "--find-renames"])?
    };
    let status_stdout = String::from_utf8_lossy(&status.stdout).to_string();
    let diff_stdout = String::from_utf8_lossy(&diff.stdout).to_string();
    let stderr = [
        String::from_utf8_lossy(&status.stderr),
        String::from_utf8_lossy(&diff.stderr),
    ]
    .into_iter()
    .filter(|value| !value.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let files = parse_git_status_files(&status_stdout);
    let branch = status_stdout
        .lines()
        .find_map(|line| line.strip_prefix("## "))
        .unwrap_or_default();
    Ok(json!({
        "ok": status.status.success() && diff.status.success(),
        "branch": branch,
        "files": files,
        "changedCount": files.len(),
        "fileCount": files.len(),
        "lineCount": diff_stdout.lines().filter(|line| {
            (line.starts_with('+') && !line.starts_with("+++"))
                || (line.starts_with('-') && !line.starts_with("---"))
        }).count(),
        "diff": diff_stdout,
        "statusStdout": status_stdout,
        "stdout": String::from_utf8_lossy(&diff.stdout),
        "stderr": stderr,
        "exitCode": diff.status.code().unwrap_or(1),
        "untrackedPreviewErrors": [],
        "taskId": task_id,
        "workspace": workspace,
        "cwd": cwd
    }))
}

fn thread_state(connection: &Connection) -> Result<Value> {
    let mut items = serde_json::Map::new();
    let mut statement = connection.prepare(
        "SELECT key,title,group_name,pinned,archived,meta_json,revision,updated_at
         FROM threads ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            row.get::<_, i64>(3)? != 0,
            row.get::<_, i64>(4)? != 0,
            row.get::<_, Option<String>>(5)?
                .unwrap_or_else(|| "{}".to_string()),
            row.get::<_, i64>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    for row in rows {
        let (key, title, group, pinned, archived, meta_json, revision, updated_at) = row?;
        let mut item = serde_json::from_str::<Value>(&meta_json).unwrap_or(json!({}));
        item["key"] = json!(key.clone());
        item["title"] = json!(title);
        item["group"] = json!(group);
        item["pinned"] = json!(pinned);
        item["archived"] = json!(archived);
        item["tags"] = item["tags"].as_array().cloned().unwrap_or_default().into();
        item["favorite"] = json!(item["favorite"].as_bool().unwrap_or(false));
        item["revision"] = json!(revision);
        item["updatedAt"] = json!(updated_at);
        items.insert(key, item);
    }
    let mut forks = Vec::new();
    let mut statement = connection.prepare(
        "SELECT id,source_key,source_id,provider,title,cwd,group_name,pinned,archived,created_at,updated_at
         FROM thread_forks ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "sourceKey": row.get::<_, String>(1)?,
            "sourceId": row.get::<_, String>(2)?,
            "provider": row.get::<_, String>(3)?,
            "title": row.get::<_, String>(4)?,
            "cwd": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            "group": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            "pinned": row.get::<_, i64>(7)? != 0,
            "archived": row.get::<_, i64>(8)? != 0,
            "createdAt": row.get::<_, String>(9)?,
            "updatedAt": row.get::<_, String>(10)?
        }))
    })?;
    for row in rows {
        forks.push(row?);
    }
    Ok(json!({ "version": 2, "items": items, "forks": forks }))
}

fn git_output(cwd: &str, args: &[&str]) -> Result<std::process::Output> {
    Command::new("git")
        .args(["-C", cwd])
        .args(args)
        .output()
        .with_context(|| format!("Failed to run Git in {cwd}"))
}

fn same_canonical_path(left: &str, right: &str) -> bool {
    let left = Path::new(left).canonicalize().ok();
    let right = Path::new(right).canonicalize().ok();
    left.zip(right).is_some_and(|(left, right)| left == right)
}

fn parse_git_status_files(status: &str) -> Vec<Value> {
    status
        .lines()
        .filter(|line| !line.starts_with("##") && line.len() > 3)
        .map(|line| {
            let status = line[..2].trim();
            let path = line[3..].split(" -> ").last().unwrap_or_default();
            json!({
                "status": if status == "??" { "A" } else { status },
                "path": path,
                "oldPath": path,
                "additions": 0,
                "deletions": 0
            })
        })
        .collect()
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let meta_json = row
        .get::<_, Option<String>>(12)?
        .unwrap_or_else(|| "{}".to_string());
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "agent": row.get::<_, String>(1)?,
        "title": row.get::<_, String>(2)?,
        "cwd": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        "workspaceId": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        "status": row.get::<_, String>(5)?,
        "createdAt": row.get::<_, String>(6)?,
        "updatedAt": row.get::<_, String>(7)?,
        "exitCode": row.get::<_, Option<i64>>(8)?,
        "sessionId": row.get::<_, Option<String>>(9)?.unwrap_or_default(),
        "commandLabel": row.get::<_, Option<String>>(10)?.unwrap_or_default(),
        "logPath": row.get::<_, Option<String>>(11)?.unwrap_or_default(),
        "meta": serde_json::from_str::<Value>(&meta_json).unwrap_or(json!({}))
    }))
}

fn list_task_events(
    connection: &Connection,
    task_id: &str,
    after: i64,
    limit: i64,
) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT cursor,event_json FROM task_events WHERE task_id = ?1 AND cursor > ?2 ORDER BY cursor ASC LIMIT ?3",
    )?;
    let rows = statement
        .query_map(params![task_id, after, limit], |row| {
            let cursor = row.get::<_, i64>(0)?;
            let mut event =
                serde_json::from_str::<Value>(&row.get::<_, String>(1)?).unwrap_or(json!({}));
            event["cursor"] = json!(cursor);
            Ok(event)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into);
    rows
}

fn scheduler_status(connection: &Connection) -> Result<Value> {
    let mut counts = serde_json::Map::new();
    for status in ["queued", "running", "completed", "failed", "cancelled"] {
        let count = connection.query_row(
            "SELECT COUNT(*) FROM task_queue WHERE status = ?1",
            params![status],
            |row| row.get::<_, i64>(0),
        )?;
        counts.insert(status.to_string(), json!(count));
    }
    Ok(json!({
        "concurrency": 2,
        "active": counts["running"].as_i64().unwrap_or(0),
        "counts": counts,
        "items": list_scheduler_jobs(connection)?
    }))
}

fn table_exists(connection: &Connection, name: &str) -> Result<bool> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |_| Ok(true),
        )
        .optional()
        .map(|value| value.unwrap_or(false))
        .map_err(Into::into)
}

fn list_saved_searches(connection: &Connection) -> Result<Option<Vec<Value>>> {
    if !table_exists(connection, "saved_searches")? {
        return Ok(None);
    }
    let mut statement = connection.prepare(
        "SELECT id,name,query,scope,session_origin,tag,favorite,sort,sort_order,
                created_at,updated_at,last_used_at
         FROM saved_searches ORDER BY updated_at DESC,name COLLATE NOCASE ASC",
    )?;
    let items = statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "query": row.get::<_, String>(2)?,
                "scope": row.get::<_, String>(3)?,
                "sessionOrigin": row.get::<_, String>(4)?,
                "tag": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                "favorite": row.get::<_, i64>(6)? != 0,
                "sort": row.get::<_, String>(7)?,
                "order": row.get::<_, String>(8)?,
                "createdAt": row.get::<_, String>(9)?,
                "updatedAt": row.get::<_, String>(10)?,
                "lastUsedAt": row.get::<_, Option<String>>(11)?.unwrap_or_default()
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(items))
}

fn list_search_history(connection: &Connection, limit: i64) -> Result<Option<Vec<Value>>> {
    if !table_exists(connection, "search_history")? {
        return Ok(None);
    }
    let mut statement = connection.prepare(
        "SELECT id,query,scope,session_origin,tag,favorite,sort,sort_order,
                result_count,use_count,searched_at,device_id
         FROM search_history ORDER BY searched_at DESC LIMIT ?1",
    )?;
    let items = statement
        .query_map(params![limit], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "query": row.get::<_, String>(1)?,
                "scope": row.get::<_, String>(2)?,
                "sessionOrigin": row.get::<_, String>(3)?,
                "tag": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                "favorite": row.get::<_, i64>(5)? != 0,
                "sort": row.get::<_, String>(6)?,
                "order": row.get::<_, String>(7)?,
                "resultCount": row.get::<_, i64>(8)?,
                "useCount": row.get::<_, i64>(9)?,
                "searchedAt": row.get::<_, String>(10)?,
                "deviceId": row.get::<_, Option<String>>(11)?.unwrap_or_default()
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(items))
}

fn search_index_status(connection: &Connection) -> Result<Option<Value>> {
    if !table_exists(connection, "workspace_search_files")?
        || !table_exists(connection, "content_search_documents")?
    {
        return Ok(None);
    }
    let indexed_files = connection.query_row(
        "SELECT COUNT(*) FROM workspace_search_files WHERE indexable = 1",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    let indexed_workspaces = connection.query_row(
        "SELECT COUNT(DISTINCT workspace_id) FROM workspace_search_files",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    let mut content = serde_json::Map::new();
    let mut statement =
        connection.prepare("SELECT kind,COUNT(*) FROM content_search_documents GROUP BY kind")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (kind, count) = row?;
        content.insert(
            match kind.as_str() {
                "history" => "sessions",
                "task" => "tasks",
                "message" => "messages",
                _ => continue,
            }
            .to_string(),
            json!(count),
        );
    }
    for kind in ["sessions", "tasks", "messages"] {
        content.entry(kind.to_string()).or_insert(json!(0));
    }
    Ok(Some(json!({
        "indexedFiles": indexed_files,
        "indexedWorkspaces": indexed_workspaces,
        "sessions": content["sessions"],
        "tasks": content["tasks"],
        "messages": content["messages"],
        "content": content,
        "ready": true,
        "running": false,
        "started": false,
        "watchers": 0,
        "pendingWorkspaces": 0,
        "owner": "rust-sqlite-projection"
    })))
}

fn list_scheduler_jobs(connection: &Connection) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT id,task_id,status,priority,attempts,max_attempts,next_attempt_at,created_at,updated_at,
                started_at,completed_at,last_error,payload_json
         FROM task_queue
         ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                  priority DESC,created_at DESC LIMIT 200",
    )?;
    let jobs = statement
        .query_map([], scheduler_job_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into);
    jobs
}

fn scheduler_job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let payload_json = row.get::<_, String>(12)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "taskId": row.get::<_, String>(1)?,
        "status": row.get::<_, String>(2)?,
        "priority": row.get::<_, i64>(3)?,
        "attempts": row.get::<_, i64>(4)?,
        "maxAttempts": row.get::<_, i64>(5)?,
        "nextAttemptAt": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        "createdAt": row.get::<_, String>(7)?,
        "updatedAt": row.get::<_, String>(8)?,
        "startedAt": row.get::<_, Option<String>>(9)?.unwrap_or_default(),
        "completedAt": row.get::<_, Option<String>>(10)?.unwrap_or_default(),
        "lastError": row.get::<_, Option<String>>(11)?.unwrap_or_default(),
        "payload": serde_json::from_str::<Value>(&payload_json).unwrap_or(json!({}))
    }))
}

fn scheduler_job_by_id(connection: &Connection, id: &str) -> Result<Option<Value>> {
    connection
        .query_row(
            "SELECT id,task_id,status,priority,attempts,max_attempts,next_attempt_at,created_at,updated_at,
                    started_at,completed_at,last_error,payload_json
             FROM task_queue WHERE id = ?1 OR task_id = ?1",
            params![id],
            scheduler_job_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn retry_scheduler_job(connection: &Connection, id: &str) -> Result<Option<Value>> {
    let at = now_iso();
    connection.execute(
        "UPDATE task_queue SET status = 'queued', attempts = 0, next_attempt_at = ?1,
                completed_at = NULL, started_at = NULL, updated_at = ?1, last_error = ''
         WHERE (id = ?2 OR task_id = ?2) AND status IN ('failed','cancelled')",
        params![at, id],
    )?;
    let job = scheduler_job_by_id(connection, id)?;
    Ok(job.filter(|item| item["status"].as_str() == Some("queued")))
}

fn cancel_queued_scheduler_job(connection: &Connection, id: &str) -> Result<Option<Value>> {
    let at = now_iso();
    connection.execute(
        "UPDATE task_queue SET status = 'cancelled', updated_at = ?1, completed_at = ?1, next_attempt_at = NULL
         WHERE (id = ?2 OR task_id = ?2) AND status = 'queued'",
        params![at, id],
    )?;
    let job = scheduler_job_by_id(connection, id)?;
    Ok(job.filter(|item| item["status"].as_str() == Some("cancelled")))
}

fn bounded_limit(value: Option<String>) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(DEFAULT_EVENT_LIMIT)
        .clamp(1, MAX_EVENT_LIMIT)
}

fn now_iso() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::params;
    use std::fs;

    fn fixture() -> (PathBuf, TaskRouteConfig) {
        let dir = std::env::temp_dir().join(format!(
            "vibelink-task-http-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("settings.json"),
            r#"{"pairingToken":"pair","hostAllowlist":[]}"#,
        )
        .unwrap();
        let db = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE devices(id TEXT PRIMARY KEY,label TEXT,token_hash TEXT UNIQUE,created_at TEXT,last_seen_at TEXT,revoked_at TEXT,expires_at TEXT,rotated_at TEXT,meta_json TEXT);",
        )
        .unwrap();
        db.execute(
            "INSERT INTO devices VALUES ('d','Device',?1,'now',NULL,NULL,NULL,NULL,NULL)",
            params![hash_token("token")],
        )
        .unwrap();
        (dir.clone(), TaskRouteConfig::new(dir))
    }

    #[test]
    fn creates_lists_and_replays_task_events_with_stable_identity() {
        let (dir, config) = fixture();
        let create = parse_request(
            b"POST /api/tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        let created = route_task_request(
            &create,
            Some(br#"{"agent":"codex","prompt":"hello task","cwd":"C:/repo"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(created.status, 201);
        let id = created.body["id"].as_str().unwrap().to_string();
        assert_eq!(created.body["task"]["status"], "queued");
        let queue = Connection::open(dir.join("mobile-agent.sqlite"))
            .unwrap()
            .query_row(
                "SELECT task_id,status,payload_json FROM task_queue WHERE task_id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(queue.0, id);
        assert_eq!(queue.1, "queued");
        assert_eq!(
            serde_json::from_str::<Value>(&queue.2).unwrap()["prompt"],
            "hello task"
        );

        let list = parse_request(
            b"GET /api/tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n",
        )
        .unwrap();
        let listed = route_task_request(&list, None, &config).unwrap().unwrap();
        assert!(listed.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["id"] == id));

        let catch_up = parse_request(
            format!("GET /api/tasks/{id}/events/catch-up?after=0&limit=10 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let events = route_task_request(&catch_up, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(events.status, 200);
        assert!(events.body["items"].as_array().unwrap().len() >= 3);
        let first_cursor = events.body["items"][0]["cursor"].as_i64().unwrap();

        let replay_after_first = parse_request(
            format!("GET /api/tasks/{id}/events/catch-up?after={first_cursor}&limit=10 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let replayed = route_task_request(&replay_after_first, None, &config)
            .unwrap()
            .unwrap();
        assert!(replayed.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["cursor"].as_i64().unwrap() > first_cursor));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn queues_input_and_stop_without_changing_task_identity() {
        let (dir, config) = fixture();
        let create = parse_request(
            b"POST /api/tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        let created = route_task_request(&create, Some(br#"{"prompt":"phase three"}"#), &config)
            .unwrap()
            .unwrap();
        let id = created.body["id"].as_str().unwrap().to_string();
        let input = parse_request(
            format!("POST /api/tasks/{id}/input HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n").as_bytes(),
        )
        .unwrap();
        assert_eq!(
            route_task_request(&input, Some(br#"{"text":"resume"}"#), &config)
                .unwrap()
                .unwrap()
                .body["queued"],
            true
        );
        let stop = parse_request(
            format!("POST /api/tasks/{id}/stop HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 0\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let stopped = route_task_request(&stop, Some(b"{}"), &config)
            .unwrap()
            .unwrap();
        assert_eq!(stopped.body["stopped"], true);
        let listed = list_tasks(&open_task_db(&dir).unwrap()).unwrap();
        assert_eq!(listed[0]["id"], id);
        assert_eq!(listed[0]["status"], "cancelled");
        let queue_status = Connection::open(dir.join("mobile-agent.sqlite"))
            .unwrap()
            .query_row(
                "SELECT status FROM task_queue WHERE task_id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(queue_status, "cancelled");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn exposes_and_retries_durable_scheduler_jobs() {
        let (dir, config) = fixture();
        let create = parse_request(
            b"POST /api/tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        let created = route_task_request(&create, Some(br#"{"prompt":"retry me"}"#), &config)
            .unwrap()
            .unwrap();
        let id = created.body["id"].as_str().unwrap();
        let connection = open_task_db(&dir).unwrap();
        connection
            .execute(
                "UPDATE task_queue SET status = 'failed', attempts = 3, completed_at = ?1 WHERE task_id = ?2",
                params![now_iso(), id],
            )
            .unwrap();

        let scheduler = parse_request(
            b"GET /api/task-scheduler HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n",
        )
        .unwrap();
        let status = route_task_request(&scheduler, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(status.body["counts"]["failed"], 1);
        assert_eq!(status.body["items"][0]["taskId"], id);

        let retry = parse_request(
            format!("POST /api/task-scheduler/{id}/retry HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 0\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let retried = route_task_request(&retry, Some(b"{}"), &config)
            .unwrap()
            .unwrap();
        assert_eq!(retried.status, 200);
        assert_eq!(retried.body["job"]["status"], "queued");
        assert_eq!(retried.body["job"]["attempts"], 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_task_changes_only_from_the_registered_workspace() {
        let (dir, config) = fixture();
        let repo = dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let initialized = Command::new("git")
            .args(["init", "-q"])
            .current_dir(&repo)
            .status()
            .unwrap();
        assert!(initialized.success());
        fs::write(repo.join("untracked.txt"), "phase three\n").unwrap();
        let connection = open_task_db(&dir).unwrap();
        connection.execute_batch("CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT NOT NULL,title TEXT NOT NULL);").unwrap();
        connection
            .execute(
                "INSERT INTO workspaces(id,path,title) VALUES ('workspace-1',?1,'Repo')",
                params![repo.to_string_lossy()],
            )
            .unwrap();
        let create = parse_request(
            b"POST /api/tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n",
        ).unwrap();
        let created = route_task_request(
            &create,
            Some(
                format!(
                    r#"{{"prompt":"inspect","workspaceId":"workspace-1","cwd":"{}"}}"#,
                    repo.to_string_lossy().replace('\\', "\\\\")
                )
                .as_bytes(),
            ),
            &config,
        )
        .unwrap()
        .unwrap();
        let id = created.body["id"].as_str().unwrap();
        let changes = parse_request(
            format!("GET /api/tasks/{id}/changes HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").as_bytes(),
        ).unwrap();
        let response = route_task_request(&changes, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["workspace"]["id"], "workspace-1");
        assert!(response.body["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "untracked.txt"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_thread_metadata_from_the_durable_projection() {
        let (dir, config) = fixture();
        let connection = open_task_db(&dir).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (
               key TEXT PRIMARY KEY,title TEXT,group_name TEXT,pinned INTEGER,archived INTEGER,
               meta_json TEXT,revision INTEGER,updated_at TEXT
             );
             CREATE TABLE thread_forks (
               id TEXT PRIMARY KEY,source_key TEXT,source_id TEXT,provider TEXT,title TEXT,cwd TEXT,
               group_name TEXT,pinned INTEGER,archived INTEGER,created_at TEXT,updated_at TEXT
             );",
            )
            .unwrap();
        connection.execute(
            "INSERT INTO threads VALUES ('history:codex:session-1','Thread','Work',1,0,?1,4,'2026-07-23T00:00:00.000Z')",
            params![r#"{"tags":["release"],"favorite":true}"#],
        ).unwrap();
        let request = parse_request(
            b"GET /api/thread-state HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n",
        ).unwrap();
        let response = route_task_request(&request, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["version"], 2);
        assert_eq!(
            response.body["items"]["history:codex:session-1"]["favorite"],
            true
        );
        assert_eq!(
            response.body["items"]["history:codex:session-1"]["tags"][0],
            "release"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn serves_persisted_search_metadata_without_node_runtime() {
        let (dir, config) = fixture();
        let connection = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        connection.execute_batch(
            "CREATE TABLE saved_searches (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL, scope TEXT NOT NULL,
               session_origin TEXT NOT NULL, tag TEXT, favorite INTEGER NOT NULL,
               sort TEXT NOT NULL, sort_order TEXT NOT NULL, created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL, last_used_at TEXT
             );
             CREATE TABLE search_history (
               id TEXT PRIMARY KEY, signature TEXT NOT NULL, query TEXT NOT NULL, scope TEXT NOT NULL,
               session_origin TEXT NOT NULL, tag TEXT, favorite INTEGER NOT NULL,
               sort TEXT NOT NULL, sort_order TEXT NOT NULL, result_count INTEGER NOT NULL,
               use_count INTEGER NOT NULL, searched_at TEXT NOT NULL, device_id TEXT
             );
             CREATE TABLE workspace_search_files (
               rowid INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, path TEXT NOT NULL,
               size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, indexable INTEGER NOT NULL,
               indexed_at TEXT NOT NULL
             );
             CREATE TABLE content_search_documents (
               rowid INTEGER PRIMARY KEY, source_key TEXT NOT NULL, event_cursor INTEGER NOT NULL,
               kind TEXT NOT NULL, item_id TEXT NOT NULL, provider TEXT, title TEXT NOT NULL,
               content TEXT NOT NULL, turn_id TEXT, updated_at TEXT
             );",
        ).unwrap();
        connection.execute(
            "INSERT INTO saved_searches VALUES ('saved-1','Release','rust migration','files','vibelink-cli','release',1,'title','asc','2026-07-23T00:00:00.000Z','2026-07-23T00:00:00.000Z',NULL)",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO search_history VALUES ('history-1','sig','rust migration','files','vibelink-cli','release',1,'title','asc',3,2,'2026-07-23T00:00:00.000Z','d')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO workspace_search_files VALUES (1,'workspace-1','src/main.rs',12,1,1,'2026-07-23T00:00:00.000Z')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO content_search_documents VALUES (1,'history:codex:one',1,'history','one','codex','One','body','turn','2026-07-23T00:00:00.000Z')",
            [],
        ).unwrap();
        let saved = parse_request(b"GET /api/search/saved HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let saved_response = route_task_request(&saved, None, &config).unwrap().unwrap();
        assert_eq!(saved_response.body["items"][0]["name"], "Release");
        assert_eq!(
            saved_response.body["items"][0]["sessionOrigin"],
            "vibelink-cli"
        );
        let history = parse_request(b"GET /api/search/history?limit=1 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let history_response = route_task_request(&history, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(history_response.body["items"][0]["resultCount"], 3);
        assert_eq!(history_response.body["items"][0]["useCount"], 2);
        let index = parse_request(b"GET /api/search/index HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let index_response = route_task_request(&index, None, &config).unwrap().unwrap();
        assert_eq!(index_response.body["indexedFiles"], 1);
        assert_eq!(index_response.body["content"]["sessions"], 1);
        let _ = fs::remove_dir_all(dir);
    }
}
