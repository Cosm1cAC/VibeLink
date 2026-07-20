use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
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
        && (request.path().ends_with("/file")
            || request.path().ends_with("/git/file-action")
            || request.path().ends_with("/git/action"))
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
    let git_file_action = request.method == "POST" && action_path == "git/file-action";
    let git_action = request.method == "POST" && action_path == "git/action";
    if !file_mutation
        && !git_status
        && !git_diff
        && !worktree_list
        && !git_file_action
        && !git_action
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

fn now_iso() -> String {
    let now: DateTime<Utc> = SystemTime::now().into();
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
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
        db.execute_batch("CREATE TABLE devices(id TEXT PRIMARY KEY,label TEXT,token_hash TEXT UNIQUE,created_at TEXT,last_seen_at TEXT,revoked_at TEXT,expires_at TEXT,rotated_at TEXT,meta_json TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT,title TEXT,allowed_root TEXT,created_at TEXT,updated_at TEXT,last_used_at TEXT); CREATE TABLE audit_log(cursor INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT,event_at TEXT,method TEXT,path TEXT,success INTEGER,target TEXT,meta_json TEXT,created_at TEXT); CREATE TABLE tool_runs(id TEXT PRIMARY KEY,task_id TEXT,workspace_id TEXT,tool_name TEXT NOT NULL,status TEXT NOT NULL,title TEXT,input_json TEXT,result_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,started_at TEXT,completed_at TEXT); CREATE TABLE tool_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,tool_run_id TEXT NOT NULL,task_id TEXT,workspace_id TEXT,event_id TEXT NOT NULL,event_type TEXT NOT NULL,event_at TEXT NOT NULL,text TEXT,payload_json TEXT,event_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tool_run_id,event_id));").unwrap();
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
