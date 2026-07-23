use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
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
    (request.method == "POST"
        && (request.path() == "/api/tasks"
            || request.path().starts_with("/api/tasks/")
            || request.path() == "/api/search/saved"))
        || (request.method == "PATCH" && request.path().starts_with("/api/search/saved/"))
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
    } else if request.path() == "/api/search/saved" && request.method == "POST" {
        let payload = read_json_body(body)?;
        match create_saved_search(&connection, &payload)? {
            Some(item) => HttpRouteResponse::json(201, item),
            None => HttpRouteResponse::error(400, "Saved search query is required."),
        }
    } else if let Some(id) = request.path().strip_prefix("/api/search/saved/") {
        match request.method.as_str() {
            "GET" => match saved_search_by_id(&connection, id)? {
                Some(item) => HttpRouteResponse::json(200, item),
                None => HttpRouteResponse::error(404, "Saved search not found."),
            },
            "PATCH" => {
                let payload = read_json_body(body)?;
                match update_saved_search(&connection, id, &payload)? {
                    Some(item) => HttpRouteResponse::json(200, item),
                    None => HttpRouteResponse::error(404, "Saved search not found."),
                }
            }
            "DELETE" => {
                let deleted =
                    connection.execute("DELETE FROM saved_searches WHERE id = ?1", params![id])?;
                if deleted == 0 {
                    HttpRouteResponse::error(404, "Saved search not found.")
                } else {
                    HttpRouteResponse::json(200, json!({ "ok": true, "id": id }))
                }
            }
            _ => return Ok(None),
        }
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
    } else if request.path() == "/api/search/history" && request.method == "DELETE" {
        let deleted = connection.execute("DELETE FROM search_history", [])?;
        HttpRouteResponse::json(200, json!({ "ok": true, "deleted": deleted }))
    } else if let Some(id) = request.path().strip_prefix("/api/search/history/") {
        if request.method != "DELETE" {
            return Ok(None);
        }
        let deleted =
            connection.execute("DELETE FROM search_history WHERE id = ?1", params![id])?;
        if deleted == 0 {
            HttpRouteResponse::error(404, "Search history item not found.")
        } else {
            HttpRouteResponse::json(200, json!({ "ok": true, "id": id }))
        }
    } else if request.path() == "/api/search/index" && request.method == "GET" {
        let Some(status) = search_index_status(&connection)? else {
            return Ok(None);
        };
        HttpRouteResponse::json(200, status)
    } else if request.path() == "/api/search/index/refresh" && request.method == "POST" {
        let result = refresh_search_index(&connection)?;
        HttpRouteResponse::json(
            200,
            json!({
                "ok": true,
                "result": result,
                "index": search_index_status(&connection)?.unwrap_or(json!({}))
            }),
        )
    } else if request.path() == "/api/search" && request.method == "GET" {
        let Some(result) = search_projection(&connection, request)? else {
            return Ok(None);
        };
        HttpRouteResponse::json(200, result)
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
        || path == "/api/search/index/refresh"
        || path == "/api/search"
        || path.starts_with("/api/search/saved/")
        || path.starts_with("/api/search/history/")
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
          ON task_queue(status, next_attempt_at, priority DESC, created_at);
        CREATE TABLE IF NOT EXISTS saved_searches (
          id TEXT PRIMARY KEY,name TEXT NOT NULL,query TEXT NOT NULL,scope TEXT NOT NULL,
          session_origin TEXT NOT NULL DEFAULT 'all',tag TEXT,favorite INTEGER NOT NULL DEFAULT 0,
          sort TEXT NOT NULL DEFAULT 'relevance',sort_order TEXT NOT NULL DEFAULT 'desc',
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_used_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_saved_searches_updated
          ON saved_searches(updated_at DESC);
        CREATE TABLE IF NOT EXISTS search_history (
          id TEXT PRIMARY KEY,signature TEXT NOT NULL UNIQUE,query TEXT NOT NULL,scope TEXT NOT NULL,
          session_origin TEXT NOT NULL DEFAULT 'all',tag TEXT,favorite INTEGER NOT NULL DEFAULT 0,
          sort TEXT NOT NULL DEFAULT 'relevance',sort_order TEXT NOT NULL DEFAULT 'desc',
          result_count INTEGER NOT NULL DEFAULT 0,use_count INTEGER NOT NULL DEFAULT 1,
          searched_at TEXT NOT NULL,device_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_search_history_searched
          ON search_history(searched_at DESC);
        CREATE TABLE IF NOT EXISTS workspace_search_files (
          rowid INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL,path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,mtime_ms INTEGER NOT NULL,indexable INTEGER NOT NULL DEFAULT 1,
          indexed_at TEXT NOT NULL,UNIQUE(workspace_id,path)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_search_files_workspace
          ON workspace_search_files(workspace_id,path);
        CREATE VIRTUAL TABLE IF NOT EXISTS workspace_search_fts USING fts5(
          path,content,workspace_id UNINDEXED,tokenize='trigram'
        );
        CREATE TABLE IF NOT EXISTS content_search_documents (
          rowid INTEGER PRIMARY KEY AUTOINCREMENT,source_key TEXT NOT NULL,event_cursor INTEGER NOT NULL,
          kind TEXT NOT NULL,item_id TEXT NOT NULL,provider TEXT,title TEXT NOT NULL,content TEXT NOT NULL,
          turn_id TEXT,updated_at TEXT,UNIQUE(source_key,event_cursor)
        );
        CREATE TABLE IF NOT EXISTS content_search_sources (
          source_key TEXT PRIMARY KEY,provider TEXT NOT NULL,session_id TEXT NOT NULL,
          session_origin TEXT NOT NULL DEFAULT 'unknown',source_kind TEXT NOT NULL,file_path TEXT,
          byte_offset INTEGER NOT NULL DEFAULT 0,event_cursor INTEGER NOT NULL DEFAULT 0,
          source_size INTEGER NOT NULL DEFAULT 0,source_mtime_ms INTEGER NOT NULL DEFAULT 0,
          indexed_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS content_search_fts USING fts5(
          title,content,tokenize='trigram'
        );",
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

fn clean_search_text(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(max)
        .collect()
}

fn normalize_session_origin(value: &str) -> &str {
    match value {
        "vibelink-cli" | "codex-desktop" | "imported" | "unknown" => value,
        _ => "all",
    }
}

fn saved_search_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
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
}

fn saved_search_by_id(connection: &Connection, id: &str) -> Result<Option<Value>> {
    connection
        .query_row(
            "SELECT id,name,query,scope,session_origin,tag,favorite,sort,sort_order,
                    created_at,updated_at,last_used_at FROM saved_searches WHERE id = ?1",
            params![id],
            saved_search_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn create_saved_search(connection: &Connection, payload: &Value) -> Result<Option<Value>> {
    let query = clean_search_text(payload.get("query"), 500);
    if query.is_empty() {
        return Ok(None);
    }
    let name = {
        let value = clean_search_text(payload.get("name"), 160);
        if value.is_empty() {
            query.clone()
        } else {
            value
        }
    };
    let scope = normalize_search_scope(
        payload
            .get("scope")
            .and_then(Value::as_str)
            .map(str::to_string),
    );
    let sort = normalize_search_sort(
        payload
            .get("sort")
            .and_then(Value::as_str)
            .map(str::to_string),
    );
    let order = normalize_search_order(
        payload
            .get("order")
            .and_then(Value::as_str)
            .map(str::to_string),
        sort,
    );
    let origin = clean_search_text(payload.get("sessionOrigin"), 40);
    let id = clean_search_text(payload.get("id"), 160);
    let id = if id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        id
    };
    let at = now_iso();
    connection.execute(
        "INSERT INTO saved_searches (
           id,name,query,scope,session_origin,tag,favorite,sort,sort_order,created_at,updated_at,last_used_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,NULL)",
        params![
            id, name, query, scope, normalize_session_origin(&origin),
            clean_search_text(payload.get("tag"), 160),
            i64::from(payload.get("favorite").and_then(Value::as_bool).unwrap_or(false)),
            sort, order, at
        ],
    )?;
    saved_search_by_id(connection, &id)
}

fn update_saved_search(connection: &Connection, id: &str, patch: &Value) -> Result<Option<Value>> {
    let Some(existing) = saved_search_by_id(connection, id)? else {
        return Ok(None);
    };
    let pick = |key: &str| patch.get(key).unwrap_or(&existing[key]).clone();
    let merged = json!({
        "name": pick("name"), "query": pick("query"), "scope": pick("scope"),
        "sessionOrigin": pick("sessionOrigin"), "tag": pick("tag"),
        "favorite": pick("favorite"), "sort": pick("sort"), "order": pick("order")
    });
    let query = clean_search_text(merged.get("query"), 500);
    if query.is_empty() {
        return Ok(None);
    }
    let name = clean_search_text(merged.get("name"), 160);
    let scope = normalize_search_scope(
        merged
            .get("scope")
            .and_then(Value::as_str)
            .map(str::to_string),
    );
    let sort = normalize_search_sort(
        merged
            .get("sort")
            .and_then(Value::as_str)
            .map(str::to_string),
    );
    let order = normalize_search_order(
        merged
            .get("order")
            .and_then(Value::as_str)
            .map(str::to_string),
        sort,
    );
    let origin = clean_search_text(merged.get("sessionOrigin"), 40);
    connection.execute(
        "UPDATE saved_searches SET name=?1,query=?2,scope=?3,session_origin=?4,tag=?5,
                favorite=?6,sort=?7,sort_order=?8,updated_at=?9 WHERE id=?10",
        params![
            if name.is_empty() { query.clone() } else { name },
            query,
            scope,
            normalize_session_origin(&origin),
            clean_search_text(merged.get("tag"), 160),
            i64::from(
                merged
                    .get("favorite")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            ),
            sort,
            order,
            now_iso(),
            id
        ],
    )?;
    saved_search_by_id(connection, id)
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

const SEARCH_MAX_FILES: usize = 50_000;
const SEARCH_MAX_FILE_BYTES: u64 = 512 * 1024;

fn refresh_search_index(connection: &Connection) -> Result<Vec<Value>> {
    if !table_exists(connection, "workspaces")? {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare("SELECT id,path FROM workspaces ORDER BY id")?;
    let workspaces = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = Vec::new();
    for (workspace_id, root) in workspaces {
        let root = PathBuf::from(root);
        if !root.is_dir() {
            continue;
        }
        let files = collect_search_files(&root)?;
        connection.execute_batch("BEGIN IMMEDIATE")?;
        let refreshed = refresh_workspace_search_rows(connection, &workspace_id, &root, &files);
        match refreshed {
            Ok(value) => {
                connection.execute_batch("COMMIT")?;
                result.push(value);
            }
            Err(error) => {
                let _ = connection.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
    }
    Ok(result)
}

fn collect_search_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if !matches!(
                    name.as_str(),
                    ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".gradle"
                ) {
                    pending.push(path);
                }
            } else if file_type.is_file() {
                let metadata = entry.metadata()?;
                if metadata.len() <= SEARCH_MAX_FILE_BYTES && is_search_text_file(&path) {
                    files.push(path);
                    if files.len() >= SEARCH_MAX_FILES {
                        return Ok(files);
                    }
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

fn is_search_text_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "txt"
            | "md"
            | "rs"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "json"
            | "toml"
            | "yaml"
            | "yml"
            | "kt"
            | "kts"
            | "java"
            | "py"
            | "go"
            | "html"
            | "css"
            | "sql"
    )
}

fn refresh_workspace_search_rows(
    connection: &Connection,
    workspace_id: &str,
    root: &Path,
    files: &[PathBuf],
) -> Result<Value> {
    let existing = {
        let mut statement = connection
            .prepare("SELECT rowid,path FROM workspace_search_files WHERE workspace_id = ?1")?;
        let rows = statement
            .query_map(params![workspace_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut seen = HashSet::new();
    let mut upserted = 0;
    for path in files {
        let relative = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        seen.insert(relative.clone());
        let metadata = fs::metadata(path)?;
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as i64)
            .unwrap_or(0);
        let content = fs::read_to_string(path).unwrap_or_default();
        let rowid = connection
            .query_row(
                "SELECT rowid FROM workspace_search_files WHERE workspace_id=?1 AND path=?2",
                params![workspace_id, relative],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let rowid = if let Some(rowid) = rowid {
            connection.execute(
                "DELETE FROM workspace_search_fts WHERE rowid=?1",
                params![rowid],
            )?;
            connection.execute(
                "UPDATE workspace_search_files SET size_bytes=?1,mtime_ms=?2,indexable=1,indexed_at=?3 WHERE rowid=?4",
                params![metadata.len() as i64, mtime_ms, now_iso(), rowid],
            )?;
            rowid
        } else {
            connection.execute(
                "INSERT INTO workspace_search_files(workspace_id,path,size_bytes,mtime_ms,indexable,indexed_at)
                 VALUES (?1,?2,?3,?4,1,?5)",
                params![workspace_id, relative, metadata.len() as i64, mtime_ms, now_iso()],
            )?;
            connection.last_insert_rowid()
        };
        connection.execute(
            "INSERT INTO workspace_search_fts(rowid,path,content,workspace_id) VALUES (?1,?2,?3,?4)",
            params![rowid, relative, content, workspace_id],
        )?;
        upserted += 1;
    }
    let mut deleted = 0;
    for (rowid, path) in existing {
        if seen.contains(&path) {
            continue;
        }
        connection.execute(
            "DELETE FROM workspace_search_fts WHERE rowid=?1",
            params![rowid],
        )?;
        connection.execute(
            "DELETE FROM workspace_search_files WHERE rowid=?1",
            params![rowid],
        )?;
        deleted += 1;
    }
    Ok(json!({
        "workspaceId": workspace_id,
        "upserted": upserted,
        "deleted": deleted
    }))
}

fn normalize_search_scope(value: Option<String>) -> &'static str {
    match value
        .as_deref()
        .unwrap_or("all")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "session" | "history" | "sessions" => "sessions",
        "task" | "tasks" => "tasks",
        "message" | "messages" => "messages",
        "workspace" | "file" | "files" => "files",
        _ => "all",
    }
}

fn normalize_search_sort(value: Option<String>) -> &'static str {
    match value.as_deref().unwrap_or("relevance") {
        "updatedAt" => "updatedAt",
        "title" => "title",
        "kind" => "kind",
        _ => "relevance",
    }
}

fn normalize_search_order(value: Option<String>, sort: &str) -> &'static str {
    match value.as_deref().map(str::trim) {
        Some("asc") => "asc",
        Some("desc") => "desc",
        _ if matches!(sort, "relevance" | "updatedAt") => "desc",
        _ => "asc",
    }
}

fn fts_expression(query: &str) -> Option<String> {
    let tokens = query
        .split_whitespace()
        .map(|token| token.replace('"', "").trim().to_string())
        .filter(|token| token.chars().count() >= 3)
        .map(|token| format!("\"{token}\""))
        .collect::<Vec<_>>();
    (!tokens.is_empty()).then(|| tokens.join(" AND "))
}

fn search_projection(connection: &Connection, request: &ParsedRequest) -> Result<Option<Value>> {
    if !table_exists(connection, "content_search_documents")?
        || !table_exists(connection, "content_search_sources")?
        || !table_exists(connection, "content_search_fts")?
        || !table_exists(connection, "workspace_search_fts")?
    {
        return Ok(None);
    }
    let query = request
        .query_parameter("q")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let scope = normalize_search_scope(request.query_parameter("scope"));
    let sort = normalize_search_sort(request.query_parameter("sort"));
    let order = normalize_search_order(request.query_parameter("order"), sort);
    let limit = request
        .query_parameter("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(50)
        .clamp(1, 200);
    let offset = request
        .query_parameter("cursor")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if query.is_empty() {
        return Ok(Some(json!({
            "items": [], "query": "", "scope": scope, "sort": sort, "order": order,
            "total": 0, "limit": limit, "cursor": offset.to_string(), "nextCursor": "",
            "savedSearchId": "", "index": search_index_status(connection)?.unwrap_or(json!({}))
        })));
    }
    let session_origin = request
        .query_parameter("sessionOrigin")
        .unwrap_or_else(|| "all".to_string());
    let mut results = Vec::new();
    if matches!(scope, "all" | "sessions" | "tasks" | "messages") {
        let kinds = match scope {
            "sessions" => vec!["history"],
            "tasks" => vec!["task"],
            "messages" => vec!["message"],
            _ => vec!["history", "task", "message"],
        };
        results.extend(search_content_rows(
            connection,
            &query,
            &kinds,
            &session_origin,
        )?);
    }
    if matches!(scope, "all" | "files") {
        results.extend(search_file_rows(connection, &query)?);
    }
    results.sort_by(|left, right| {
        let left_text = |key: &str| left[key].as_str().unwrap_or("");
        let right_text = |key: &str| right[key].as_str().unwrap_or("");
        let compared = match sort {
            "title" => left_text("title")
                .to_lowercase()
                .cmp(&right_text("title").to_lowercase()),
            "kind" => left_text("kind").cmp(right_text("kind")),
            "updatedAt" => left_text("updatedAt").cmp(right_text("updatedAt")),
            _ => left["_relevance"]
                .as_f64()
                .partial_cmp(&right["_relevance"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal),
        };
        let compared = if order == "desc" {
            compared.reverse()
        } else {
            compared
        };
        compared
            .then_with(|| right_text("updatedAt").cmp(left_text("updatedAt")))
            .then_with(|| left_text("id").cmp(right_text("id")))
    });
    let total = results.len();
    let items = results
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|mut item| {
            item.as_object_mut()
                .map(|object| object.remove("_relevance"));
            item
        })
        .collect::<Vec<_>>();
    let next_offset = offset + items.len();
    Ok(Some(json!({
        "items": items,
        "query": query,
        "scope": scope,
        "sort": sort,
        "order": order,
        "total": total,
        "limit": limit,
        "cursor": offset.to_string(),
        "nextCursor": if next_offset < total { next_offset.to_string() } else { String::new() },
        "savedSearchId": "",
        "index": search_index_status(connection)?.unwrap_or(json!({}))
    })))
}

fn search_content_rows(
    connection: &Connection,
    query: &str,
    kinds: &[&str],
    session_origin: &str,
) -> Result<Vec<Value>> {
    let mut sql = String::from(
        "SELECT d.kind,d.item_id,d.provider,d.title,d.content,d.turn_id,d.updated_at,
                s.session_origin,bm25(content_search_fts,4.0,1.0)
         FROM content_search_fts
         JOIN content_search_documents d ON d.rowid = content_search_fts.rowid
         JOIN content_search_sources s ON s.source_key = d.source_key
         WHERE content_search_fts MATCH ?1",
    );
    let mut values = vec![SqlValue::Text(
        fts_expression(query).unwrap_or_else(|| format!("\"{query}\"")),
    )];
    if !kinds.is_empty() {
        sql.push_str(&format!(
            " AND d.kind IN ({})",
            (0..kinds.len()).map(|_| "?").collect::<Vec<_>>().join(",")
        ));
        values.extend(kinds.iter().map(|kind| SqlValue::Text((*kind).to_string())));
    }
    if session_origin != "all" {
        sql.push_str(" AND s.session_origin = ?");
        values.push(SqlValue::Text(session_origin.to_string()));
    }
    sql.push_str(" ORDER BY 9 ASC,d.updated_at DESC LIMIT 10000");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            let title = row.get::<_, String>(3)?;
            let content = row.get::<_, String>(4)?;
            let rank = row.get::<_, f64>(8)?;
            Ok(json!({
                "kind": row.get::<_, String>(0)?,
                "id": row.get::<_, String>(1)?,
                "provider": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "sessionOrigin": row.get::<_, String>(7)?,
                "title": title,
                "snippet": content.chars().take(400).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" "),
                "turnId": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                "updatedAt": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                "_relevance": -rank + if title.to_lowercase().contains(query) { 10.0 } else { 0.0 }
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn search_file_rows(connection: &Connection, query: &str) -> Result<Vec<Value>> {
    let expression = fts_expression(query).unwrap_or_else(|| format!("\"{query}\""));
    let mut statement = connection.prepare(
        "SELECT f.path,f.workspace_id,m.mtime_ms,f.content,bm25(workspace_search_fts,4.0,1.0,0.0)
         FROM workspace_search_fts f
         JOIN workspace_search_files m ON m.rowid = f.rowid
         WHERE workspace_search_fts MATCH ?1
         ORDER BY 5 ASC,m.mtime_ms DESC,f.path ASC LIMIT 10000",
    )?;
    let rows = statement
        .query_map(params![expression], |row| {
            let path = row.get::<_, String>(0)?;
            let workspace_id = row.get::<_, String>(1)?;
            let mtime_ms = row.get::<_, i64>(2)?;
            let content = row.get::<_, String>(3)?;
            let rank = row.get::<_, f64>(4)?;
            let updated_at = DateTime::<Utc>::from_timestamp_millis(mtime_ms)
                .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
                .unwrap_or_default();
            Ok(json!({
                "kind": "file",
                "id": format!("{workspace_id}:{path}"),
                "workspaceId": workspace_id,
                "title": path,
                "path": path,
                "provider": "workspace",
                "snippet": content.chars().take(400).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" "),
                "updatedAt": updated_at,
                "_relevance": -rank + if path.to_lowercase().contains(query) { 10.0 } else { 0.0 }
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
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
             );
             CREATE TABLE content_search_sources (
               source_key TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT NOT NULL,
               session_origin TEXT NOT NULL, source_kind TEXT NOT NULL, file_path TEXT,
               byte_offset INTEGER NOT NULL, event_cursor INTEGER NOT NULL, source_size INTEGER NOT NULL,
               source_mtime_ms INTEGER NOT NULL, indexed_at TEXT NOT NULL
             );
             CREATE VIRTUAL TABLE content_search_fts USING fts5(title,content,tokenize='trigram');
             CREATE VIRTUAL TABLE workspace_search_fts USING fts5(path,content,workspace_id UNINDEXED,tokenize='trigram');",
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
        connection.execute(
            "INSERT INTO content_search_sources VALUES ('history:codex:one','codex','one','vibelink-cli','history','',0,1,4,1,'2026-07-23T00:00:00.000Z')",
            [],
        ).unwrap();
        connection
            .execute(
                "INSERT INTO content_search_fts(rowid,title,content) VALUES (1,'One','body')",
                [],
            )
            .unwrap();
        connection.execute(
            "INSERT INTO workspace_search_fts(rowid,path,content,workspace_id) VALUES (1,'src/main.rs','rust migration body','workspace-1')",
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
        let search = parse_request(b"GET /api/search?q=rust%20migration&scope=files&sort=title&order=asc&record=0 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let search_response = route_task_request(&search, None, &config).unwrap().unwrap();
        assert_eq!(search_response.body["total"], 1);
        assert_eq!(search_response.body["items"][0]["path"], "src/main.rs");
        assert_eq!(search_response.body["scope"], "files");
        assert_eq!(search_response.body["order"], "asc");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn task_identity_and_replay_cursor_survive_route_owner_restart() {
        let (dir, config) = fixture();
        let create = parse_request(
            b"POST /api/tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        let created =
            route_task_request(&create, Some(br#"{"prompt":"survive restart"}"#), &config)
                .unwrap()
                .unwrap();
        let id = created.body["id"].as_str().unwrap().to_string();
        let initial = parse_request(
            format!("GET /api/tasks/{id}/events/catch-up HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let initial_response = route_task_request(&initial, None, &config)
            .unwrap()
            .unwrap();
        let initial_items = initial_response.body["items"].as_array().unwrap();
        let acknowledged = initial_items[1]["cursor"].as_i64().unwrap();
        drop(config);

        let restarted = TaskRouteConfig::new(dir.clone());
        let tasks = parse_request(
            b"GET /api/tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n",
        )
        .unwrap();
        let tasks_response = route_task_request(&tasks, None, &restarted)
            .unwrap()
            .unwrap();
        assert!(tasks_response.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["id"] == id));
        let replay = parse_request(
            format!("GET /api/tasks/{id}/events/catch-up?after={acknowledged} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let replay_response = route_task_request(&replay, None, &restarted)
            .unwrap()
            .unwrap();
        let replay_items = replay_response.body["items"].as_array().unwrap();
        assert!(!replay_items.is_empty());
        assert!(replay_items
            .iter()
            .all(|event| event["cursor"].as_i64().unwrap() > acknowledged));
        let cursors = replay_items
            .iter()
            .map(|event| event["cursor"].as_i64().unwrap())
            .collect::<Vec<_>>();
        assert!(cursors.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(replay_response.body["nextCursor"], *cursors.last().unwrap());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn mutates_saved_searches_and_history_in_rust() {
        let (dir, config) = fixture();
        let create = parse_request(
            b"POST /api/search/saved HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        let created = route_task_request(
            &create,
            Some(br#"{"name":"Rust","query":"phase three","scope":"files","sessionOrigin":"vibelink-cli"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(created.status, 201);
        assert_eq!(created.body["query"], "phase three");
        let id = created.body["id"].as_str().unwrap();
        let patch = parse_request(
            format!("PATCH /api/search/saved/{id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let updated = route_task_request(
            &patch,
            Some(br#"{"favorite":true,"sort":"title","order":"asc"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated.body["favorite"], true);
        assert_eq!(updated.body["sort"], "title");
        let delete = parse_request(
            format!("DELETE /api/search/saved/{id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").as_bytes(),
        )
        .unwrap();
        assert_eq!(
            route_task_request(&delete, None, &config)
                .unwrap()
                .unwrap()
                .body["ok"],
            true
        );

        let connection = open_task_db(&dir).unwrap();
        connection
            .execute(
                "INSERT INTO search_history (
               id,signature,query,scope,session_origin,tag,favorite,sort,sort_order,
               result_count,use_count,searched_at,device_id
             ) VALUES ('history-1','sig','phase','all','all','',0,'relevance','desc',1,1,?1,'d')",
                params![now_iso()],
            )
            .unwrap();
        let clear = parse_request(
            b"DELETE /api/search/history HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n",
        )
        .unwrap();
        let cleared = route_task_request(&clear, None, &config).unwrap().unwrap();
        assert_eq!(cleared.body["deleted"], 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refreshes_workspace_fts_from_rust() {
        let (dir, config) = fixture();
        let workspace = dir.join("search-workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(
            workspace.join("src").join("phase.txt"),
            "native refresh marker",
        )
        .unwrap();
        let connection = open_task_db(&dir).unwrap();
        connection.execute_batch(
            "CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT NOT NULL,title TEXT NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO workspaces VALUES ('workspace-1',?1,'Search')",
                params![workspace.to_string_lossy()],
            )
            .unwrap();
        let refresh = parse_request(
            b"POST /api/search/index/refresh HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 0\r\n\r\n",
        )
        .unwrap();
        let refreshed = route_task_request(&refresh, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.body["ok"], true);
        assert_eq!(refreshed.body["result"][0]["upserted"], 1);
        let search = parse_request(
            b"GET /api/search?q=native%20refresh&scope=files&record=0 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n",
        )
        .unwrap();
        let result = route_task_request(&search, None, &config).unwrap().unwrap();
        assert_eq!(result.body["total"], 1);
        assert_eq!(result.body["items"][0]["path"], "src/phase.txt");
        fs::remove_file(workspace.join("src").join("phase.txt")).unwrap();
        let refreshed = route_task_request(&refresh, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.body["result"][0]["deleted"], 1);
        let _ = fs::remove_dir_all(dir);
    }
}
