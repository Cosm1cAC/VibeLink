use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

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
        && (request.path() == "/api/tasks"
            || request.path().starts_with("/api/tasks/"))
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
        RouteAuthentication::HostDenied => return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed."))),
        RouteAuthentication::Unauthorized => return Ok(Some(HttpRouteResponse::error(401, "Unauthorized"))),
        RouteAuthentication::Device(_) => {}
        RouteAuthentication::Pending => unreachable!(),
    }

    let connection = open_task_db(&config.data_dir)?;
    let response = if request.path() == "/api/tasks" && request.method == "GET" {
        HttpRouteResponse::json(200, json!({ "items": list_tasks(&connection)? }))
    } else if request.path() == "/api/tasks" && request.method == "POST" {
        let payload = read_json_body(body)?;
        if request.query_parameter("dryRun").as_deref() == Some("1") {
            HttpRouteResponse::json(200, json!({
                "dryRun": true,
                "agent": payload.get("agent").and_then(Value::as_str).unwrap_or("codex"),
                "prompt": payload.get("prompt").and_then(Value::as_str).unwrap_or(""),
                "approvalRequired": false,
                "wouldPersist": true
            }))
        } else {
            let task = create_queued_task(&connection, &payload)?;
            HttpRouteResponse::json(201, json!({
                "id": task["id"],
                "status": task["status"],
                "task": task
            }))
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
        HttpRouteResponse::json(200, json!({
            "items": items,
            "nextCursor": next_cursor,
            "hasMore": has_more,
            "limit": limit
        }))
    } else if let Some((task_id, "input")) = task_path_parts(request.path()) {
        let payload = read_json_body(body)?;
        let text = payload.get("text").and_then(Value::as_str).unwrap_or("").trim();
        if text.is_empty() {
            HttpRouteResponse::error(400, "Input is required.")
        } else if append_task_input(&connection, &task_id, text)? {
            HttpRouteResponse::json(200, json!({ "ok": true, "queued": true }))
        } else {
            HttpRouteResponse::error(404, "Task not found.")
        }
    } else if let Some((task_id, "stop")) = task_path_parts(request.path()) {
        if stop_task_projection(&connection, &task_id)? {
            HttpRouteResponse::json(200, json!({ "ok": true, "stopped": true }))
        } else {
            HttpRouteResponse::error(404, "Task not found.")
        }
    } else if request.path() == "/api/task-scheduler" && request.method == "GET" {
        HttpRouteResponse::json(200, json!({
            "ok": true,
            "owner": "rust",
            "mode": "durable-projection",
            "queued": count_tasks_by_status(&connection, "queued")?,
            "running": count_tasks_by_status(&connection, "running")?,
            "pending": count_tasks_by_status(&connection, "queued")?
        }))
    } else {
        return Ok(None);
    };
    config.metrics.responses.fetch_add(1, Ordering::SeqCst);
    Ok(Some(response))
}

fn is_task_route(path: &str) -> bool {
    path == "/api/tasks" || path == "/api/task-scheduler" || path.starts_with("/api/tasks/")
}

fn task_path_parts(path: &str) -> Option<(String, &str)> {
    let rest = path.strip_prefix("/api/tasks/")?;
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
        CREATE INDEX IF NOT EXISTS idx_task_events_task_cursor ON task_events(task_id, cursor);",
    )?;
    Ok(connection)
}

fn create_queued_task(connection: &Connection, payload: &Value) -> Result<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let agent = payload.get("agent").and_then(Value::as_str).unwrap_or("codex").trim();
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
    let workspace_id = payload.get("workspaceId").and_then(Value::as_str).unwrap_or("");
    let session_id = payload.get("sessionId").and_then(Value::as_str).unwrap_or("");
    let meta = json!({
        "launchMode": payload.get("mode").and_then(Value::as_str).unwrap_or("new"),
        "sessionOrigin": "vibelink-cli",
        "rustOwner": "task-http",
        "pendingWorkerStart": true,
        "launchPayload": payload
    });
    connection.execute(
        "INSERT INTO tasks (id,agent,title,cwd,workspace_id,status,created_at,updated_at,exit_code,session_id,command_label,log_path,meta_json)
         VALUES (?1,?2,?3,?4,?5,'queued',?6,?6,NULL,?7,?8,'',?9)",
        params![id, agent, title, cwd, workspace_id, now, session_id, agent, meta.to_string()],
    )?;
    insert_task_event(connection, &id, "system", &format!("Starting {agent} in {cwd}"), json!({ "agent": agent, "launchMode": meta["launchMode"] }))?;
    insert_task_event(connection, &id, "security", "Security policy: rust durable projection", json!({ "owner": "rust" }))?;
    if !prompt.trim().is_empty() {
        insert_task_event(connection, &id, "stdin", prompt, json!({}))?;
    }
    task_by_id(connection, &id)?.ok_or_else(|| anyhow::anyhow!("Created task is missing."))
}

fn append_task_input(connection: &Connection, task_id: &str, text: &str) -> Result<bool> {
    if task_by_id(connection, task_id)?.is_none() {
        return Ok(false);
    }
    insert_task_event(connection, task_id, "stdin", text, json!({ "queued": true }))?;
    insert_task_event(connection, task_id, "system", "Input queued for the next resume turn.", json!({}))?;
    connection.execute(
        "UPDATE tasks SET updated_at = ?1 WHERE id = ?2",
        params![now_iso(), task_id],
    )?;
    Ok(true)
}

fn stop_task_projection(connection: &Connection, task_id: &str) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE tasks SET status = 'cancelled', updated_at = ?1 WHERE id = ?2",
        params![now_iso(), task_id],
    )?;
    if changed == 0 {
        return Ok(false);
    }
    insert_task_event(connection, task_id, "system", "Task stop requested.", json!({ "stopped": true }))?;
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

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let meta_json = row.get::<_, Option<String>>(12)?.unwrap_or_else(|| "{}".to_string());
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
            let mut event = serde_json::from_str::<Value>(&row.get::<_, String>(1)?).unwrap_or(json!({}));
            event["cursor"] = json!(cursor);
            Ok(event)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into);
    rows
}

fn count_tasks_by_status(connection: &Connection, status: &str) -> Result<i64> {
    connection
        .query_row("SELECT COUNT(*) FROM tasks WHERE status = ?1", params![status], |row| row.get(0))
        .map_err(Into::into)
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

        let list = parse_request(
            b"GET /api/tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n",
        )
        .unwrap();
        let listed = route_task_request(&list, None, &config).unwrap().unwrap();
        assert!(listed.body["items"].as_array().unwrap().iter().any(|task| task["id"] == id));

        let catch_up = parse_request(
            format!("GET /api/tasks/{id}/events/catch-up?after=0&limit=10 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let events = route_task_request(&catch_up, None, &config).unwrap().unwrap();
        assert_eq!(events.status, 200);
        assert!(events.body["items"].as_array().unwrap().len() >= 3);
        let first_cursor = events.body["items"][0]["cursor"].as_i64().unwrap();

        let replay_after_first = parse_request(
            format!("GET /api/tasks/{id}/events/catch-up?after={first_cursor}&limit=10 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let replayed = route_task_request(&replay_after_first, None, &config).unwrap().unwrap();
        assert!(replayed.body["items"].as_array().unwrap().iter().all(|event| event["cursor"].as_i64().unwrap() > first_cursor));
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
        let stopped = route_task_request(&stop, Some(b"{}"), &config).unwrap().unwrap();
        assert_eq!(stopped.body["stopped"], true);
        let listed = list_tasks(&open_task_db(&dir).unwrap()).unwrap();
        assert_eq!(listed[0]["id"], id);
        assert_eq!(listed[0]["status"], "cancelled");
        let _ = fs::remove_dir_all(dir);
    }
}
