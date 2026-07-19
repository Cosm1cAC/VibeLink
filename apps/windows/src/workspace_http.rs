use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct WorkspaceRouteConfig {
    pub data_dir: PathBuf,
    metrics: Arc<WorkspaceRouteMetrics>,
    mutation_lock: Arc<Mutex<()>>,
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
        }
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.fallbacks.fetch_add(1, Ordering::SeqCst);
    }
}

pub fn workspace_request_requires_body(request: &ParsedRequest) -> bool {
    request.method == "POST"
        && request.path().starts_with("/api/workspaces/")
        && request.path().ends_with("/file")
}

pub fn route_workspace_request(
    request: &ParsedRequest,
    body: Option<&[u8]>,
    config: &WorkspaceRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    let Some((workspace_id, action_path)) = workspace_path_parts(request.path()) else {
        return Ok(None);
    };
    if request.method != "POST" || action_path != "file" {
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
    let body = body.ok_or_else(|| anyhow::anyhow!("Workspace file body is required"))?;
    if body.len() > MAX_BODY_BYTES {
        return Ok(Some(HttpRouteResponse::error(
            413,
            "Request body is too large.",
        )));
    }
    let payload: Value = serde_json::from_slice(body).context("Invalid workspace file JSON")?;
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
            if text.as_bytes().len() > MAX_BODY_BYTES {
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> (PathBuf, WorkspaceRouteConfig, String) {
        let dir = std::env::temp_dir().join(format!(
            "vibelink-workspace-http-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
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
        db.execute_batch("CREATE TABLE devices(id TEXT PRIMARY KEY,label TEXT,token_hash TEXT UNIQUE,created_at TEXT,last_seen_at TEXT,revoked_at TEXT,expires_at TEXT,rotated_at TEXT,meta_json TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT,title TEXT,allowed_root TEXT,created_at TEXT,updated_at TEXT,last_used_at TEXT); CREATE TABLE audit_log(cursor INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT,event_at TEXT,method TEXT,path TEXT,success INTEGER,target TEXT,meta_json TEXT,created_at TEXT);").unwrap();
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
}
