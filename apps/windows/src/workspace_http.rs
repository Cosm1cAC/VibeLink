use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use crate::execution_host::protocol::{read_json_frame, write_frame, RequestEnvelope, ResponseEnvelope, PROTOCOL_VERSION};
use crate::execution_host::windows::execd_pipe_name;
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::fs::OpenOptions;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::time::SystemTime;

const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
const MAX_UNTRACKED_PREVIEWS: usize = 6;
const MAX_UNTRACKED_PREVIEW_BYTES: u64 = 512 * 1024;

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "json", "jsonl", "js", "jsx", "ts", "tsx", "css", "scss", "html", "xml", "yaml",
    "yml", "toml", "py", "ps1", "sh", "bat", "cmd", "java", "go", "rs", "php", "rb", "c", "cpp",
    "h", "hpp", "cs", "sql",
];

#[derive(Clone)]
pub struct WorkspaceRouteConfig {
    pub data_dir: PathBuf,
    metrics: Arc<WorkspaceRouteMetrics>,
    mutation_lock: Arc<Mutex<()>>,
    #[cfg(test)]
    post_file_mutation_failure: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Default)]
struct WorkspaceRouteMetrics {
    attempts: AtomicU64,
    responses: AtomicU64,
    fallbacks: AtomicU64,
}

impl WorkspaceRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            metrics: Arc::new(WorkspaceRouteMetrics::default()),
            mutation_lock: Arc::new(Mutex::new(())),
            #[cfg(test)]
            post_file_mutation_failure: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.fallbacks.fetch_add(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
pub(crate) fn inject_post_file_mutation_failure_once(config: &WorkspaceRouteConfig) {
    config
        .post_file_mutation_failure
        .store(true, Ordering::SeqCst);
}

pub fn workspace_request_requires_body(request: &ParsedRequest) -> bool {
    if request.method != "POST" {
        return false;
    }
    let path = request.path();
    path == "/api/workspaces"
        || path == "/api/approvals"
        || path.ends_with("/decision")
        || (path.starts_with("/api/workspaces/")
            && (path.ends_with("/context")
                || path.ends_with("/file")
                || path.ends_with("/files/batch")
                || path.ends_with("/worktrees")
                || path.ends_with("/worktrees/action")
                || path.ends_with("/command")
                || path.ends_with("/terminal-session")
                || path.ends_with("/git/file-action")
                || path.ends_with("/git/action")))
        || (path.starts_with("/api/terminal-sessions/")
            && (path.ends_with("/input") || path.ends_with("/resize")))
}

pub fn route_workspace_request(
    request: &ParsedRequest,
    body: Option<&[u8]>,
    config: &WorkspaceRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if let Some(response) = route_approval_request(request, body, config)? {
        return Ok(Some(response));
    }
    if let Some(response) = route_tool_run_request(request, config)? {
        return Ok(Some(response));
    }
    if let Some(response) = route_terminal_session_request(request, body, config)? {
        return Ok(Some(response));
    }
    if request.path() == "/api/workspaces" {
        return route_workspace_collection_request(request, body, config);
    }
    let Some((workspace_id, action_path)) = workspace_path_parts(request.path()) else {
        return Ok(None);
    };
    let file_read = request.method == "GET" && action_path == "file";
    let file_preview = request.method == "GET" && action_path == "file/preview";
    let file_batch = request.method == "POST" && action_path == "files/batch";
    let tree = request.method == "GET" && action_path == "tree";
    let context = request.method == "POST" && action_path == "context";
    let open_explorer = request.method == "POST" && action_path == "open-explorer";
    let file_mutation = request.method == "POST" && action_path == "file";
    let git_status = request.method == "GET" && action_path == "git/status";
    let git_diff = request.method == "GET" && action_path == "git/diff";
    let worktree_list = request.method == "GET" && action_path == "worktrees";
    let worktree_create = request.method == "POST" && action_path == "worktrees";
    let worktree_action = request.method == "POST" && action_path == "worktrees/action";
    let git_file_action = request.method == "POST" && action_path == "git/file-action";
    let git_action = request.method == "POST" && action_path == "git/action";
    let command = request.method == "POST" && action_path == "command";
    let terminal_session = request.method == "POST" && action_path == "terminal-session";
    if !file_mutation
        && !file_read
        && !file_preview
        && !file_batch
        && !tree
        && !context
        && !open_explorer
        && !git_status
        && !git_diff
        && !worktree_list
        && !worktree_create
        && !worktree_action
        && !git_file_action
        && !git_action
        && !command
        && !terminal_session
    {
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
    if file_read {
        let result = read_workspace_file(&config.data_dir, &workspace_id, request)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        let headers = result
            .get("etag")
            .and_then(Value::as_str)
            .map(|etag| vec![("ETag".to_string(), etag.to_string())])
            .unwrap_or_default();
        return Ok(Some(
            HttpRouteResponse::json(200, result).with_headers(headers),
        ));
    }
    if file_preview {
        let result = preview_workspace_file(&config.data_dir, &workspace_id, request)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        let headers = result
            .get("etag")
            .and_then(Value::as_str)
            .map(|etag| vec![("ETag".to_string(), etag.to_string())])
            .unwrap_or_default();
        return Ok(Some(
            HttpRouteResponse::json(200, result).with_headers(headers),
        ));
    }
    if tree {
        let result = workspace_tree(&config.data_dir, &workspace_id, request)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(HttpRouteResponse::json(200, result)));
    }
    if git_status {
        let result = workspace_git_status(&config.data_dir, &workspace_id)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(HttpRouteResponse::json(200, result)));
    }
    if git_diff {
        let result = workspace_git_diff(&config.data_dir, &workspace_id)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(HttpRouteResponse::json(200, result)));
    }
    if worktree_list {
        let result = list_workspace_worktrees(&config.data_dir, &workspace_id)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(HttpRouteResponse::json(200, result)));
    }
    if open_explorer {
        let result = open_workspace_in_explorer(&config.data_dir, &workspace_id)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(HttpRouteResponse::json(200, result)));
    }
    let body = body.ok_or_else(|| anyhow::anyhow!("Workspace request body is required"))?;
    if body.len() > MAX_BODY_BYTES {
        return Ok(Some(HttpRouteResponse::error(
            413,
            "Request body is too large.",
        )));
    }
    let payload: Value = match serde_json::from_slice(body) {
        Ok(payload) => payload,
        Err(_) => {
            return Ok(Some(HttpRouteResponse::error(
                400,
                "Invalid workspace request JSON.",
            )))
        }
    };
    if context {
        let result = workspace_context(&config.data_dir, &workspace_id, &payload)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(HttpRouteResponse::json(200, result)));
    }
    if command {
        let result = run_workspace_command(&config.data_dir, &workspace_id, &payload)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(result));
    }
    if terminal_session {
        let result = start_workspace_terminal_session(&config.data_dir, &workspace_id, &payload)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(result));
    }
    if file_batch {
        let _mutation_guard = config
            .mutation_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Workspace mutation lock is poisoned"))?;
        let response =
            mutate_workspace_files_batch(&config.data_dir, &workspace_id, &payload, request)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(HttpRouteResponse::json(200, response)));
    }
    if worktree_create {
        let _mutation_guard = config
            .mutation_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Workspace mutation lock is poisoned"))?;
        let result = create_workspace_worktree(&config.data_dir, &workspace_id, &payload)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(HttpRouteResponse::json(200, result)));
    }
    if worktree_action {
        let _mutation_guard = config
            .mutation_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Workspace mutation lock is poisoned"))?;
        let result = apply_workspace_worktree_action(&config.data_dir, &workspace_id, &payload)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(HttpRouteResponse::json(200, result)));
    }
    if git_file_action {
        let _mutation_guard = config
            .mutation_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Workspace mutation lock is poisoned"))?;
        let response =
            apply_workspace_git_file_action(&config.data_dir, &workspace_id, &payload, request);
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(response));
    }
    if git_action {
        let action = payload
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if request.query_parameter("dryRun").as_deref() == Some("1") {
            config.metrics.responses.fetch_add(1, Ordering::SeqCst);
            return Ok(Some(HttpRouteResponse::json(
                200,
                json!({
                    "dryRun": true,
                    "workspaceId": workspace_id,
                    "action": action,
                    "message": payload.get("message").and_then(Value::as_str).unwrap_or(""),
                    "wouldExecute": true
                }),
            )));
        }
        let _mutation_guard = config
            .mutation_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Workspace mutation lock is poisoned"))?;
        let response =
            apply_workspace_git_action(&config.data_dir, &workspace_id, &action, &payload, request);
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(response));
    }
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("write")
        .to_ascii_lowercase();
    let _mutation_guard = config
        .mutation_lock
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock is poisoned"))?;
    let result = mutate_workspace(&config.data_dir, &workspace_id, &action, &payload, request)?;
    #[cfg(test)]
    if config
        .post_file_mutation_failure
        .swap(false, Ordering::SeqCst)
    {
        bail!("Injected post-workspace-mutation failure");
    }
    config.metrics.responses.fetch_add(1, Ordering::SeqCst);
    let response = match result {
        WorkspaceMutationOutcome::Success(result) => {
            let headers = result
                .get("etag")
                .and_then(Value::as_str)
                .map(|etag| vec![("ETag".to_string(), etag.to_string())])
                .unwrap_or_default();
            HttpRouteResponse::json(200, result).with_headers(headers)
        }
        WorkspaceMutationOutcome::Conflict(conflict) => {
            let headers = conflict
                .get("current")
                .and_then(|current| current.get("etag"))
                .and_then(Value::as_str)
                .map(|etag| vec![("ETag".to_string(), etag.to_string())])
                .unwrap_or_default();
            HttpRouteResponse::json(409, conflict).with_headers(headers)
        }
    };
    Ok(Some(response))
}

fn route_workspace_collection_request(
    request: &ParsedRequest,
    body: Option<&[u8]>,
    config: &WorkspaceRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    let list = request.method == "GET";
    let create = request.method == "POST";
    if !list && !create {
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
    if list {
        let result = list_workspaces(&config.data_dir)?;
        config.metrics.responses.fetch_add(1, Ordering::SeqCst);
        return Ok(Some(HttpRouteResponse::json(200, result)));
    }
    let body = body.ok_or_else(|| anyhow::anyhow!("Workspace create body is required"))?;
    if body.len() > MAX_BODY_BYTES {
        return Ok(Some(HttpRouteResponse::error(
            413,
            "Request body is too large.",
        )));
    }
    let payload: Value = serde_json::from_slice(body)
        .map_err(|_| anyhow::anyhow!("Invalid workspace create JSON."))?;
    let result = create_workspace(&config.data_dir, &payload)?;
    config.metrics.responses.fetch_add(1, Ordering::SeqCst);
    Ok(Some(HttpRouteResponse::json(201, result)))
}

fn workspace_json(
    id: String,
    path: String,
    title: String,
    allowed_root: String,
    created_at: String,
    updated_at: String,
    last_used_at: String,
) -> Value {
    json!({
        "id": id,
        "path": path,
        "title": title,
        "allowedRoot": allowed_root,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "lastUsedAt": last_used_at
    })
}

fn open_workspace_db(data_dir: &Path) -> Result<Connection> {
    let db_path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", db_path.display()))?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS approval_requests (
           id TEXT PRIMARY KEY, tool_run_id TEXT, task_id TEXT, workspace_id TEXT,
           kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT, reason TEXT,
           request_json TEXT, risk_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
           expires_at TEXT, decided_at TEXT, decided_by_device_id TEXT,
           decision_reason TEXT, decision_json TEXT
         );",
    )?;
    Ok(connection)
}

fn route_approval_request(
    request: &ParsedRequest,
    body: Option<&[u8]>,
    config: &WorkspaceRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    let path = request.path();
    let is_list = path == "/api/approvals" && request.method == "GET";
    let decision_id = path
        .strip_prefix("/api/approvals/")
        .and_then(|value| value.strip_suffix("/decision"))
        .filter(|value| !value.is_empty());
    if !is_list && !(decision_id.is_some() && request.method == "POST") {
        return Ok(None);
    }
    let auth = authenticate_route_request(request, &config.data_dir)?;
    if auth == RouteAuthentication::Pending {
        return Ok(None);
    }
    match auth {
        RouteAuthentication::HostDenied => return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed."))),
        RouteAuthentication::Unauthorized => return Ok(Some(HttpRouteResponse::error(401, "Unauthorized"))),
        RouteAuthentication::Device(_) => {}
        RouteAuthentication::Pending => unreachable!(),
    }
    let connection = open_workspace_db(&config.data_dir)?;
    if is_list {
        let mut statement = connection.prepare(
            "SELECT id, tool_run_id, task_id, workspace_id, kind, status, title, reason,
                    request_json, risk_json, created_at, updated_at, expires_at
             FROM approval_requests ORDER BY created_at DESC LIMIT 500",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "toolRunId": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    "taskId": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    "workspaceId": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    "kind": row.get::<_, String>(4)?,
                    "status": row.get::<_, String>(5)?,
                    "title": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    "reason": row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                    "request": serde_json::from_str::<Value>(&row.get::<_, Option<String>>(8)?.unwrap_or_else(|| "{}".into())).unwrap_or(json!({})),
                    "risk": serde_json::from_str::<Value>(&row.get::<_, Option<String>>(9)?.unwrap_or_else(|| "{}".into())).unwrap_or(json!({})),
                    "createdAt": row.get::<_, String>(10)?,
                    "updatedAt": row.get::<_, String>(11)?,
                    "expiresAt": row.get::<_, Option<String>>(12)?.unwrap_or_default()
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        return Ok(Some(HttpRouteResponse::json(200, json!({ "approvals": rows }))));
    }
    let approval_id = decision_id.unwrap();
    let body = body.ok_or_else(|| anyhow::anyhow!("Approval decision body is required"))?;
    let payload: Value = serde_json::from_slice(body).map_err(|_| anyhow::anyhow!("Invalid approval decision JSON."))?;
    let decision = payload.get("decision").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    if !matches!(decision.as_str(), "approve" | "approved" | "deny" | "denied" | "reject" | "decline") {
        return Ok(Some(HttpRouteResponse::error(400, "Approval decision must be approve or deny.")));
    }
    let status = if matches!(decision.as_str(), "approve" | "approved") { "approved" } else { "denied" };
    let now = now_iso();
    let changed = connection.execute(
        "UPDATE approval_requests SET status = ?1, updated_at = ?2, decided_at = ?2,
         decision_reason = ?3, decision_json = ?4 WHERE id = ?5 AND status = 'pending'",
        params![status, now, payload.get("reason").and_then(Value::as_str).unwrap_or(""), payload.to_string(), approval_id],
    )?;
    if changed == 0 {
        return Ok(Some(HttpRouteResponse::error(409, "Approval request is no longer pending.")));
    }
    let approval = json!({ "id": approval_id, "status": status, "decision": decision });
    Ok(Some(HttpRouteResponse::json(200, json!({ "ok": status == "approved", "approval": approval }))))
}

fn route_tool_run_request(
    request: &ParsedRequest,
    config: &WorkspaceRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.path() != "/api/tool-runs" || request.method != "GET" {
        return Ok(None);
    }
    let auth = authenticate_route_request(request, &config.data_dir)?;
    if auth == RouteAuthentication::Pending {
        return Ok(None);
    }
    match auth {
        RouteAuthentication::HostDenied => return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed."))),
        RouteAuthentication::Unauthorized => return Ok(Some(HttpRouteResponse::error(401, "Unauthorized"))),
        RouteAuthentication::Device(_) => {}
        RouteAuthentication::Pending => unreachable!(),
    }
    let connection = open_workspace_db(&config.data_dir)?;
    let mut statement = connection.prepare(
        "SELECT id, task_id, workspace_id, tool_name, status, title, input_json, result_json,
                error, created_at, updated_at, started_at, completed_at
         FROM tool_runs ORDER BY updated_at DESC, created_at DESC LIMIT 500",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(tool_run_json(
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                row.get::<_, Option<String>>(6)?.unwrap_or_else(|| "{}".into()),
                row.get::<_, Option<String>>(7)?.unwrap_or_else(|| "null".into()),
                row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                row.get::<_, Option<String>>(12)?.unwrap_or_default(),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(HttpRouteResponse::json(200, json!({ "items": rows }))))
}

fn route_terminal_session_request(
    request: &ParsedRequest,
    body: Option<&[u8]>,
    config: &WorkspaceRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    let list = request.path() == "/api/terminal-sessions" && request.method == "GET";
    let session_id = request
        .path()
        .strip_prefix("/api/terminal-sessions/")
        .filter(|value| !value.is_empty() && !value.contains('/'));
    let input_id = request.path().strip_prefix("/api/terminal-sessions/").and_then(|value| value.strip_suffix("/input"));
    let resize_id = request.path().strip_prefix("/api/terminal-sessions/").and_then(|value| value.strip_suffix("/resize"));
    if !list && !(session_id.is_some() && request.method == "GET") && input_id.is_none() && resize_id.is_none() {
        return Ok(None);
    }
    let auth = authenticate_route_request(request, &config.data_dir)?;
    if auth == RouteAuthentication::Pending {
        return Ok(None);
    }
    match auth {
        RouteAuthentication::HostDenied => return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed."))),
        RouteAuthentication::Unauthorized => return Ok(Some(HttpRouteResponse::error(401, "Unauthorized"))),
        RouteAuthentication::Device(_) => {}
        RouteAuthentication::Pending => unreachable!(),
    }
    let connection = open_workspace_db(&config.data_dir)?;
    if let Some(id) = input_id {
        if request.method != "POST" { return Ok(None); }
        let payload = terminal_json_body(body)?;
        let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
        if text.is_empty() { return Ok(Some(HttpRouteResponse::error(400, "Input is required."))); }
        return Ok(Some(terminal_host_mutation(&connection, &config.data_dir, id, "execution.input", json!({
            "executionId": id, "data": text, "encoding": "utf8", "operationId": uuid::Uuid::new_v4().to_string()
        }))?));
    }
    if let Some(id) = resize_id {
        if request.method != "POST" { return Ok(None); }
        let payload = terminal_json_body(body)?;
        let cols = payload.get("cols").and_then(Value::as_u64).filter(|value| (1..=1000).contains(value));
        let rows = payload.get("rows").and_then(Value::as_u64).filter(|value| (1..=1000).contains(value));
        let (Some(cols), Some(rows)) = (cols, rows) else { return Ok(Some(HttpRouteResponse::error(400, "Valid cols and rows are required."))); };
        return Ok(Some(terminal_host_mutation(&connection, &config.data_dir, id, "execution.resize", json!({
            "executionId": id, "cols": cols, "rows": rows, "operationId": uuid::Uuid::new_v4().to_string()
        }))?));
    }
    if let Some(id) = session_id {
        let session = connection
            .query_row(
                "SELECT id, workspace_id, status, input_json, started_at FROM tool_runs WHERE id = ?1 AND tool_name = 'workspace.terminal_session'",
                params![id],
                |row| Ok(terminal_session_json(row.get(0)?, row.get::<_, Option<String>>(1)?.unwrap_or_default(), row.get(2)?, row.get::<_, Option<String>>(3)?.unwrap_or_else(|| "{}".into()), row.get::<_, Option<String>>(4)?.unwrap_or_default())),
            )
            .optional()?;
        return Ok(Some(match session {
            Some(session) => HttpRouteResponse::json(200, json!({ "session": session })),
            None => HttpRouteResponse::error(404, "Terminal session not found."),
        }));
    }
    let mut statement = connection.prepare(
        "SELECT id, workspace_id, status, input_json, started_at FROM tool_runs
         WHERE tool_name = 'workspace.terminal_session' ORDER BY updated_at DESC LIMIT 200",
    )?;
    let rows = statement
        .query_map([], |row| Ok(terminal_session_json(row.get(0)?, row.get::<_, Option<String>>(1)?.unwrap_or_default(), row.get(2)?, row.get::<_, Option<String>>(3)?.unwrap_or_else(|| "{}".into()), row.get::<_, Option<String>>(4)?.unwrap_or_default())))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(HttpRouteResponse::json(200, json!({ "items": rows }))))
}

fn terminal_host_mutation(
    connection: &Connection,
    data_dir: &Path,
    id: &str,
    method: &str,
    params_value: Value,
) -> Result<HttpRouteResponse> {
    let exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM tool_runs WHERE id = ?1 AND tool_name = 'workspace.terminal_session')",
        params![id],
        |row| row.get::<_, i64>(0),
    )? != 0;
    if !exists {
        return Ok(HttpRouteResponse::error(404, "Terminal session not found."));
    }
    let pipe_name = execd_pipe_name(data_dir);
    let mut pipe = OpenOptions::new().read(true).write(true).open(&pipe_name)
        .with_context(|| format!("Cannot connect to execution host {pipe_name}"))?;
    let request_id = uuid::Uuid::new_v4().to_string();
    write_frame(&mut pipe, &RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: request_id.clone(),
        method: method.to_string(),
        params: params_value,
    })?;
    let response: ResponseEnvelope = read_json_frame(&mut pipe)?
        .ok_or_else(|| anyhow::anyhow!("Execution host closed the terminal request."))?;
    if response.request_id != request_id {
        bail!("Execution host returned a mismatched request ID.");
    }
    if let Some(error) = response.error {
        return Ok(HttpRouteResponse::json(409, json!({
            "ok": false, "error": error.message, "code": error.code, "retryable": error.retryable
        })));
    }
    let result = response.result.unwrap_or(Value::Null);
    let mut output = json!({ "ok": true, "session": result });
    if method == "execution.resize" {
        let cols = output["session"].get("cols").cloned().unwrap_or(Value::Null);
        let rows = output["session"].get("rows").cloned().unwrap_or(Value::Null);
        if !cols.is_null() || !rows.is_null() {
            output["cols"] = cols;
            output["rows"] = rows;
        }
    }
    Ok(HttpRouteResponse::json(200, output))
}

fn terminal_json_body(body: Option<&[u8]>) -> Result<Value> {
    let body = body.ok_or_else(|| anyhow::anyhow!("Terminal request body is required."))?;
    if body.len() > MAX_BODY_BYTES {
        bail!("Request body is too large.");
    }
    serde_json::from_slice(body).context("Invalid terminal request JSON.")
}

fn tool_run_json(
    id: String,
    task_id: String,
    workspace_id: String,
    tool_name: String,
    status: String,
    title: String,
    input_json: String,
    result_json: String,
    error: String,
    created_at: String,
    updated_at: String,
    started_at: String,
    completed_at: String,
) -> Value {
    json!({
        "id": id,
        "taskId": task_id,
        "workspaceId": workspace_id,
        "toolName": tool_name,
        "status": status,
        "title": title,
        "input": serde_json::from_str::<Value>(&input_json).unwrap_or(json!({})),
        "result": serde_json::from_str::<Value>(&result_json).unwrap_or(Value::Null),
        "error": error,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "startedAt": started_at,
        "completedAt": completed_at
    })
}

fn terminal_session_json(
    id: String,
    workspace_id: String,
    status: String,
    input_json: String,
    started_at: String,
) -> Value {
    let input = serde_json::from_str::<Value>(&input_json).unwrap_or(json!({}));
    json!({
        "id": id,
        "toolRunId": id,
        "workspaceId": workspace_id,
        "cwd": input.get("cwd").and_then(Value::as_str).unwrap_or(""),
        "shell": input.get("shell").and_then(Value::as_str).unwrap_or(""),
        "mode": input.get("mode").and_then(Value::as_str).unwrap_or("execd"),
        "status": status,
        "startedAt": started_at
    })
}

fn run_workspace_command(
    data_dir: &Path,
    workspace_id: &str,
    payload: &Value,
) -> Result<HttpRouteResponse> {
    let workspace = load_workspace_git_context(data_dir, workspace_id)?;
    let command = payload.get("command").and_then(Value::as_str).unwrap_or("").trim();
    if command.is_empty() {
        return Ok(HttpRouteResponse::error(400, "Command is required."));
    }
    let kind = if payload.get("kind").and_then(Value::as_str) == Some("test") { "test" } else { "terminal" };
    let connection = open_workspace_db(data_dir)?;
    let tool_run_id = create_started_workspace_tool_run(
        &connection,
        workspace_id,
        &format!("workspace.{}", if kind == "test" { "test" } else { "command" }),
        &format!("{} {}", kind, command),
        &json!({ "command": command, "kind": kind, "timeoutMs": payload.get("timeoutMs").cloned().unwrap_or(json!(120000)) }),
    )?;
    let risky = ["rm -rf", "remove-item", "format ", "shutdown", "del /s", "git reset --hard"]
        .iter().any(|needle| command.to_ascii_lowercase().contains(needle));
    if risky && payload.get("approved").and_then(Value::as_bool) != Some(true) {
        let approval_id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        connection.execute(
            "INSERT INTO approval_requests (id,tool_run_id,task_id,workspace_id,kind,status,title,reason,request_json,risk_json,created_at,updated_at)
             VALUES (?1,?2,'',?3,?4,'pending',?5,?6,?7,?8,?9,?9)",
            params![
                approval_id, tool_run_id, workspace_id,
                format!("workspace.{}", if kind == "test" { "test" } else { "command" }),
                "Approve workspace command", "dangerous command",
                json!({ "command": command, "cwd": workspace.cwd, "kind": kind }).to_string(),
                json!({ "reasons": ["dangerous command"], "matches": ["command policy"] }).to_string(), now
            ],
        )?;
        return Ok(HttpRouteResponse::json(428, json!({
            "error": "Command requires explicit approval: dangerous command",
            "approvalId": approval_id,
            "toolRunId": tool_run_id,
            "reasons": ["dangerous command"],
            "matches": ["command policy"],
            "approval": { "id": approval_id, "status": "pending", "toolRunId": tool_run_id }
        })));
    }
    #[cfg(windows)]
    let mut process = Command::new("powershell.exe");
    #[cfg(windows)]
    process.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
    #[cfg(not(windows))]
    let mut process = Command::new("sh");
    #[cfg(not(windows))]
    process.args(["-lc", command]);
    let output = process.current_dir(&workspace.root).output()?;
    let result = json!({
        "ok": output.status.success(),
        "workspace": workspace_json(workspace_id.to_string(), workspace.cwd.clone(), workspace.title, workspace.allowed_root, workspace.created_at, workspace.updated_at, workspace.last_used_at),
        "cwd": workspace.cwd,
        "command": command,
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr),
        "exitCode": output.status.code().unwrap_or(1),
        "toolRunId": tool_run_id
    });
    let status = if output.status.success() { "completed" } else { "failed" };
    connection.execute("UPDATE tool_runs SET status = ?1, result_json = ?2, updated_at = ?3, completed_at = ?3 WHERE id = ?4", params![status, result.to_string(), now_iso(), tool_run_id])?;
    insert_workspace_tool_event(&connection, &tool_run_id, workspace_id, if output.status.success() { "tool.completed" } else { "tool.error" }, if output.status.success() { "Workspace command completed." } else { "Workspace command failed." }, result.clone())?;
    Ok(HttpRouteResponse::json(200, result))
}

fn start_workspace_terminal_session(
    data_dir: &Path,
    workspace_id: &str,
    payload: &Value,
) -> Result<HttpRouteResponse> {
    let workspace = load_workspace_git_context(data_dir, workspace_id)?;
    let shell = payload.get("shell").and_then(Value::as_str).unwrap_or("");
    let shell = if shell.is_empty() {
        if cfg!(windows) { "powershell.exe" } else { "sh" }
    } else {
        shell
    };
    let connection = open_workspace_db(data_dir)?;
    let tool_run_id = create_started_workspace_tool_run(
        &connection,
        workspace_id,
        "workspace.terminal_session",
        "Workspace terminal session",
        &json!({
            "workspaceId": workspace_id,
            "cwd": workspace.cwd,
            "shell": shell,
            "mode": payload.get("mode").and_then(Value::as_str).unwrap_or("auto"),
            "cols": payload.get("cols").cloned().unwrap_or(json!(100)),
            "rows": payload.get("rows").cloned().unwrap_or(json!(30))
        }),
    )?;
    let result = json!({
        "ok": true,
        "status": "running",
        "toolRunId": tool_run_id,
        "session": {
            "id": tool_run_id,
            "toolRunId": tool_run_id,
            "workspaceId": workspace_id,
            "cwd": workspace.cwd,
            "shell": shell,
            "mode": "execd",
            "status": "running"
        }
    });
    Ok(HttpRouteResponse::json(202, result))
}

fn list_workspaces(data_dir: &Path) -> Result<Value> {
    let connection = open_workspace_db(data_dir)?;
    let mut statement = connection.prepare(
        "SELECT id, path, title, allowed_root, created_at, updated_at, last_used_at
         FROM workspaces ORDER BY updated_at DESC, created_at DESC, id ASC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(workspace_json(
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({ "items": rows }))
}

fn create_workspace(data_dir: &Path, payload: &Value) -> Result<Value> {
    let raw_path = payload
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if raw_path.is_empty() {
        bail!("Workspace path is required.");
    }
    let root = canonical_root(Path::new(raw_path))?;
    let title = payload
        .get("title")
        .or_else(|| payload.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            root.file_name()
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
                .unwrap_or_else(|| root.to_string_lossy().into_owned())
        });
    let now = now_iso();
    let id = format!(
        "workspace-{}",
        Sha256::digest(root.to_string_lossy().as_bytes())
            .iter()
            .take(8)
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let path = root.to_string_lossy().into_owned();
    let connection = open_workspace_db(data_dir)?;
    connection.execute(
        "INSERT INTO workspaces (id, path, title, allowed_root, created_at, updated_at, last_used_at)
         VALUES (?1, ?2, ?3, ?2, ?4, ?4, ?4)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, title = excluded.title,
           allowed_root = excluded.allowed_root, updated_at = excluded.updated_at, last_used_at = excluded.last_used_at",
        params![id, path, title, now],
    )?;
    Ok(json!({
        "workspace": workspace_json(id, path.clone(), title, path, now.clone(), now.clone(), now)
    }))
}

fn now_iso() -> String {
    let now: DateTime<Utc> = SystemTime::now().into();
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

struct WorkspaceGitContext {
    cwd: String,
    title: String,
    allowed_root: String,
    created_at: String,
    updated_at: String,
    last_used_at: String,
    root: PathBuf,
}

fn load_workspace_git_context(data_dir: &Path, workspace_id: &str) -> Result<WorkspaceGitContext> {
    let db_path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", db_path.display()))?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let (cwd, title, allowed_root, created_at, updated_at, last_used_at) = connection
        .query_row(
            "SELECT path, title, allowed_root, created_at, updated_at, last_used_at FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                ))
            },
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("Workspace not found."))?;
    let root = canonical_root(Path::new(&cwd))?;
    let now: DateTime<Utc> = SystemTime::now().into();
    let now = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    connection.execute(
        "UPDATE workspaces SET last_used_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, workspace_id],
    )?;
    Ok(WorkspaceGitContext {
        cwd,
        title,
        allowed_root,
        created_at,
        updated_at,
        last_used_at,
        root,
    })
}

fn workspace_git_status(data_dir: &Path, workspace_id: &str) -> Result<Value> {
    let workspace = load_workspace_git_context(data_dir, workspace_id)?;
    let status = run_git(&workspace.root, &["status", "--porcelain=v1", "-b"])?;
    let branch = status
        .stdout
        .lines()
        .find_map(|line| line.strip_prefix("## "))
        .unwrap_or("")
        .to_string();
    let files = parse_git_status_files(&status.stdout)
        .into_iter()
        .map(|(status, path)| {
            json!({
                "status": status,
                "path": path
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "ok": status.ok,
        "branch": branch,
        "changedCount": files.len(),
        "files": files,
        "stdout": status.stdout,
        "stderr": status.stderr,
        "exitCode": status.exit_code,
        "workspace": {
            "id": workspace_id,
            "title": workspace.title,
            "path": workspace.cwd,
            "allowedRoot": workspace.allowed_root,
            "createdAt": workspace.created_at,
            "updatedAt": workspace.updated_at,
            "lastUsedAt": workspace.last_used_at
        },
        "cwd": workspace.cwd
    }))
}

fn workspace_git_diff(data_dir: &Path, workspace_id: &str) -> Result<Value> {
    let workspace = load_workspace_git_context(data_dir, workspace_id)?;
    let status = run_git(&workspace.root, &["status", "--porcelain=v1", "-b"])?;
    let mut diff = run_git(
        &workspace.root,
        &["diff", "HEAD", "--stat", "--patch", "--find-renames"],
    )?;
    let diff_error = diff.stderr.to_ascii_lowercase();
    if !diff.ok
        && ["bad revision", "ambiguous argument", "unknown revision"]
            .iter()
            .any(|needle| diff_error.contains(needle))
    {
        diff = run_git(
            &workspace.root,
            &["diff", "--stat", "--patch", "--find-renames"],
        )?;
    }

    let status_files = parse_git_status_files(&status.stdout);
    let mut untracked_previews = Vec::new();
    let mut untracked_preview_errors = Vec::new();
    for (_, path) in status_files
        .iter()
        .filter(|(status, _)| status == "??")
        .take(MAX_UNTRACKED_PREVIEWS)
    {
        match pseudo_diff_for_untracked(&workspace.root, path) {
            Ok(Some(preview)) => untracked_previews.push(preview),
            Ok(None) => {}
            Err(error) => untracked_preview_errors.push(json!({
                "path": path,
                "error": error.to_string()
            })),
        }
    }

    let mut combined_diff = diff.stdout.clone();
    for preview in untracked_previews {
        if !combined_diff.is_empty() {
            combined_diff.push('\n');
        }
        combined_diff.push_str(&preview);
    }
    let mut files = parse_git_diff_files(&combined_diff);
    for (status_value, path) in &status_files {
        if let Some(existing) = files.iter_mut().find(|file| file["path"] == *path) {
            existing["status"] = json!(if status_value == "??" {
                "A"
            } else {
                status_value
            });
        } else {
            files.push(json!({
                "status": status_value,
                "path": path,
                "oldPath": path,
                "additions": 0,
                "deletions": 0
            }));
        }
    }
    let branch = status
        .stdout
        .lines()
        .find_map(|line| line.strip_prefix("## "))
        .unwrap_or("")
        .to_string();
    let stderr = [status.stderr.as_str(), diff.stderr.as_str()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let exit_code = if status.exit_code != 0 {
        status.exit_code
    } else {
        diff.exit_code
    };
    let changed_count = if status_files.is_empty() {
        files.len()
    } else {
        status_files.len()
    };
    Ok(json!({
        "ok": status.ok && diff.ok,
        "branch": branch,
        "files": files,
        "changedCount": changed_count,
        "fileCount": files.len(),
        "lineCount": combined_diff.lines().filter(|line| !line.is_empty()).count(),
        "diff": combined_diff,
        "statusStdout": status.stdout,
        "stdout": diff.stdout,
        "stderr": stderr,
        "exitCode": exit_code,
        "untrackedPreviewErrors": untracked_preview_errors,
        "workspace": {
            "id": workspace_id,
            "title": workspace.title,
            "path": workspace.cwd,
            "allowedRoot": workspace.allowed_root,
            "createdAt": workspace.created_at,
            "updatedAt": workspace.updated_at,
            "lastUsedAt": workspace.last_used_at
        },
        "cwd": workspace.cwd
    }))
}

fn list_workspace_worktrees(data_dir: &Path, workspace_id: &str) -> Result<Value> {
    let db_path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", db_path.display()))?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let cwd = connection
        .query_row(
            "SELECT path FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("Workspace not found."))?;
    let root = canonical_root(Path::new(&cwd))?;
    let result = run_git(&root, &["worktree", "list", "--porcelain"])?;
    if !result.ok {
        bail!(
            "{}",
            if result.stderr.is_empty() {
                "Failed to list git worktrees."
            } else {
                result.stderr.trim()
            }
        );
    }

    let mut statement = connection.prepare(
        "SELECT id, path, title, allowed_root, created_at, updated_at, last_used_at FROM workspaces",
    )?;
    let registered = statement
        .query_map([], |row| {
            let path = row.get::<_, String>(1)?;
            let workspace = json!({
                "id": row.get::<_, String>(0)?,
                "path": path,
                "title": row.get::<_, String>(2)?,
                "allowedRoot": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "createdAt": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                "updatedAt": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                "lastUsedAt": row.get::<_, Option<String>>(6)?.unwrap_or_default()
            });
            Ok((normalized_path_key(Path::new(&path)), workspace))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    let mut worktrees = parse_worktree_list(&result.stdout);
    for worktree in &mut worktrees {
        let path = worktree["path"].as_str().unwrap_or("");
        worktree["workspace"] = registered
            .iter()
            .find(|(key, _)| key == &normalized_path_key(Path::new(path)))
            .map(|(_, workspace)| workspace.clone())
            .unwrap_or(Value::Null);
    }
    let now: DateTime<Utc> = SystemTime::now().into();
    let now = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    connection.execute(
        "UPDATE workspaces SET last_used_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, workspace_id],
    )?;
    Ok(json!({
        "ok": true,
        "workspaceId": workspace_id,
        "worktrees": worktrees
    }))
}

struct GitCommandResult {
    ok: bool,
    stdout: String,
    stderr: String,
    exit_code: i32,
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<GitCommandResult> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("Failed to run git {}", args.join(" ")))?;
    if output.stdout.len().saturating_add(output.stderr.len()) > MAX_GIT_OUTPUT_BYTES {
        bail!("Git output exceeds 10 MiB.");
    }
    Ok(GitCommandResult {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(1),
    })
}

fn parse_git_status_files(stdout: &str) -> Vec<(String, String)> {
    stdout
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with("##"))
        .filter_map(|line| {
            let path = line.get(3..)?.trim();
            if path.is_empty() {
                return None;
            }
            let status = line.get(..2).unwrap_or("").trim();
            Some((
                if status.is_empty() { "??" } else { status }.to_string(),
                path.to_string(),
            ))
        })
        .collect()
}

fn parse_git_diff_files(diff: &str) -> Vec<Value> {
    let mut files = Vec::new();
    let mut current = None;
    for line in diff.lines() {
        if let Some(paths) = line.strip_prefix("diff --git a/") {
            if let Some((old_path, path)) = paths.split_once(" b/") {
                files.push(json!({
                    "oldPath": old_path,
                    "path": path,
                    "status": "M",
                    "additions": 0,
                    "deletions": 0
                }));
                current = Some(files.len() - 1);
                continue;
            }
        }
        let Some(index) = current else {
            continue;
        };
        if line.starts_with("new file mode") {
            files[index]["status"] = json!("A");
        } else if line.starts_with("deleted file mode") {
            files[index]["status"] = json!("D");
        } else if line.starts_with("rename from") {
            files[index]["status"] = json!("R");
        }
        if line.starts_with('+') && !line.starts_with("+++") {
            let additions = files[index]["additions"].as_u64().unwrap_or(0) + 1;
            files[index]["additions"] = json!(additions);
        }
        if line.starts_with('-') && !line.starts_with("---") {
            let deletions = files[index]["deletions"].as_u64().unwrap_or(0) + 1;
            files[index]["deletions"] = json!(deletions);
        }
    }
    files
}

fn parse_worktree_list(stdout: &str) -> Vec<Value> {
    let mut entries = Vec::new();
    let mut current = None;
    for line in stdout.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        if key == "worktree" {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            current = Some(json!({
                "path": Path::new(value).to_string_lossy(),
                "headSha": "",
                "branch": "",
                "detached": false,
                "bare": false,
                "locked": false,
                "lockReason": "",
                "prunable": false,
                "pruneReason": ""
            }));
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        match key {
            "HEAD" => entry["headSha"] = json!(value),
            "branch" => entry["branch"] = json!(value.strip_prefix("refs/heads/").unwrap_or(value)),
            "detached" => entry["detached"] = json!(true),
            "bare" => entry["bare"] = json!(true),
            "locked" => {
                entry["locked"] = json!(true);
                entry["lockReason"] = json!(value);
            }
            "prunable" => {
                entry["prunable"] = json!(true);
                entry["pruneReason"] = json!(value);
            }
            _ => {}
        }
    }
    for (index, entry) in entries.iter_mut().enumerate() {
        entry["isMain"] = json!(index == 0);
    }
    entries
}

fn normalized_path_key(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_ascii_lowercase()
}

fn pseudo_diff_for_untracked(root: &Path, rel_path: &str) -> Result<Option<String>> {
    let target = safe_child(root, rel_path)?;
    let metadata = fs::metadata(&target)?;
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !metadata.is_file()
        || metadata.len() > MAX_UNTRACKED_PREVIEW_BYTES
        || !TEXT_EXTENSIONS.contains(&extension.as_str())
    {
        return Ok(None);
    }
    let raw = fs::read(&target)?;
    if raw.contains(&0) {
        return Ok(None);
    }
    let content = String::from_utf8_lossy(&raw);
    if content.is_empty() {
        return Ok(None);
    }
    let all_lines = content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    let lines = all_lines.iter().take(420).copied().collect::<Vec<_>>();
    let path = rel_path.replace('\\', "/");
    let mut preview = vec![
        format!("diff --git a/{path} b/{path}"),
        "new file mode 100644".to_string(),
        "--- /dev/null".to_string(),
        format!("+++ b/{path}"),
        format!("@@ -0,0 +1,{} @@", lines.len().max(1)),
    ];
    preview.extend(lines.into_iter().map(|line| format!("+{line}")));
    if all_lines.len() > 420 {
        preview.push("+...".to_string());
    }
    Ok(Some(preview.join("\n")))
}

fn load_workspace_file_context(data_dir: &Path, workspace_id: &str) -> Result<WorkspaceGitContext> {
    load_workspace_git_context(data_dir, workspace_id)
}

fn read_workspace_file(
    data_dir: &Path,
    workspace_id: &str,
    request: &ParsedRequest,
) -> Result<Value> {
    let workspace = load_workspace_file_context(data_dir, workspace_id)?;
    let rel = request.query_parameter("path").unwrap_or_default();
    let target = safe_child(&workspace.root, &rel)?;
    if !target.is_file() {
        bail!("Workspace file path must be a file.");
    }
    file_result(
        &workspace.root,
        &target,
        workspace_id,
        &workspace.title,
        "read",
    )
}

fn preview_workspace_file(
    data_dir: &Path,
    workspace_id: &str,
    request: &ParsedRequest,
) -> Result<Value> {
    let workspace = load_workspace_file_context(data_dir, workspace_id)?;
    let rel = request.query_parameter("path").unwrap_or_default();
    let target = safe_child(&workspace.root, &rel)?;
    if !target.is_file() {
        bail!("Workspace file path must be a file.");
    }
    let mut result = file_result(
        &workspace.root,
        &target,
        workspace_id,
        &workspace.title,
        "read",
    )?;
    let text = result
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(12_000)
        .collect::<String>();
    result["preview"] = json!({
        "kind": "text",
        "document": { "text": text },
        "redaction": { "count": 0 }
    });
    result.as_object_mut().map(|object| object.remove("text"));
    Ok(result)
}

fn workspace_tree(data_dir: &Path, workspace_id: &str, request: &ParsedRequest) -> Result<Value> {
    let workspace = load_workspace_file_context(data_dir, workspace_id)?;
    let dir = request.query_parameter("dir").unwrap_or_default();
    let target = if dir.trim().is_empty() {
        workspace.root.clone()
    } else {
        safe_child(&workspace.root, &dir)?
    };
    if !target.is_dir() {
        bail!("Workspace tree path must be a directory.");
    }
    let entries = list_directory_entries(&workspace.root, &target, 240)?;
    Ok(json!({
        "ok": true,
        "workspace": workspace_json(workspace_id.to_string(), workspace.cwd, workspace.title, workspace.allowed_root, workspace.created_at, workspace.updated_at, workspace.last_used_at),
        "dir": relative(&workspace.root, &target),
        "items": entries,
        "entries": entries
    }))
}

fn list_directory_entries(root: &Path, dir: &Path, max_entries: usize) -> Result<Vec<Value>> {
    let mut entries = fs::read_dir(dir)
        .with_context(|| format!("Cannot read {}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| !matches!(name, ".git" | "node_modules" | "target"))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        let left_dir = left.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let right_dir = right.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });
    let mut items = Vec::new();
    let mut queue = entries
        .into_iter()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    while let Some(path) = queue.first().cloned() {
        queue.remove(0);
        if items.len() >= max_entries {
            break;
        }
        let metadata = fs::metadata(&path)?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let item = json!({
            "name": name,
            "path": relative(root, &path),
            "type": if metadata.is_dir() { "directory" } else { "file" },
            "size": metadata.len(),
            "updatedAt": DateTime::<Utc>::from(metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
        if metadata.is_dir() {
            let mut children = fs::read_dir(&path)?
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_str()
                        .is_some_and(|name| !matches!(name, ".git" | "node_modules" | "target"))
                })
                .collect::<Vec<_>>();
            children.sort_by(|left, right| {
                let left_dir = left.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
                let right_dir = right.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
                right_dir
                    .cmp(&left_dir)
                    .then_with(|| left.file_name().cmp(&right.file_name()))
            });
            for child in children.into_iter().rev() {
                queue.insert(0, child.path());
            }
        }
        items.push(item);
    }
    Ok(items)
}

fn workspace_context(data_dir: &Path, workspace_id: &str, payload: &Value) -> Result<Value> {
    let workspace = load_workspace_file_context(data_dir, workspace_id)?;
    let paths = payload
        .get("paths")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items = Vec::new();
    let mut errors = Vec::new();
    for path in paths.iter().take(20).filter_map(Value::as_str) {
        match context_for_path(&workspace.root, path) {
            Ok(item) => items.push(item),
            Err(error) => errors.push(json!({ "path": path, "error": error.to_string() })),
        }
    }
    let prompt = items
        .iter()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(json!({
        "ok": errors.is_empty(),
        "workspace": workspace_json(workspace_id.to_string(), workspace.cwd, workspace.title, workspace.allowed_root, workspace.created_at, workspace.updated_at, workspace.last_used_at),
        "items": items,
        "errors": errors,
        "prompt": prompt
    }))
}

fn context_for_path(root: &Path, rel: &str) -> Result<Value> {
    let target = safe_child(root, rel)?;
    let metadata = fs::metadata(&target)?;
    let path = relative(root, &target);
    if metadata.is_dir() {
        let entries = list_directory_entries(root, &target, 220)?;
        let lines = entries
            .iter()
            .filter_map(|entry| {
                Some(format!(
                    "{} {}",
                    if entry.get("type").and_then(Value::as_str) == Some("directory") {
                        "dir"
                    } else {
                        "file"
                    },
                    entry.get("path")?.as_str()?
                ))
            })
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(
            json!({ "type": "directory", "path": path, "text": format!("<directory path=\"{path}\">\n{lines}\n</directory>") }),
        );
    }
    if !metadata.is_file() || metadata.len() > 512 * 1024 {
        return Ok(
            json!({ "type": "file", "path": path, "text": format!("<file path=\"{path}\" size=\"{}\" binary_or_too_large=\"true\" />", metadata.len()) }),
        );
    }
    let raw = fs::read(&target)?;
    if raw.contains(&0) {
        return Ok(
            json!({ "type": "file", "path": path, "text": format!("<file path=\"{path}\" size=\"{}\" binary_or_too_large=\"true\" />", metadata.len()) }),
        );
    }
    let text = String::from_utf8_lossy(&raw)
        .chars()
        .take(12_000)
        .collect::<String>();
    Ok(
        json!({ "type": "file", "path": path, "text": format!("<file path=\"{path}\">\n{text}\n</file>") }),
    )
}

fn mutate_workspace_files_batch(
    data_dir: &Path,
    workspace_id: &str,
    payload: &Value,
    request: &ParsedRequest,
) -> Result<Value> {
    let operations = payload
        .get("operations")
        .or_else(|| payload.get("files"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mode = payload
        .get("mode")
        .and_then(Value::as_str)
        .filter(|value| *value == "best-effort")
        .unwrap_or("atomic");
    let mut items = Vec::new();
    for (index, operation) in operations.iter().enumerate() {
        let action = operation
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("write")
            .to_ascii_lowercase();
        match mutate_workspace(data_dir, workspace_id, &action, operation, request) {
            Ok(WorkspaceMutationOutcome::Success(mut value)) => {
                value["index"] = json!(index);
                value["ok"] = json!(true);
                items.push(value);
            }
            Ok(WorkspaceMutationOutcome::Conflict(mut value)) => {
                value["index"] = json!(index);
                value["ok"] = json!(false);
                if mode != "best-effort" {
                    bail!("Workspace batch mutation failed.");
                }
                items.push(value);
            }
            Err(error) => {
                if mode != "best-effort" {
                    return Err(error);
                }
                items.push(json!({ "ok": false, "index": index, "error": error.to_string() }));
            }
        }
    }
    Ok(json!({
        "ok": items.iter().all(|item| item.get("ok").and_then(Value::as_bool).unwrap_or(false)),
        "mode": mode,
        "workspaceId": workspace_id,
        "items": items,
        "results": items
    }))
}

fn open_workspace_in_explorer(data_dir: &Path, workspace_id: &str) -> Result<Value> {
    let workspace = load_workspace_file_context(data_dir, workspace_id)?;
    #[cfg(windows)]
    let _ = Command::new("explorer.exe")
        .arg(&workspace.root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    Ok(json!({
        "ok": true,
        "workspace": workspace_json(workspace_id.to_string(), workspace.cwd, workspace.title, workspace.allowed_root, workspace.created_at, workspace.updated_at, workspace.last_used_at),
        "path": workspace.root.to_string_lossy()
    }))
}

fn create_workspace_worktree(
    data_dir: &Path,
    workspace_id: &str,
    payload: &Value,
) -> Result<Value> {
    let source = load_workspace_file_context(data_dir, workspace_id)?;
    let repo_root = git_stdout(&source.root, &["rev-parse", "--show-toplevel"])?;
    let repo_root = canonical_root(Path::new(repo_root.trim()))?;
    let current_branch = git_stdout(&repo_root, &["branch", "--show-current"]).unwrap_or_default();
    let fallback_branch = if current_branch.trim().is_empty() {
        "worktree".to_string()
    } else {
        format!("{}-worktree", current_branch.trim())
    };
    let branch_name = clean_path_segment(
        payload
            .get("branchName")
            .or_else(|| payload.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(&fallback_branch),
        &fallback_branch,
    );
    let base_ref = payload
        .get("baseRef")
        .and_then(Value::as_str)
        .unwrap_or("HEAD")
        .trim();
    let target = payload
        .get("path")
        .and_then(Value::as_str)
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| {
            repo_root
                .parent()
                .unwrap_or_else(|| repo_root.as_path())
                .join(".vibelink-worktrees")
                .join(repo_root.file_name().unwrap_or_default())
                .join(&branch_name)
        });
    if target.exists() && fs::read_dir(&target)?.next().is_some() {
        bail!("Worktree path already exists and is not empty.");
    }
    let status = run_git(&repo_root, &["status", "--porcelain"])?;
    if !status.stdout.trim().is_empty() {
        bail!("Commit or stash local changes before creating a permanent worktree.");
    }
    let branch_exists = run_git(
        &repo_root,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch_name}"),
        ],
    )?
    .ok;
    let target_string = target.to_string_lossy().into_owned();
    let output = if branch_exists {
        run_git(
            &repo_root,
            &["worktree", "add", &target_string, &branch_name],
        )?
    } else {
        run_git(
            &repo_root,
            &[
                "worktree",
                "add",
                "-b",
                &branch_name,
                &target_string,
                base_ref,
            ],
        )?
    };
    if !output.ok {
        bail!("{}", output.stderr.trim());
    }
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&branch_name);
    let created = create_workspace(data_dir, &json!({ "path": target_string, "title": title }))?;
    Ok(json!({
        "ok": true,
        "action": "create-worktree",
        "sourceWorkspace": workspace_json(workspace_id.to_string(), source.cwd, source.title, source.allowed_root, source.created_at, source.updated_at, source.last_used_at),
        "workspace": created["workspace"].clone(),
        "cwd": repo_root.to_string_lossy(),
        "path": target.to_string_lossy(),
        "branchName": branch_name,
        "baseRef": base_ref,
        "branchExisted": branch_exists,
        "stdout": output.stdout,
        "stderr": output.stderr
    }))
}

fn apply_workspace_worktree_action(
    data_dir: &Path,
    workspace_id: &str,
    payload: &Value,
) -> Result<Value> {
    let source = load_workspace_file_context(data_dir, workspace_id)?;
    let target = payload
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Worktree path is required."))?;
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mut args = vec!["worktree", action.as_str()];
    match action.as_str() {
        "lock" => {
            args.push(target);
            if let Some(reason) = payload
                .get("reason")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                args.extend(["--reason", reason]);
            }
        }
        "unlock" | "remove" => args.push(target),
        "prune" => args.truncate(2),
        _ => bail!("Unsupported worktree action."),
    }
    let output = run_git(&source.root, &args)?;
    if !output.ok {
        bail!("{}", output.stderr.trim());
    }
    Ok(json!({
        "ok": true,
        "action": action,
        "workspaceId": workspace_id,
        "path": target,
        "stdout": output.stdout,
        "stderr": output.stderr,
        "worktrees": list_workspace_worktrees(data_dir, workspace_id)?["worktrees"].clone()
    }))
}

fn git_stdout(root: &Path, args: &[&str]) -> Result<String> {
    let result = run_git(root, args)?;
    if !result.ok {
        bail!("{}", result.stderr.trim());
    }
    Ok(result.stdout.trim().to_string())
}

fn clean_path_segment(value: &str, fallback: &str) -> String {
    let cleaned = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

type GitFileActionResult<T> = std::result::Result<T, (u16, String)>;

fn apply_workspace_git_action(
    data_dir: &Path,
    workspace_id: &str,
    action: &str,
    payload: &Value,
    request: &ParsedRequest,
) -> HttpRouteResponse {
    let context = match load_workspace_git_context(data_dir, workspace_id) {
        Ok(context) => context,
        Err(error) => {
            let message = error.to_string();
            return HttpRouteResponse::error(
                if message == "Workspace not found." {
                    404
                } else {
                    500
                },
                &message,
            );
        }
    };
    let db_path = data_dir.join("mobile-agent.sqlite");
    let connection = match Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(error) => return HttpRouteResponse::error(500, &error.to_string()),
    };
    if let Err(error) = connection.busy_timeout(Duration::from_secs(5)) {
        return HttpRouteResponse::error(500, &error.to_string());
    }
    let input = json!({
        "workspaceId": workspace_id,
        "action": action,
        "message": payload.get("message").and_then(Value::as_str).unwrap_or(""),
        "title": payload.get("title").and_then(Value::as_str).unwrap_or("")
    });
    let title = format!("git {}", if action.is_empty() { "action" } else { action });
    let tool_run_id = match create_started_workspace_tool_run(
        &connection,
        workspace_id,
        "workspace.git_action",
        &title,
        &input,
    ) {
        Ok(tool_run_id) => tool_run_id,
        Err(error) => return HttpRouteResponse::error(500, &error.to_string()),
    };
    let execution =
        perform_workspace_git_action(&context.root, action, payload).and_then(|output| {
            let mut summary = workspace_git_diff(data_dir, workspace_id)
                .map_err(|error| (500, error.to_string()))?;
            if let Some(object) = summary.as_object_mut() {
                object.remove("workspace");
                object.remove("cwd");
            }
            Ok(json!({
                "ok": true,
                "action": action,
                "workspace": {
                    "id": workspace_id,
                    "title": context.title,
                    "path": context.cwd,
                    "allowedRoot": context.allowed_root,
                    "createdAt": context.created_at,
                    "updatedAt": context.updated_at,
                    "lastUsedAt": context.last_used_at
                },
                "cwd": context.cwd,
                "stdout": output.stdout,
                "stderr": output.stderr,
                "summary": summary
            }))
        });
    match execution {
        Ok(result) => {
            if let Err(error) = complete_workspace_tool_run(
                &connection,
                &tool_run_id,
                workspace_id,
                "Git action completed.",
                &result,
            ) {
                return HttpRouteResponse::error(500, &error.to_string());
            }
            if let Err(error) = audit_workspace_action(
                &connection,
                request,
                WorkspaceAuditRecord {
                    event_type: "workspace.git_action",
                    target: &context.cwd,
                    action,
                    tool_run_id: &tool_run_id,
                    success: true,
                    reason: "",
                },
            ) {
                return HttpRouteResponse::error(500, &error.to_string());
            }
            let mut response = result;
            response["toolRunId"] = json!(tool_run_id);
            HttpRouteResponse::json(200, response)
        }
        Err((status, message)) => {
            let _ = fail_workspace_tool_run(&connection, &tool_run_id, workspace_id, &message);
            let _ = audit_workspace_action(
                &connection,
                request,
                WorkspaceAuditRecord {
                    event_type: "workspace.git_action",
                    target: workspace_id,
                    action,
                    tool_run_id: &tool_run_id,
                    success: false,
                    reason: &message,
                },
            );
            HttpRouteResponse::error(status, &message)
        }
    }
}

fn perform_workspace_git_action(
    root: &Path,
    action: &str,
    payload: &Value,
) -> GitFileActionResult<GitCommandResult> {
    let result = match action {
        "stage-all" => run_git(root, &["add", "-A"]),
        "unstage-all" => run_git(root, &["restore", "--staged", "."]),
        "branch-create" | "branch-switch" => {
            let branch_name = payload
                .get("branchName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if branch_name.is_empty() {
                return Err((400, "Branch name is required.".to_string()));
            }
            let valid = run_git(root, &["check-ref-format", "--branch", branch_name])
                .map_err(|error| (400, error.to_string()))?;
            if !valid.ok {
                return Err((
                    400,
                    if valid.stderr.is_empty() {
                        "Invalid branch name.".to_string()
                    } else {
                        valid.stderr.trim().to_string()
                    },
                ));
            }
            if action == "branch-create" {
                let base_ref = payload
                    .get("baseRef")
                    .and_then(Value::as_str)
                    .unwrap_or("HEAD")
                    .trim();
                let base_ref = if base_ref.is_empty() {
                    "HEAD"
                } else {
                    base_ref
                };
                let commit_ref = format!("{base_ref}^{{commit}}");
                let resolved = run_git(
                    root,
                    &[
                        "rev-parse",
                        "--verify",
                        "--end-of-options",
                        commit_ref.as_str(),
                    ],
                )
                .map_err(|error| (400, error.to_string()))?;
                if !resolved.ok {
                    return Err((
                        400,
                        if resolved.stderr.is_empty() {
                            "Base ref was not found.".to_string()
                        } else {
                            resolved.stderr.trim().to_string()
                        },
                    ));
                }
                run_git(root, &["switch", "-c", branch_name, resolved.stdout.trim()])
            } else {
                run_git(root, &["switch", branch_name])
            }
        }
        "stash-push" => {
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if message.is_empty() {
                run_git(root, &["stash", "push", "-u"])
            } else {
                run_git(root, &["stash", "push", "-u", "-m", message])
            }
        }
        "stash-pop" => run_git(root, &["stash", "pop"]),
        "commit" => {
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if message.is_empty() {
                return Err((400, "Commit message is required.".to_string()));
            }
            run_git(root, &["commit", "-m", message])
        }
        "push" => run_git(root, &["push"]),
        "pull" => run_git(root, &["pull", "--ff-only"]),
        "pr" => {
            let title = payload
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if title.is_empty() {
                run_program(root, "gh", &["pr", "create", "--fill"])
            } else {
                run_program(root, "gh", &["pr", "create", "--fill", "--title", title])
            }
        }
        _ => return Err((400, "Unsupported git action.".to_string())),
    }
    .map_err(|error| (409, error.to_string()))?;
    if result.ok {
        Ok(result)
    } else {
        Err((
            409,
            if !result.stderr.is_empty() {
                result.stderr.trim().to_string()
            } else if !result.stdout.is_empty() {
                result.stdout.trim().to_string()
            } else {
                "Git action failed.".to_string()
            },
        ))
    }
}

fn run_program(cwd: &Path, program: &str, args: &[&str]) -> Result<GitCommandResult> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("Failed to run {program} {}", args.join(" ")))?;
    if output.stdout.len().saturating_add(output.stderr.len()) > MAX_GIT_OUTPUT_BYTES {
        bail!("{program} output exceeds 10 MiB.");
    }
    Ok(GitCommandResult {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(1),
    })
}

fn create_started_workspace_tool_run(
    connection: &Connection,
    workspace_id: &str,
    tool_name: &str,
    title: &str,
    input: &Value,
) -> Result<String> {
    let tool_run_id = uuid::Uuid::new_v4().to_string();
    let created_at = now_iso();
    connection.execute(
        "INSERT INTO tool_runs (id,task_id,workspace_id,tool_name,status,title,input_json,result_json,error,created_at,updated_at,started_at,completed_at) VALUES (?1,'',?2,?3,'pending',?4,?5,'null','',?6,?6,'','')",
        params![tool_run_id, workspace_id, tool_name, title, input.to_string(), created_at],
    )?;
    insert_workspace_tool_event(
        connection,
        &tool_run_id,
        workspace_id,
        "tool.created",
        title,
        json!({
            "toolName": tool_name,
            "tool": {"name": tool_name, "kind": "git"},
            "taskId": "",
            "workspaceId": workspace_id,
            "kind": "git",
            "input": input
        }),
    )?;
    let started_at = now_iso();
    connection.execute(
        "UPDATE tool_runs SET status = 'running', updated_at = ?1, started_at = ?1 WHERE id = ?2",
        params![started_at, tool_run_id],
    )?;
    insert_workspace_tool_event(
        connection,
        &tool_run_id,
        workspace_id,
        "tool.started",
        title,
        json!({"input": input}),
    )?;
    Ok(tool_run_id)
}

fn complete_workspace_tool_run(
    connection: &Connection,
    tool_run_id: &str,
    workspace_id: &str,
    text: &str,
    result: &Value,
) -> Result<()> {
    let completed_at = now_iso();
    connection.execute(
        "UPDATE tool_runs SET status = 'completed', result_json = ?1, error = '', updated_at = ?2, completed_at = ?2 WHERE id = ?3",
        params![result.to_string(), completed_at, tool_run_id],
    )?;
    insert_workspace_tool_event(
        connection,
        tool_run_id,
        workspace_id,
        "tool.completed",
        text,
        json!({
            "exitCode": 0,
            "ok": true,
            "cancelled": false,
            "timedOut": false,
            "stdout": result.get("stdout").and_then(Value::as_str).unwrap_or(""),
            "stderr": result.get("stderr").and_then(Value::as_str).unwrap_or(""),
            "result": result
        }),
    )
}

fn fail_workspace_tool_run(
    connection: &Connection,
    tool_run_id: &str,
    workspace_id: &str,
    message: &str,
) -> Result<()> {
    let completed_at = now_iso();
    connection.execute(
        "UPDATE tool_runs SET status = 'failed', error = ?1, updated_at = ?2, completed_at = ?2 WHERE id = ?3",
        params![message, completed_at, tool_run_id],
    )?;
    insert_workspace_tool_event(
        connection,
        tool_run_id,
        workspace_id,
        "tool.error",
        message,
        json!({"error": message}),
    )
}

struct WorkspaceAuditRecord<'a> {
    event_type: &'a str,
    target: &'a str,
    action: &'a str,
    tool_run_id: &'a str,
    success: bool,
    reason: &'a str,
}

fn audit_workspace_action(
    connection: &Connection,
    request: &ParsedRequest,
    record: WorkspaceAuditRecord<'_>,
) -> Result<()> {
    let at = now_iso();
    let meta = json!({
        "action": record.action,
        "toolRunId": record.tool_run_id,
        "reason": record.reason
    });
    connection.execute(
        "INSERT INTO audit_log (event_type,event_at,method,path,success,target,meta_json,created_at) VALUES (?1,?2,'POST',?3,?4,?5,?6,?2)",
        params![
            record.event_type,
            at,
            request.path(),
            if record.success { 1 } else { 0 },
            record.target,
            meta.to_string()
        ],
    )?;
    Ok(())
}

fn apply_workspace_git_file_action(
    data_dir: &Path,
    workspace_id: &str,
    payload: &Value,
    request: &ParsedRequest,
) -> HttpRouteResponse {
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let rel_path = payload
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .replace('\\', "/");
    let context = match load_workspace_git_context(data_dir, workspace_id) {
        Ok(context) => context,
        Err(error) => {
            let message = error.to_string();
            let status = if message == "Workspace not found." {
                404
            } else {
                500
            };
            return HttpRouteResponse::error(status, &message);
        }
    };
    let db_path = data_dir.join("mobile-agent.sqlite");
    let connection = match Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(error) => return HttpRouteResponse::error(500, &error.to_string()),
    };
    if let Err(error) = connection.busy_timeout(Duration::from_secs(5)) {
        return HttpRouteResponse::error(500, &error.to_string());
    }
    let tool_run_id = uuid::Uuid::new_v4().to_string();
    let title = format!(
        "{} {}",
        if action.is_empty() {
            "file-action"
        } else {
            &action
        },
        rel_path
    );
    let input = json!({
        "workspaceId": workspace_id,
        "action": action,
        "path": rel_path
    });
    let created_at = now_iso();
    if let Err(error) = connection.execute(
        "INSERT INTO tool_runs (id,task_id,workspace_id,tool_name,status,title,input_json,result_json,error,created_at,updated_at,started_at,completed_at) VALUES (?1,'',?2,'workspace.git_file_action','pending',?3,?4,'null','',?5,?5,'','')",
        params![tool_run_id, workspace_id, title, input.to_string(), created_at],
    ) {
        return HttpRouteResponse::error(500, &error.to_string());
    }
    if let Err(error) = insert_workspace_tool_event(
        &connection,
        &tool_run_id,
        workspace_id,
        "tool.created",
        &title,
        json!({
            "toolName": "workspace.git_file_action",
            "tool": {
                "name": "workspace.git_file_action",
                "kind": "git",
                "label": "Git file action",
                "permission": "workspace.git",
                "risk": "medium"
            },
            "taskId": "",
            "workspaceId": workspace_id,
            "kind": "git",
            "input": input
        }),
    ) {
        return HttpRouteResponse::error(500, &error.to_string());
    }
    let started_at = now_iso();
    if let Err(error) = connection.execute(
        "UPDATE tool_runs SET status = 'running', updated_at = ?1, started_at = ?1 WHERE id = ?2",
        params![started_at, tool_run_id],
    ) {
        return HttpRouteResponse::error(500, &error.to_string());
    }
    if let Err(error) = insert_workspace_tool_event(
        &connection,
        &tool_run_id,
        workspace_id,
        "tool.started",
        &title,
        json!({"input": input}),
    ) {
        return HttpRouteResponse::error(500, &error.to_string());
    }

    let execution = perform_workspace_git_file_action(&context.root, &action, &rel_path, payload)
        .and_then(|_| {
            let mut summary = workspace_git_diff(data_dir, workspace_id)
                .map_err(|error| (500, error.to_string()))?;
            if let Some(object) = summary.as_object_mut() {
                object.remove("workspace");
                object.remove("cwd");
            }
            Ok(json!({
                "ok": true,
                "action": action,
                "path": rel_path,
                "workspace": {
                    "id": workspace_id,
                    "title": context.title,
                    "path": context.cwd,
                    "allowedRoot": context.allowed_root,
                    "createdAt": context.created_at,
                    "updatedAt": context.updated_at,
                    "lastUsedAt": context.last_used_at
                },
                "cwd": context.cwd,
                "summary": summary
            }))
        });

    match execution {
        Ok(result) => {
            let completed_at = now_iso();
            if let Err(error) = connection.execute(
                "UPDATE tool_runs SET status = 'completed', result_json = ?1, error = '', updated_at = ?2, completed_at = ?2 WHERE id = ?3",
                params![result.to_string(), completed_at, tool_run_id],
            ) {
                return HttpRouteResponse::error(500, &error.to_string());
            }
            if let Err(error) = insert_workspace_tool_event(
                &connection,
                &tool_run_id,
                workspace_id,
                "tool.completed",
                "Git file action completed.",
                json!({
                    "exitCode": 0,
                    "ok": true,
                    "cancelled": false,
                    "timedOut": false,
                    "stdout": "",
                    "stderr": "",
                    "result": result
                }),
            ) {
                return HttpRouteResponse::error(500, &error.to_string());
            }
            if let Err(error) = audit_workspace_git_file_action(
                &connection,
                request,
                &rel_path,
                &action,
                &tool_run_id,
                true,
                "",
            ) {
                return HttpRouteResponse::error(500, &error.to_string());
            }
            let mut response = result;
            response["toolRunId"] = json!(tool_run_id);
            HttpRouteResponse::json(200, response)
        }
        Err((status, message)) => {
            let completed_at = now_iso();
            let _ = connection.execute(
                "UPDATE tool_runs SET status = 'failed', error = ?1, updated_at = ?2, completed_at = ?2 WHERE id = ?3",
                params![message, completed_at, tool_run_id],
            );
            let _ = insert_workspace_tool_event(
                &connection,
                &tool_run_id,
                workspace_id,
                "tool.error",
                &message,
                json!({"error": message}),
            );
            let _ = audit_workspace_git_file_action(
                &connection,
                request,
                &rel_path,
                &action,
                &tool_run_id,
                false,
                &message,
            );
            HttpRouteResponse::error(status, &message)
        }
    }
}

fn perform_workspace_git_file_action(
    root: &Path,
    action: &str,
    rel_path: &str,
    payload: &Value,
) -> GitFileActionResult<()> {
    if rel_path.is_empty() || rel_path == "." {
        return Err((400, "File path is required.".to_string()));
    }
    if Path::new(rel_path).is_absolute()
        || Path::new(rel_path)
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err((403, "Path is outside workspace.".to_string()));
    }
    let target = safe_child(root, rel_path).map_err(|error| (403, error.to_string()))?;
    match action {
        "stage" | "accept" => {
            require_git_success(
                run_git(root, &["add", "--", rel_path]),
                "Failed to stage file.",
            )?;
        }
        "mark-resolved" => {
            require_git_success(
                run_git(root, &["add", "--", rel_path]),
                "Failed to mark the conflict as resolved.",
            )?;
        }
        "restore" | "reject" => {
            let status = run_git(root, &["status", "--porcelain=v1", "-b"])
                .map_err(|error| (409, error.to_string()))?;
            let file_status = parse_git_status_files(&status.stdout)
                .into_iter()
                .find(|(_, path)| path == rel_path)
                .map(|(status, _)| status)
                .unwrap_or_default();
            if file_status == "??" {
                if target.exists() {
                    let metadata =
                        fs::symlink_metadata(&target).map_err(|error| (409, error.to_string()))?;
                    if metadata.is_dir() {
                        fs::remove_dir_all(&target).map_err(|error| (409, error.to_string()))?;
                    } else {
                        fs::remove_file(&target).map_err(|error| (409, error.to_string()))?;
                    }
                }
            } else {
                require_git_success(
                    run_git(root, &["restore", "--staged", "--worktree", "--", rel_path]),
                    "Failed to restore file.",
                )?;
            }
        }
        "unstage" => {
            require_git_success(
                run_git(root, &["restore", "--staged", "--", rel_path]),
                "Failed to unstage file.",
            )?;
        }
        "use-ours" | "use-theirs" => {
            let side = if action == "use-ours" {
                "--ours"
            } else {
                "--theirs"
            };
            require_git_success(
                run_git(root, &["checkout", side, "--", rel_path]),
                "Failed to select the conflict side.",
            )?;
            require_git_success(
                run_git(root, &["add", "--", rel_path]),
                "Failed to mark the conflict as resolved.",
            )?;
        }
        "stage-hunk" | "unstage-hunk" => {
            let patch = validated_git_hunk_patch(
                payload.get("patch").and_then(Value::as_str).unwrap_or(""),
                rel_path,
            )?;
            let mut args = vec!["apply", "--cached", "--unidiff-zero"];
            if action == "unstage-hunk" {
                args.push("--reverse");
            }
            args.push("-");
            require_git_success(
                run_git_with_input(root, &args, patch.as_bytes()),
                "Failed to apply git hunk.",
            )?;
        }
        _ => return Err((400, "Unsupported git file action.".to_string())),
    }
    Ok(())
}

fn require_git_success(
    result: Result<GitCommandResult>,
    fallback: &str,
) -> GitFileActionResult<()> {
    let result = result.map_err(|error| (409, error.to_string()))?;
    if result.ok {
        Ok(())
    } else {
        Err((
            409,
            if result.stderr.is_empty() {
                fallback.to_string()
            } else {
                result.stderr.trim().to_string()
            },
        ))
    }
}

fn run_git_with_input(cwd: &Path, args: &[&str], input: &[u8]) -> Result<GitCommandResult> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to run git {}", args.join(" ")))?;
    child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("Git stdin is unavailable."))?
        .write_all(input)?;
    let output = child.wait_with_output()?;
    if output.stdout.len().saturating_add(output.stderr.len()) > MAX_GIT_OUTPUT_BYTES {
        bail!("Git output exceeds 10 MiB.");
    }
    Ok(GitCommandResult {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(1),
    })
}

fn validated_git_hunk_patch(patch: &str, rel_path: &str) -> GitFileActionResult<String> {
    if patch.trim().is_empty() {
        return Err((400, "Git hunk patch is required.".to_string()));
    }
    if patch.len() > MAX_UNTRACKED_PREVIEW_BYTES as usize {
        return Err((413, "Git hunk patch is too large.".to_string()));
    }
    let normalized = rel_path.replace('\\', "/");
    let plain = format!("diff --git a/{normalized} b/{normalized}");
    let quoted_a = serde_json::to_string(&format!("a/{normalized}")).unwrap_or_default();
    let quoted_b = serde_json::to_string(&format!("b/{normalized}")).unwrap_or_default();
    let quoted = format!("diff --git {quoted_a} {quoted_b}");
    let headers = patch
        .lines()
        .filter(|line| line.starts_with("diff --git "))
        .collect::<Vec<_>>();
    if headers.len() != 1 || (headers[0] != plain && headers[0] != quoted) {
        return Err((
            400,
            "Git hunk patch must target exactly the requested file.".to_string(),
        ));
    }
    Ok(if patch.ends_with('\n') {
        patch.to_string()
    } else {
        format!("{patch}\n")
    })
}

fn insert_workspace_tool_event(
    connection: &Connection,
    tool_run_id: &str,
    workspace_id: &str,
    event_type: &str,
    text: &str,
    payload: Value,
) -> Result<()> {
    let event_id = uuid::Uuid::new_v4().to_string();
    let at = now_iso();
    let lifecycle = match event_type {
        "tool.created" => "created",
        "tool.started" => "running",
        "tool.completed" => "completed",
        "tool.failed" | "tool.error" => "failed",
        _ => "event",
    };
    let event = json!({
        "id": event_id,
        "at": at,
        "type": event_type,
        "text": text,
        "payload": payload,
        "lifecycle": lifecycle,
        "sourceConfidence": "authoritative",
        "toolRunId": tool_run_id,
        "taskId": "",
        "workspaceId": workspace_id
    });
    connection.execute(
        "INSERT OR IGNORE INTO tool_events (tool_run_id,task_id,workspace_id,event_id,event_type,event_at,text,payload_json,event_json,created_at) VALUES (?1,'',?2,?3,?4,?5,?6,?7,?8,?5)",
        params![
            tool_run_id,
            workspace_id,
            event_id,
            event_type,
            at,
            text,
            payload.to_string(),
            event.to_string()
        ],
    )?;
    Ok(())
}

fn audit_workspace_git_file_action(
    connection: &Connection,
    request: &ParsedRequest,
    rel_path: &str,
    action: &str,
    tool_run_id: &str,
    success: bool,
    reason: &str,
) -> Result<()> {
    let at = now_iso();
    let meta = json!({
        "action": action,
        "toolRunId": tool_run_id,
        "reason": reason
    });
    connection.execute(
        "INSERT INTO audit_log (event_type,event_at,method,path,success,target,meta_json,created_at) VALUES ('workspace.git_file_action',?1,'POST',?2,?3,?4,?5,?1)",
        params![at, request.path(), if success { 1 } else { 0 }, rel_path, meta.to_string()],
    )?;
    Ok(())
}

fn workspace_path_parts(path: &str) -> Option<(String, &str)> {
    let rest = path.strip_prefix("/api/workspaces/")?;
    let (id, suffix) = rest.split_once('/')?;
    if id.is_empty() || id.contains('%') {
        return None;
    }
    Some((id.to_string(), suffix))
}

enum WorkspaceMutationOutcome {
    Success(Value),
    Conflict(Value),
}

fn mutate_workspace(
    data_dir: &Path,
    workspace_id: &str,
    action: &str,
    payload: &Value,
    request: &ParsedRequest,
) -> Result<WorkspaceMutationOutcome> {
    let db_path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", db_path.display()))?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let (root, title) = connection
        .query_row(
            "SELECT path, title FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("Workspace not found."))?;
    let root = canonical_root(Path::new(&root))?;
    let rel = payload.get("path").and_then(Value::as_str).unwrap_or("");
    let target = safe_child(&root, rel)?;
    if let Some(conflict) =
        workspace_revision_conflict(&root, &target, workspace_id, &title, payload, request)?
    {
        return Ok(WorkspaceMutationOutcome::Conflict(conflict));
    }
    let result = match action {
        "write" => {
            let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
            if text.len() > MAX_BODY_BYTES {
                bail!("Workspace file text is too large.");
            }
            if target.exists() && !target.is_file() {
                bail!("Workspace file path must be a file.");
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&target, text.as_bytes())?;
            file_result(&root, &target, workspace_id, &title, "write")?
        }
        "delete" => {
            if !target.is_file() {
                bail!("Workspace file path must be a file.");
            }
            fs::remove_file(&target)?;
            json!({"ok":true,"action":"delete","workspace":{"id":workspace_id,"title":title},"path":relative(&root, &target)})
        }
        "rename" => {
            if !target.exists() {
                bail!("Workspace file path does not exist.");
            }
            let next = safe_child(
                &root,
                payload
                    .get("nextPath")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            )?;
            if next.exists() {
                bail!("Workspace destination already exists.");
            }
            if let Some(parent) = next.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(&target, &next)?;
            let mut value = file_result(&root, &next, workspace_id, &title, "rename")?;
            value["previousPath"] = Value::String(relative(&root, &target));
            value
        }
        _ => bail!("Unsupported workspace file action."),
    };
    let now = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs()
    );
    let meta = json!({"action": action, "path": rel});
    let _ = connection.execute(
        "INSERT INTO audit_log (event_type,event_at,method,path,success,target,meta_json,created_at) VALUES ('workspace.file',?1,'POST',?2,1,?3,?4,?1)",
        params![now, format!("/api/workspaces/{workspace_id}/file"), rel, meta.to_string()],
    );
    Ok(WorkspaceMutationOutcome::Success(result))
}

fn workspace_revision_conflict(
    root: &Path,
    target: &Path,
    workspace_id: &str,
    title: &str,
    payload: &Value,
    request: &ParsedRequest,
) -> Result<Option<Value>> {
    let require_absent = request
        .header("if-none-match")
        .is_some_and(|value| value.trim() == "*")
        || payload
            .get("requireAbsent")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let expected = payload
        .get("expectedRevision")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| revision_from_if_match(request.header("if-match")));
    if !require_absent && expected.is_none() {
        return Ok(None);
    }

    let current = target
        .is_file()
        .then(|| file_result(root, target, workspace_id, title, "read"))
        .transpose()?;
    let actual = current
        .as_ref()
        .and_then(|value| value.get("revision"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let matches = if require_absent {
        current.is_none()
    } else {
        expected.as_deref() == actual.as_deref()
    };
    if matches {
        return Ok(None);
    }
    Ok(Some(json!({
        "error": "Workspace file changed on another device.",
        "code": "WORKSPACE_FILE_CONFLICT",
        "path": relative(root, target),
        "expectedRevision": expected,
        "actualRevision": actual,
        "current": current
    })))
}

fn revision_from_if_match(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    let value = value.strip_prefix("W/").unwrap_or(value);
    value
        .strip_prefix("\"vibelink:workspace-file:")
        .and_then(|value| value.strip_suffix('"'))
        .map(str::to_string)
        .or_else(|| Some("invalid-etag".to_string()))
}

fn canonical_root(path: &Path) -> Result<PathBuf> {
    let root = fs::canonicalize(path)
        .with_context(|| format!("Workspace root does not exist: {}", path.display()))?;
    if !root.is_dir() {
        bail!("Workspace root is not a directory.");
    }
    Ok(root)
}

fn safe_child(root: &Path, value: &str) -> Result<PathBuf> {
    if value.trim().is_empty() {
        bail!("Workspace file path is required.");
    }
    let candidate = Path::new(value);
    if candidate.is_absolute()
        || candidate.components().any(|item| {
            matches!(
                item,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        bail!("Path is outside workspace.");
    }
    let target = root.join(candidate);
    if let Some(existing) = target.parent().filter(|path| path.exists()) {
        let parent = fs::canonicalize(existing)?;
        if !parent.starts_with(root) {
            bail!("Path is outside workspace.");
        }
    }
    Ok(target)
}

fn relative(root: &Path, target: &Path) -> String {
    target
        .strip_prefix(root)
        .unwrap_or(target)
        .to_string_lossy()
        .replace('\\', "/")
}

fn file_result(
    root: &Path,
    target: &Path,
    workspace_id: &str,
    title: &str,
    action: &str,
) -> Result<Value> {
    let metadata = fs::metadata(target)?;
    let content = fs::read(target)?;
    let revision = format!("{:x}", Sha256::digest(&content));
    let etag = format!("\"vibelink:workspace-file:{revision}\"");
    Ok(json!({
        "ok": true,
        "action": action,
        "workspace": {"id":workspace_id,"title":title},
        "path": relative(root,target),
        "size": metadata.len(),
        "revision": revision,
        "etag": etag,
        "text": String::from_utf8_lossy(&content).to_string()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::Connection;

    fn fixture() -> (PathBuf, WorkspaceRouteConfig, String) {
        let dir = std::env::temp_dir().join(format!(
            "vibelink-workspace-http-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.join("workspace");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            dir.join("settings.json"),
            r#"{"pairingToken":"pair","hostAllowlist":[]}"#,
        )
        .unwrap();
        let db = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE devices(id TEXT PRIMARY KEY,label TEXT,token_hash TEXT UNIQUE,created_at TEXT,last_seen_at TEXT,revoked_at TEXT,expires_at TEXT,rotated_at TEXT,meta_json TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT,title TEXT,allowed_root TEXT,created_at TEXT,updated_at TEXT,last_used_at TEXT); CREATE TABLE audit_log(cursor INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT,event_at TEXT,method TEXT,path TEXT,success INTEGER,target TEXT,meta_json TEXT,created_at TEXT); CREATE TABLE tool_runs(id TEXT PRIMARY KEY,task_id TEXT,workspace_id TEXT,tool_name TEXT NOT NULL,status TEXT NOT NULL,title TEXT,input_json TEXT,result_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,started_at TEXT,completed_at TEXT); CREATE TABLE tool_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,tool_run_id TEXT NOT NULL,task_id TEXT,workspace_id TEXT,event_id TEXT NOT NULL,event_type TEXT NOT NULL,event_at TEXT NOT NULL,text TEXT,payload_json TEXT,event_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tool_run_id,event_id)); CREATE TABLE approval_requests(id TEXT PRIMARY KEY,tool_run_id TEXT,task_id TEXT,workspace_id TEXT,kind TEXT NOT NULL,status TEXT NOT NULL,title TEXT,reason TEXT,request_json TEXT,risk_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT,decided_at TEXT,decided_by_device_id TEXT,decision_reason TEXT,decision_json TEXT);").unwrap();
        db.execute(
            "INSERT INTO devices VALUES ('d','Device',?1,'now',NULL,NULL,NULL,NULL,NULL)",
            params![hash_token("token")],
        )
        .unwrap();
        db.execute(
            "INSERT INTO workspaces VALUES ('w',?1,'Workspace',?1,'now','now',NULL)",
            params![root.to_string_lossy()],
        )
        .unwrap();
        (
            dir.clone(),
            WorkspaceRouteConfig::new(dir),
            root.to_string_lossy().to_string(),
        )
    }

    #[test]
    fn lists_creates_reads_trees_previews_and_batches_workspace_files_in_rust() {
        let (dir, config, root) = fixture();
        let list = parse_request(
            b"GET /api/workspaces HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n",
        )
        .unwrap();
        let listed = route_workspace_request(&list, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(listed.status, 200);
        assert_eq!(listed.body["items"][0]["id"], "w");

        let new_root = Path::new(&root).parent().unwrap().join("created");
        fs::create_dir_all(&new_root).unwrap();
        let create = parse_request(
            b"POST /api/workspaces HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        let create_body = format!(
            r#"{{"path":"{}","title":"Created"}}"#,
            new_root.to_string_lossy().replace('\\', "\\\\")
        );
        let created = route_workspace_request(&create, Some(create_body.as_bytes()), &config)
            .unwrap()
            .unwrap();
        assert_eq!(created.status, 201);
        let created_id = created.body["workspace"]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let batch = parse_request(
            format!("POST /api/workspaces/{created_id}/files/batch HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let batched = route_workspace_request(
            &batch,
            Some(br##"{"files":[{"path":"src/main.txt","text":"hello\n"},{"path":"README.md","text":"# Created\n"}]}"##),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(batched.status, 200);
        assert_eq!(batched.body["results"].as_array().unwrap().len(), 2);

        let read = parse_request(
            format!("GET /api/workspaces/{created_id}/file?path=src/main.txt HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let file = route_workspace_request(&read, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(file.status, 200);
        assert_eq!(file.body["text"], "hello\n");

        let preview = parse_request(
            format!("GET /api/workspaces/{created_id}/file/preview?path=README.md HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let previewed = route_workspace_request(&preview, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(previewed.status, 200);
        assert_eq!(previewed.body["preview"]["kind"], "text");

        let tree = parse_request(
            format!("GET /api/workspaces/{created_id}/tree HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let tree = route_workspace_request(&tree, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(tree.status, 200);
        assert!(tree.body["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "src/main.txt"));

        let context = parse_request(
            format!("POST /api/workspaces/{created_id}/context HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let context = route_workspace_request(
            &context,
            Some(br#"{"paths":["src/main.txt","."]}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(context.status, 200);
        assert_eq!(context.body["workspace"]["id"], created_id);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn creates_and_mutates_worktrees_in_rust() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "VibeLink Test"]);
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-m", "base"]);

        let target = root.parent().unwrap().join("linked-worktree");
        let create = parse_request(
            b"POST /api/workspaces/w/worktrees HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        let create_body = format!(
            r#"{{"branchName":"feature-rust","path":"{}"}}"#,
            target.to_string_lossy().replace('\\', "\\\\")
        );
        let created = route_workspace_request(&create, Some(create_body.as_bytes()), &config)
            .unwrap()
            .unwrap();
        assert_eq!(created.status, 200);
        assert_eq!(created.body["action"], "create-worktree");
        assert!(target.join("tracked.txt").exists());

        let action = parse_request(
            b"POST /api/workspaces/w/worktrees/action HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        let lock_body = format!(
            r#"{{"action":"lock","path":"{}","reason":"rust test"}}"#,
            target.to_string_lossy().replace('\\', "\\\\")
        );
        let locked = route_workspace_request(&action, Some(lock_body.as_bytes()), &config)
            .unwrap()
            .unwrap();
        assert_eq!(locked.status, 200);
        assert_eq!(locked.body["action"], "lock");
        assert!(locked.body["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["locked"] == true));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn executes_workspace_command_and_records_tool_run_state() {
        let (dir, config, root) = fixture();
        let command = parse_request(
            b"POST /api/workspaces/w/command HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        let body: &[u8] = if cfg!(windows) {
            br#"{"command":"Write-Output hello","kind":"terminal"}"#
        } else {
            br#"{"command":"printf hello","kind":"terminal"}"#
        };
        let response = route_workspace_request(&command, Some(body), &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert!(response.body["stdout"].as_str().unwrap().contains("hello"));
        let connection = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        let status: String = connection
            .query_row("SELECT status FROM tool_runs ORDER BY created_at DESC LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM tool_events WHERE workspace_id = 'w' AND event_type = 'tool.completed'", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(response.body["workspace"]["path"], root);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn requests_approval_for_dangerous_commands() {
        let (dir, config, _root) = fixture();
        let command = parse_request(
            b"POST /api/workspaces/w/command HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        let response = route_workspace_request(
            &command,
            Some(br#"{"command":"rm -rf important","kind":"terminal"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 428);
        let approval_id = response.body["approvalId"].as_str().unwrap();
        let approvals = parse_request(
            b"GET /api/approvals HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n",
        )
        .unwrap();
        let listed = route_workspace_request(&approvals, None, &config)
            .unwrap()
            .unwrap();
        assert!(listed.body["approvals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|approval| approval["id"] == approval_id));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn writes_renames_and_deletes_only_inside_workspace() {
        let (dir, config, _root) = fixture();
        let request = parse_request(b"POST /api/workspaces/w/file HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let written = route_workspace_request(
            &request,
            Some(br#"{"path":"src/a.txt","text":"hello"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(written.status, 200);
        let renamed = route_workspace_request(
            &request,
            Some(br#"{"action":"rename","path":"src/a.txt","nextPath":"src/b.txt"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(renamed.status, 200);
        let deleted = route_workspace_request(
            &request,
            Some(br#"{"action":"delete","path":"src/b.txt"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(deleted.status, 200);
        assert!(route_workspace_request(
            &request,
            Some(br#"{"path":"../escape","text":"x"}"#),
            &config
        )
        .is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rename_failure_after_side_effect_returns_error_without_repeating_mutation() {
        let (dir, config, root) = fixture();
        let request = parse_request(b"POST /api/workspaces/w/file HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        route_workspace_request(
            &request,
            Some(br#"{"path":"before.txt","text":"rename once"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        inject_post_file_mutation_failure_once(&config);
        let result = route_workspace_request(
            &request,
            Some(br#"{"action":"rename","path":"before.txt","nextPath":"after.txt"}"#),
            &config,
        );
        assert!(result.is_err());
        assert!(!Path::new(&root).join("before.txt").exists());
        assert_eq!(
            fs::read_to_string(Path::new(&root).join("after.txt")).unwrap(),
            "rename once"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_a_stale_second_device_workspace_write() {
        let (dir, config, _root) = fixture();
        let request = parse_request(b"POST /api/workspaces/w/file HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let created = route_workspace_request(
            &request,
            Some(br#"{"path":"notes.txt","text":"base\n"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        let revision = created.body["revision"].as_str().unwrap().to_string();
        let etag = created.header("etag").unwrap().to_string();
        let conditional = parse_request(
            format!("POST /api/workspaces/w/file HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nIf-Match: {etag}\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let first_body = format!(
            r#"{{"path":"notes.txt","text":"device A\n","expectedRevision":"{revision}"}}"#
        );
        let first = route_workspace_request(&conditional, Some(first_body.as_bytes()), &config)
            .unwrap()
            .unwrap();
        assert_eq!(first.status, 200);

        let stale_body = format!(
            r#"{{"path":"notes.txt","text":"device B\n","expectedRevision":"{revision}"}}"#
        );
        let stale = route_workspace_request(&conditional, Some(stale_body.as_bytes()), &config)
            .unwrap()
            .unwrap();
        assert_eq!(stale.status, 409);
        assert_eq!(stale.body["code"], "WORKSPACE_FILE_CONFLICT");
        assert_eq!(stale.body["current"]["text"], "device A\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_workspace_git_status_with_the_node_response_contract() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "VibeLink Test"]);
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-m", "base"]);
        fs::write(root.join("tracked.txt"), "changed\n").unwrap();
        fs::write(root.join("new.txt"), "new\n").unwrap();

        let request = parse_request(b"GET /api/workspaces/w/git/status HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let response = route_workspace_request(&request, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["changedCount"], 2);
        assert_eq!(response.body["workspace"]["id"], "w");
        assert_eq!(response.body["workspace"]["updatedAt"], "now");
        assert_eq!(response.body["workspace"]["lastUsedAt"], "");
        assert_eq!(response.body["cwd"], root.to_string_lossy().as_ref());
        let files = response.body["files"].as_array().unwrap();
        assert!(files
            .iter()
            .any(|file| file["path"] == "tracked.txt" && file["status"] == "M"));
        assert!(files
            .iter()
            .any(|file| file["path"] == "new.txt" && file["status"] == "??"));
        let db = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        let (updated_at, last_used_at): (String, String) = db
            .query_row(
                "SELECT updated_at, last_used_at FROM workspaces WHERE id = 'w'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_ne!(updated_at, "now");
        assert_eq!(last_used_at, updated_at);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_workspace_git_diff_with_tracked_and_untracked_previews() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "VibeLink Test"]);
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-m", "base"]);
        fs::write(root.join("tracked.txt"), "changed\n").unwrap();
        fs::write(root.join("new.txt"), "new\n").unwrap();

        let request = parse_request(b"GET /api/workspaces/w/git/diff HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let response = route_workspace_request(&request, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["changedCount"], 2);
        assert_eq!(response.body["fileCount"], 2);
        assert_eq!(response.body["workspace"]["updatedAt"], "now");
        assert!(response.body["lineCount"].as_u64().unwrap() > 0);
        let diff = response.body["diff"].as_str().unwrap();
        assert!(diff.contains("-base"));
        assert!(diff.contains("+changed"));
        assert!(diff.contains("diff --git a/new.txt b/new.txt"));
        assert!(diff.contains("+new"));
        let files = response.body["files"].as_array().unwrap();
        assert!(files.iter().any(|file| {
            file["path"] == "tracked.txt"
                && file["status"] == "M"
                && file["additions"] == 1
                && file["deletions"] == 1
        }));
        assert!(files.iter().any(|file| {
            file["path"] == "new.txt"
                && file["status"] == "A"
                && file["additions"].as_u64().unwrap() >= 1
        }));
        assert_eq!(
            response.body["untrackedPreviewErrors"],
            json!([]),
            "text previews should not report errors"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_workspace_git_diff_before_the_first_commit() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let output = Command::new("git")
            .arg("init")
            .current_dir(root)
            .output()
            .unwrap();
        assert!(output.status.success());
        fs::write(root.join("first.txt"), "first\n").unwrap();

        let request = parse_request(b"GET /api/workspaces/w/git/diff HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let response = route_workspace_request(&request, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["changedCount"], 1);
        assert_eq!(response.body["files"][0]["path"], "first.txt");
        assert_eq!(response.body["files"][0]["status"], "A");
        assert!(response.body["diff"]
            .as_str()
            .unwrap()
            .contains("diff --git a/first.txt b/first.txt"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn lists_registered_locked_workspace_worktrees() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let linked = dir.join("linked");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "VibeLink Test"]);
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-m", "base"]);
        git(&[
            "worktree",
            "add",
            "-b",
            "feature/worktree",
            linked.to_string_lossy().as_ref(),
        ]);
        git(&[
            "worktree",
            "lock",
            "--reason",
            "device handoff",
            linked.to_string_lossy().as_ref(),
        ]);
        let db = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        db.execute(
            "INSERT INTO workspaces VALUES ('linked',?1,'Linked',?1,'created','updated',NULL)",
            params![linked.to_string_lossy()],
        )
        .unwrap();

        let request = parse_request(b"GET /api/workspaces/w/worktrees HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let response = route_workspace_request(&request, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["workspaceId"], "w");
        let worktrees = response.body["worktrees"].as_array().unwrap();
        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[0]["isMain"], true);
        assert_eq!(worktrees[0]["workspace"]["id"], "w");
        let linked_item = worktrees
            .iter()
            .find(|item| item["branch"] == "feature/worktree")
            .unwrap();
        assert_eq!(linked_item["locked"], true);
        assert_eq!(linked_item["lockReason"], "device handoff");
        assert_eq!(linked_item["workspace"]["id"], "linked");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn parses_detached_bare_and_prunable_worktree_metadata() {
        let worktrees = parse_worktree_list(
            "worktree C:/repo\nHEAD abc\nbare\n\nworktree C:/linked\nHEAD def\ndetached\nlocked handoff\nprunable stale metadata\n",
        );
        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[0]["isMain"], true);
        assert_eq!(worktrees[0]["bare"], true);
        assert_eq!(worktrees[1]["detached"], true);
        assert_eq!(worktrees[1]["locked"], true);
        assert_eq!(worktrees[1]["lockReason"], "handoff");
        assert_eq!(worktrees[1]["prunable"], true);
        assert_eq!(worktrees[1]["pruneReason"], "stale metadata");
    }

    #[test]
    fn stages_a_workspace_file_with_tool_events_and_audit() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).to_string()
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "VibeLink Test"]);
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-m", "base"]);
        fs::write(root.join("tracked.txt"), "changed\n").unwrap();

        let request = parse_request(b"POST /api/workspaces/w/git/file-action HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 39\r\n\r\n").unwrap();
        let response = route_workspace_request(
            &request,
            Some(br#"{"action":"stage","path":"tracked.txt"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["action"], "stage");
        assert_eq!(response.body["path"], "tracked.txt");
        let tool_run_id = response.body["toolRunId"].as_str().unwrap();
        assert!(!tool_run_id.is_empty());
        assert!(!git(&["diff", "--cached", "--", "tracked.txt"]).is_empty());

        let db = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        let (status, tool_name): (String, String) = db
            .query_row(
                "SELECT status, tool_name FROM tool_runs WHERE id = ?1",
                params![tool_run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!(tool_name, "workspace.git_file_action");
        let event_types = db
            .prepare("SELECT event_type FROM tool_events WHERE tool_run_id = ?1 ORDER BY cursor")
            .unwrap()
            .query_map(params![tool_run_id], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            event_types,
            vec!["tool.created", "tool.started", "tool.completed"]
        );
        let audited: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE event_type = 'workspace.git_file_action' AND success = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audited, 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn stages_and_unstages_only_the_requested_git_hunk() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).to_string()
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "VibeLink Test"]);
        fs::write(root.join("tracked.txt"), "one\ntwo\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-m", "base"]);
        fs::write(root.join("tracked.txt"), "changed\ntwo\n").unwrap();
        let patch = git(&["diff", "--unified=0", "--", "tracked.txt"]);
        let request = parse_request(b"POST /api/workspaces/w/git/file-action HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 1\r\n\r\n").unwrap();
        let stage_body =
            json!({"action":"stage-hunk","path":"tracked.txt","patch":patch}).to_string();
        let staged = route_workspace_request(&request, Some(stage_body.as_bytes()), &config)
            .unwrap()
            .unwrap();
        assert_eq!(staged.status, 200);
        assert!(git(&["diff", "--cached", "--", "tracked.txt"]).contains("+changed"));

        let unstage_body =
            json!({"action":"unstage-hunk","path":"tracked.txt","patch":patch}).to_string();
        let unstaged = route_workspace_request(&request, Some(unstage_body.as_bytes()), &config)
            .unwrap()
            .unwrap();
        assert_eq!(unstaged.status, 200);
        assert!(git(&["diff", "--cached", "--", "tracked.txt"]).is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_cross_file_hunk_and_records_the_failed_tool_run() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "VibeLink Test"]);
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-m", "base"]);
        fs::write(root.join("tracked.txt"), "changed\n").unwrap();
        let patch = "diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-old\n+new\n";
        let request = parse_request(b"POST /api/workspaces/w/git/file-action HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 1\r\n\r\n").unwrap();
        assert!(workspace_request_requires_body(&request));
        let body = json!({"action":"stage-hunk","path":"tracked.txt","patch":patch}).to_string();
        let response = route_workspace_request(&request, Some(body.as_bytes()), &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body["error"],
            "Git hunk patch must target exactly the requested file."
        );
        let db = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        let (tool_run_id, status): (String, String) = db
            .query_row(
                "SELECT id, status FROM tool_runs ORDER BY created_at DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "failed");
        let failed_event: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM tool_events WHERE tool_run_id = ?1 AND event_type = 'tool.error'",
                params![tool_run_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(failed_event, 1);
        let failed_audit: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE event_type = 'workspace.git_file_action' AND success = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(failed_audit, 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_an_untracked_file_without_touching_its_sibling() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let output = Command::new("git")
            .arg("init")
            .current_dir(root)
            .output()
            .unwrap();
        assert!(output.status.success());
        fs::write(root.join("reject.txt"), "remove\n").unwrap();
        fs::write(root.join("keep.txt"), "keep\n").unwrap();
        let request = parse_request(b"POST /api/workspaces/w/git/file-action HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 1\r\n\r\n").unwrap();
        let response = route_workspace_request(
            &request,
            Some(br#"{"action":"reject","path":"reject.txt"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 200);
        assert!(!root.join("reject.txt").exists());
        assert_eq!(fs::read_to_string(root.join("keep.txt")).unwrap(), "keep\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn previews_repository_git_action_without_mutating_or_creating_a_tool_run() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let output = Command::new("git")
            .arg("init")
            .current_dir(root)
            .output()
            .unwrap();
        assert!(output.status.success());
        fs::write(root.join("new.txt"), "new\n").unwrap();
        let request = parse_request(b"POST /api/workspaces/w/git/action?dryRun=1 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 1\r\n\r\n").unwrap();
        assert!(workspace_request_requires_body(&request));
        let response = route_workspace_request(
            &request,
            Some(br#"{"action":"stage-all","message":"preview"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["dryRun"], true);
        assert_eq!(response.body["action"], "stage-all");
        let cached = Command::new("git")
            .args(["diff", "--cached", "--name-only"])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(cached.stdout.is_empty());
        let db = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        let tool_runs: i64 = db
            .query_row("SELECT COUNT(*) FROM tool_runs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tool_runs, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn stages_all_with_a_completed_repository_tool_run() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let output = Command::new("git")
            .arg("init")
            .current_dir(root)
            .output()
            .unwrap();
        assert!(output.status.success());
        fs::write(root.join("new.txt"), "new\n").unwrap();
        let request = parse_request(b"POST /api/workspaces/w/git/action HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 1\r\n\r\n").unwrap();
        let response =
            route_workspace_request(&request, Some(br#"{"action":"stage-all"}"#), &config)
                .unwrap()
                .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["action"], "stage-all");
        assert!(response.body["summary"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "new.txt"));
        let tool_run_id = response.body["toolRunId"].as_str().unwrap();
        let db = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        let (status, tool_name): (String, String) = db
            .query_row(
                "SELECT status, tool_name FROM tool_runs WHERE id = ?1",
                params![tool_run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!(tool_name, "workspace.git_action");
        let audited: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE event_type = 'workspace.git_action' AND success = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audited, 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn creates_a_branch_and_round_trips_a_stash_through_repository_actions() {
        let (dir, config, root) = fixture();
        let root = Path::new(&root);
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "VibeLink Test"]);
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-m", "base"]);
        let initial_branch = git(&["branch", "--show-current"]);
        let request = parse_request(b"POST /api/workspaces/w/git/action HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 1\r\n\r\n").unwrap();
        let run_action = |body: Value| {
            let body = body.to_string();
            route_workspace_request(&request, Some(body.as_bytes()), &config)
                .unwrap()
                .unwrap()
        };
        let created = run_action(json!({
            "action": "branch-create",
            "branchName": "feature/rust-owner",
            "baseRef": initial_branch
        }));
        assert_eq!(created.status, 200);
        assert_eq!(git(&["branch", "--show-current"]), "feature/rust-owner");
        let switched = run_action(json!({
            "action": "branch-switch",
            "branchName": initial_branch
        }));
        assert_eq!(switched.status, 200);
        fs::write(root.join("tracked.txt"), "changed\n").unwrap();
        let stashed = run_action(json!({
            "action": "stash-push",
            "message": "rust migration"
        }));
        assert_eq!(stashed.status, 200);
        assert!(git(&["status", "--porcelain"]).is_empty());
        let popped = run_action(json!({"action": "stash-pop"}));
        assert_eq!(popped.status, 200);
        assert_eq!(
            fs::read_to_string(root.join("tracked.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "changed\n"
        );
        let _ = fs::remove_dir_all(dir);
    }
}
