use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
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
    let file_mutation = request.method == "POST" && action_path == "file";
    let git_status = request.method == "GET" && action_path == "git/status";
    let git_diff = request.method == "GET" && action_path == "git/diff";
    let worktree_list = request.method == "GET" && action_path == "worktrees";
    if !file_mutation && !git_status && !git_diff && !worktree_list {
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
}
