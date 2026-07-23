use super::{
    daemon::{dispatch, dispatch_local, route_for, start_execution, HostState},
    protocol::{
        AppServerParams, BackendKind, ExecutionSnapshot, ExecutionStatus, RequestEnvelope,
        ResponseEnvelope, StartParams, PROTOCOL_VERSION,
    },
};
use crate::{execution_host::now_rfc3339, settings_credentials};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, SystemTime},
};
use uuid::Uuid;

const POLL_INTERVAL: Duration = Duration::from_millis(100);
const EVENT_PAGE_LIMIT: usize = 256;

#[derive(Debug)]
struct ClaimedTask {
    queue_id: String,
    task_id: String,
    attempts: i64,
    max_attempts: i64,
    payload: Value,
}

pub(super) fn spawn(state: Arc<HostState>, data_dir: PathBuf) -> Result<()> {
    thread::Builder::new()
        .name("execd-task-scheduler".to_string())
        .spawn(move || loop {
            if let Err(error) = scheduler_tick(&state, &data_dir) {
                eprintln!("execd task scheduler tick failed: {error:#}");
            }
            thread::sleep(POLL_INTERVAL);
        })
        .context("failed to start execd task scheduler")?;
    Ok(())
}

fn scheduler_tick(state: &HostState, data_dir: &Path) -> Result<()> {
    let db_path = data_dir.join("mobile-agent.sqlite");
    if !db_path.exists() {
        return Ok(());
    }
    let mut connection = open_database(&db_path)?;
    if !table_exists(&connection, "task_queue")? {
        return Ok(());
    }
    ensure_execution_schema(&connection)?;
    dispatch_approval_outbox(state, &connection)?;
    sync_running_tasks(state, &connection)?;

    let concurrency = env::var("VIBELINK_TASK_CONCURRENCY")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(2)
        .clamp(1, 32);
    let running: i64 = connection.query_row(
        "SELECT COUNT(*) FROM task_queue WHERE status = 'running'",
        [],
        |row| row.get(0),
    )?;
    for _ in running..concurrency {
        let Some(task) = claim_next(&mut connection)? else {
            break;
        };
        if let Err(error) = launch_claimed_task(state, data_dir, &connection, &task) {
            settle_launch_failure(&connection, &task, &error.to_string())?;
        }
    }
    Ok(())
}

fn open_database(path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("cannot open task scheduler database {}", path.display()))?;
    connection.busy_timeout(Duration::from_secs(5))?;
    Ok(connection)
}

fn table_exists(connection: &Connection, name: &str) -> Result<bool> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn ensure_execution_schema(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS execution_bindings (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, task_id TEXT, tool_run_id TEXT,
          provider TEXT, owner TEXT NOT NULL, status TEXT NOT NULL, attach_state TEXT NOT NULL,
          worker_pid INTEGER, process_pid INTEGER, process_started_at TEXT,
          worker_instance_id TEXT, protocol_version INTEGER NOT NULL DEFAULT 1,
          capabilities_json TEXT, last_seen_host_seq INTEGER NOT NULL DEFAULT 0,
          last_ingested_host_seq INTEGER NOT NULL DEFAULT 0,
          last_acked_host_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER, signal TEXT, lost_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_execution_bindings_task ON execution_bindings(task_id);
        CREATE TABLE IF NOT EXISTS execution_host_events (
          execution_id TEXT NOT NULL, host_seq INTEGER NOT NULL, event_id TEXT NOT NULL,
          event_type TEXT NOT NULL, event_at TEXT NOT NULL, payload_json TEXT,
          event_json TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(execution_id,host_seq), UNIQUE(execution_id,event_id)
        );
        CREATE TABLE IF NOT EXISTS approval_requests (
          id TEXT PRIMARY KEY,tool_run_id TEXT,task_id TEXT,workspace_id TEXT,
          kind TEXT NOT NULL,status TEXT NOT NULL,title TEXT,reason TEXT,
          request_json TEXT,risk_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
          expires_at TEXT,decided_at TEXT,decided_by_device_id TEXT,
          decision_reason TEXT,decision_json TEXT
        );
        CREATE TABLE IF NOT EXISTS approval_outbox (
          id TEXT PRIMARY KEY,approval_id TEXT NOT NULL UNIQUE,operation_id TEXT NOT NULL UNIQUE,
          continuation_ref TEXT NOT NULL,expected_version INTEGER NOT NULL DEFAULT 0,
          decision_json TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
          delivered_at TEXT,applied_at TEXT,last_error TEXT
        );",
    )?;
    for (name, definition) in [
        ("provider", "TEXT"),
        ("thread_id", "TEXT"),
        ("turn_id", "TEXT"),
        ("item_id", "TEXT"),
        ("continuation_ref", "TEXT"),
        ("decision_version", "INTEGER NOT NULL DEFAULT 0"),
        ("delivery_status", "TEXT NOT NULL DEFAULT 'pending'"),
        ("requested_permissions_json", "TEXT"),
        ("available_decisions_json", "TEXT"),
    ] {
        ensure_column(connection, "approval_requests", name, definition)?;
    }
    Ok(())
}

fn dispatch_approval_outbox(state: &HostState, connection: &Connection) -> Result<()> {
    let now = now_rfc3339();
    let command = connection
        .query_row(
            "SELECT o.id,o.approval_id,o.operation_id,o.continuation_ref,o.expected_version,
                    o.decision_json,r.request_json
             FROM approval_outbox o JOIN approval_requests r ON r.id=o.approval_id
             WHERE o.status IN ('decision_recorded','delivering')
               AND (o.next_attempt_at IS NULL OR o.next_attempt_at<=?1)
             ORDER BY o.created_at ASC LIMIT 1",
            params![now],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((
        outbox_id,
        approval_id,
        operation_id,
        continuation_ref,
        expected_version,
        decision_json,
        request_json,
    )) = command
    else {
        return Ok(());
    };
    connection.execute(
        "UPDATE approval_outbox SET status='delivering',attempts=attempts+1,updated_at=?1,
         next_attempt_at=?2 WHERE id=?3",
        params![now, retry_timestamp(Duration::from_secs(30)), outbox_id],
    )?;
    connection.execute(
        "UPDATE approval_requests SET delivery_status='delivering',updated_at=?1 WHERE id=?2",
        params![now, approval_id],
    )?;
    let request: Value = serde_json::from_str(&request_json).unwrap_or_else(|_| json!({}));
    let execution_id = request
        .get("executionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if execution_id.is_empty() {
        mark_outbox_stale(
            connection,
            &outbox_id,
            &approval_id,
            "Approval continuation has no execution identity.",
        )?;
        return Ok(());
    }
    let response = dispatch(
        state,
        RequestEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: Uuid::new_v4().to_string(),
            method: "approval.resolve".to_string(),
            params: json!({
                "executionId": execution_id,
                "approvalId": approval_id,
                "continuationRef": continuation_ref,
                "expectedVersion": expected_version,
                "decision": serde_json::from_str::<Value>(&decision_json).unwrap_or_else(|_| json!({})),
                "operationId": operation_id
            }),
        },
    );
    if let Some(error) = response.error {
        if matches!(
            error.code.as_str(),
            "APPROVAL_STALE" | "EXECUTION_NOT_FOUND" | "EXECUTION_STATE_CONFLICT"
        ) {
            mark_outbox_stale(connection, &outbox_id, &approval_id, &error.message)?;
        } else {
            connection.execute(
                "UPDATE approval_outbox SET status='decision_recorded',updated_at=?1,
                 next_attempt_at=?2,last_error=?3 WHERE id=?4",
                params![
                    now_rfc3339(),
                    retry_timestamp(Duration::from_secs(1)),
                    error.message,
                    outbox_id
                ],
            )?;
            connection.execute(
                "UPDATE approval_requests SET delivery_status='decision_recorded',updated_at=?1
                 WHERE id=?2",
                params![now_rfc3339(), approval_id],
            )?;
        }
        return Ok(());
    }
    let delivered_at = now_rfc3339();
    connection.execute(
        "UPDATE approval_outbox SET status='delivered',updated_at=?1,delivered_at=?1,
         next_attempt_at=NULL,last_error='' WHERE id=?2",
        params![delivered_at, outbox_id],
    )?;
    connection.execute(
        "UPDATE approval_requests SET delivery_status='delivered',updated_at=?1 WHERE id=?2",
        params![delivered_at, approval_id],
    )?;
    Ok(())
}

fn mark_outbox_stale(
    connection: &Connection,
    outbox_id: &str,
    approval_id: &str,
    reason: &str,
) -> Result<()> {
    let now = now_rfc3339();
    connection.execute(
        "UPDATE approval_outbox SET status='stale',updated_at=?1,next_attempt_at=NULL,last_error=?2
         WHERE id=?3",
        params![now, reason, outbox_id],
    )?;
    connection.execute(
        "UPDATE approval_requests SET delivery_status='stale',updated_at=?1 WHERE id=?2",
        params![now, approval_id],
    )?;
    Ok(())
}

fn retry_timestamp(delay: Duration) -> String {
    chrono::DateTime::<chrono::Utc>::from(SystemTime::now() + delay)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn ensure_column(connection: &Connection, table: &str, name: &str, definition: &str) -> Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|column| column == name) {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {name} {definition}"
        ))?;
    }
    Ok(())
}

fn claim_next(connection: &mut Connection) -> Result<Option<ClaimedTask>> {
    let now = now_rfc3339();
    let transaction = connection.transaction()?;
    let row = transaction
        .query_row(
            "SELECT id,task_id,attempts,max_attempts,payload_json
             FROM task_queue
             WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
             ORDER BY priority DESC,created_at ASC LIMIT 1",
            params![now],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((queue_id, task_id, attempts, max_attempts, payload_json)) = row else {
        transaction.commit()?;
        return Ok(None);
    };
    let changed = transaction.execute(
        "UPDATE task_queue
         SET status = 'running',attempts = attempts + 1,started_at = COALESCE(started_at,?1),
             updated_at = ?1,last_error = NULL
         WHERE id = ?2 AND status = 'queued'",
        params![now, queue_id],
    )?;
    if changed != 1 {
        transaction.commit()?;
        return Ok(None);
    }
    transaction.execute(
        "UPDATE tasks SET status = 'starting',updated_at = ?1 WHERE id = ?2",
        params![now, task_id],
    )?;
    insert_task_event(
        &transaction,
        &task_id,
        "system",
        if attempts == 0 {
            "Task claimed by Rust execution scheduler."
        } else {
            "Task retry claimed by Rust execution scheduler."
        },
        json!({ "owner": "rust-execd", "attempt": attempts + 1 }),
    )?;
    transaction.commit()?;
    Ok(Some(ClaimedTask {
        queue_id,
        task_id,
        attempts: attempts + 1,
        max_attempts,
        payload: serde_json::from_str(&payload_json).unwrap_or_else(|_| json!({})),
    }))
}

fn launch_claimed_task(
    state: &HostState,
    data_dir: &Path,
    connection: &Connection,
    task: &ClaimedTask,
) -> Result<()> {
    let execution_id = execution_id_for_attempt(
        &task.task_id,
        task.payload
            .get("_turn")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        task.attempts,
    )?;
    let snapshot = match route_for(state, &execution_id) {
        Ok(route) => ExecutionSnapshot::from(&route.manifest),
        Err(_) => {
            let start = build_start_params(data_dir, task, &execution_id)?;
            start_execution(state, start)?
        }
    };
    upsert_binding(connection, task, &snapshot)?;
    connection.execute(
        "UPDATE tasks SET status = 'running',updated_at = ?1,command_label = ?2,
         meta_json = json_set(COALESCE(meta_json,'{}'),'$.pendingWorkerStart',json('false'),
                              '$.executionId',?3,'$.rustWorkerOwner','execd')
         WHERE id = ?4",
        params![
            now_rfc3339(),
            task.payload
                .get("agent")
                .and_then(Value::as_str)
                .unwrap_or("codex"),
            snapshot.execution_id,
            task.task_id
        ],
    )?;
    insert_task_event(
        connection,
        &task.task_id,
        "system",
        "Rust execution worker started.",
        json!({ "executionId": snapshot.execution_id, "owner": "execution-host" }),
    )?;
    Ok(())
}

fn build_start_params(
    data_dir: &Path,
    task: &ClaimedTask,
    execution_id: &str,
) -> Result<StartParams> {
    let payload = &task.payload;
    let settings = load_settings(data_dir);
    let agent = payload
        .get("agent")
        .and_then(Value::as_str)
        .unwrap_or("codex");
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| settings.get("defaultCwd").and_then(Value::as_str))
        .unwrap_or(".")
        .to_string();
    let mut environment = BTreeMap::new();
    for (key, value) in env::vars() {
        environment.insert(key, value);
    }
    for (provider, key, variable) in [
        ("codex", "openai", "OPENAI_API_KEY"),
        ("claude", "anthropic", "ANTHROPIC_API_KEY"),
        ("zhipu", "zhipu", "ZHIPU_API_KEY"),
    ] {
        if agent == provider {
            if let Ok(secret) = settings_credentials::read_secret(data_dir, key) {
                if !secret.is_empty() {
                    environment.insert(variable.to_string(), secret);
                }
            }
        }
    }
    let (command, mut args) = provider_command(agent, &settings)?;
    let prompt = payload.get("prompt").and_then(Value::as_str).unwrap_or("");
    let model = payload.get("model").and_then(Value::as_str).unwrap_or("");
    let effort = payload
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .unwrap_or("");

    let (kind, backend, app_server) = if agent == "codex" {
        args.extend(codex_global_args(payload, &settings, &cwd));
        let session_id = payload
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let thread_start_params = session_id.is_none().then(|| {
            json!({
                "cwd": cwd,
                "runtimeWorkspaceRoots": [cwd],
                "approvalPolicy": codex_approval_policy(security_value(payload, &settings, "approvalPolicy", "on-request")),
                "sandbox": security_value(payload, &settings, "sandboxMode", "workspace-write"),
                "threadSource": "appServer",
                "ephemeral": false
            })
        });
        let thread_resume_params = session_id
            .map(|id| json!({ "threadId": id, "cwd": cwd, "runtimeWorkspaceRoots": [cwd] }));
        let turn_start_params = if let Some(id) = session_id {
            json!({ "threadId": id, "input": [{ "type": "text", "text": prompt, "text_elements": [] }] })
        } else {
            json!({ "input": [{ "type": "text", "text": prompt, "text_elements": [] }] })
        };
        (
            "provider.appServer".to_string(),
            BackendKind::AppServer,
            Some(AppServerParams {
                thread_start_params,
                thread_resume_params,
                turn_start_params,
                connect_timeout_ms: 15_000,
            }),
        )
    } else {
        match agent {
            "claude" => {
                args.extend(
                    [
                        "--print",
                        "--output-format",
                        "stream-json",
                        "--verbose",
                        "--include-partial-messages",
                    ]
                    .into_iter()
                    .map(str::to_string),
                );
                let permission = payload
                    .get("permissionMode")
                    .and_then(Value::as_str)
                    .or_else(|| settings.get("permissionMode").and_then(Value::as_str))
                    .unwrap_or("default");
                if permission != "default" {
                    args.extend(["--permission-mode".to_string(), permission.to_string()]);
                }
                if payload.get("mode").and_then(Value::as_str) == Some("resume") {
                    if let Some(session) = payload.get("sessionId").and_then(Value::as_str) {
                        args.extend(["--resume".to_string(), session.to_string()]);
                    }
                } else if payload.get("mode").and_then(Value::as_str) == Some("continue") {
                    args.push("--continue".to_string());
                }
                if !model.is_empty() {
                    args.extend(["--model".to_string(), model.to_string()]);
                }
                if !effort.is_empty() {
                    args.extend(["--effort".to_string(), effort.to_string()]);
                }
                args.push(prompt.to_string());
            }
            "zhipu" => {
                args.extend([
                    "--json".to_string(),
                    "--prompt".to_string(),
                    prompt.to_string(),
                ]);
                args.extend([
                    "--model".to_string(),
                    if model.is_empty() { "glm-5.2" } else { model }.to_string(),
                ]);
                if !effort.is_empty() {
                    args.extend(["--effort".to_string(), effort.to_string()]);
                }
            }
            "doubao" => {
                args.extend([
                    "ask".to_string(),
                    "--json".to_string(),
                    "--prompt".to_string(),
                    prompt.to_string(),
                ]);
                if let Some(endpoint) = settings.get("doubaoCdpEndpoint").and_then(Value::as_str) {
                    args.extend(["--endpoint".to_string(), endpoint.to_string()]);
                }
                if let Some(url) = settings.get("doubaoUrl").and_then(Value::as_str) {
                    args.extend(["--url".to_string(), url.to_string()]);
                }
            }
            _ => bail!("unsupported provider {agent}"),
        }
        ("provider.cli".to_string(), BackendKind::Stdio, None)
    };
    Ok(StartParams {
        execution_id: Some(execution_id.to_string()),
        kind,
        backend,
        command,
        args,
        cwd: Some(cwd),
        env: environment,
        app_server,
        cols: 120,
        rows: 30,
        spool_quota_bytes: 64 * 1024 * 1024,
        segment_bytes: 1024 * 1024,
        operation_id: format!("task-start-{execution_id}"),
    })
}

fn load_settings(data_dir: &Path) -> Value {
    fs::read_to_string(data_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({}))
}

fn provider_command(agent: &str, settings: &Value) -> Result<(String, Vec<String>)> {
    let root = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let configured = match agent {
        "codex" => settings
            .get("codexCommand")
            .and_then(Value::as_str)
            .unwrap_or("auto"),
        "claude" => settings
            .get("claudeCommand")
            .and_then(Value::as_str)
            .unwrap_or("claude"),
        "doubao" => settings
            .get("doubaoCommand")
            .and_then(Value::as_str)
            .unwrap_or("auto"),
        "zhipu" => "auto",
        _ => bail!("unsupported provider {agent}"),
    };
    if configured == "disabled" {
        bail!("{agent} provider is disabled");
    }
    if agent == "codex"
        && (configured.is_empty()
            || configured == "auto"
            || configured.eq_ignore_ascii_case("codex"))
    {
        if let Some(path) = find_bundled_codex() {
            return Ok((path.to_string_lossy().into_owned(), Vec::new()));
        }
    }
    if agent == "zhipu" {
        return Ok((
            node_command(&root),
            vec![root
                .join("src")
                .join("zhipuCli.mjs")
                .to_string_lossy()
                .into_owned()],
        ));
    }
    if agent == "doubao" && (configured.is_empty() || configured == "auto") {
        let preferred = root
            .join("packages")
            .join("doubao-cli")
            .join("src")
            .join("bin")
            .join("doubao.mjs");
        let script = if preferred.exists() {
            preferred
        } else {
            root.join("tools").join("doubao-cli.mjs")
        };
        return Ok((
            node_command(&root),
            vec![script.to_string_lossy().into_owned()],
        ));
    }
    let parts = split_command(if configured == "auto" {
        agent
    } else {
        configured
    });
    let Some(command) = parts.first() else {
        bail!("{agent} provider command is empty");
    };
    Ok((command.clone(), parts[1..].to_vec()))
}

fn node_command(root: &Path) -> String {
    env::var("VIBELINK_NODE_COMMAND")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let bundled = root.join("runtime").join("node.exe");
            bundled
                .exists()
                .then(|| bundled.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "node".to_string())
}

fn find_bundled_codex() -> Option<PathBuf> {
    let local = env::var_os("LOCALAPPDATA")?;
    let local = PathBuf::from(local);
    let mut candidates = Vec::new();
    let bin = local.join("OpenAI").join("Codex").join("bin");
    if let Ok(entries) = fs::read_dir(bin) {
        for entry in entries.flatten() {
            let candidate = entry.path().join("codex.exe");
            if candidate.exists() {
                candidates.push(candidate);
            }
        }
    }
    let packaged = local
        .join("Packages")
        .join("OpenAI.Codex_2p2nqsd0c76g0")
        .join("LocalCache")
        .join("Local")
        .join("OpenAI")
        .join("Codex")
        .join("bin")
        .join("codex.exe");
    if packaged.exists() {
        candidates.push(packaged);
    }
    candidates.into_iter().max_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    })
}

fn split_command(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for character in value.chars() {
        match character {
            '"' => quoted = !quoted,
            ' ' | '\t' if !quoted => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn security_value<'a>(
    payload: &'a Value,
    settings: &'a Value,
    key: &str,
    fallback: &'a str,
) -> &'a str {
    payload
        .get("security")
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .or_else(|| {
            settings
                .get("security")
                .and_then(|value| value.get(key))
                .and_then(Value::as_str)
        })
        .unwrap_or(fallback)
}

fn codex_approval_policy(value: &str) -> &str {
    if value == "strict" {
        "untrusted"
    } else {
        value
    }
}

fn codex_global_args(payload: &Value, settings: &Value, cwd: &str) -> Vec<String> {
    let mut args = vec!["-C".to_string(), cwd.to_string()];
    if let Some(model) = payload
        .get("model")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    {
        args.extend(["-m".to_string(), model.to_string()]);
    }
    if let Some(effort) = payload
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        args.extend([
            "-c".to_string(),
            format!("model_reasoning_effort=\"{effort}\""),
        ]);
    }
    args.extend([
        "--sandbox".to_string(),
        security_value(payload, settings, "sandboxMode", "workspace-write").to_string(),
        "--ask-for-approval".to_string(),
        codex_approval_policy(security_value(
            payload,
            settings,
            "approvalPolicy",
            "on-request",
        ))
        .to_string(),
        "-c".to_string(),
        format!(
            "sandbox_network_access={}",
            payload
                .get("security")
                .and_then(|value| value.get("networkAccess"))
                .and_then(Value::as_bool)
                .or_else(|| {
                    settings
                        .get("security")
                        .and_then(|value| value.get("networkAccess"))
                        .and_then(Value::as_bool)
                })
                .unwrap_or(true)
        ),
    ]);
    args
}

fn execution_id_for_attempt(task_id: &str, turn: i64, attempt: i64) -> Result<String> {
    if turn == 0 && attempt <= 1 {
        return Ok(Uuid::parse_str(task_id)
            .context("queued task id must be a UUID")?
            .to_string());
    }
    let mut bytes = Sha256::digest(format!("{task_id}:{turn}:{attempt}").as_bytes())[..16].to_vec();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(Uuid::from_slice(&bytes)?.to_string())
}

fn upsert_binding(
    connection: &Connection,
    task: &ClaimedTask,
    snapshot: &ExecutionSnapshot,
) -> Result<()> {
    let now = now_rfc3339();
    connection.execute(
        "INSERT INTO execution_bindings (
           id,kind,task_id,provider,owner,status,attach_state,worker_pid,process_pid,
           process_started_at,worker_instance_id,protocol_version,capabilities_json,
           last_seen_host_seq,last_ingested_host_seq,last_acked_host_seq,created_at,updated_at
         ) VALUES (?1,?2,?3,?4,'execution-host',?5,?6,?7,?8,?9,?10,1,?11,?12,0,?13,?14,?14)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status,attach_state=excluded.attach_state,
           worker_pid=excluded.worker_pid,process_pid=excluded.process_pid,
           process_started_at=excluded.process_started_at,worker_instance_id=excluded.worker_instance_id,
           capabilities_json=excluded.capabilities_json,last_seen_host_seq=excluded.last_seen_host_seq,
           updated_at=excluded.updated_at",
        params![
            snapshot.execution_id,
            snapshot.kind,
            task.task_id,
            task.payload.get("agent").and_then(Value::as_str).unwrap_or("codex"),
            status_name(snapshot.status),
            attach_name(snapshot),
            snapshot.worker_pid,
            snapshot.process_pid,
            snapshot.process_started_at,
            snapshot.worker_instance_id,
            snapshot.capabilities.to_string(),
            snapshot.last_host_seq,
            snapshot.last_acked_host_seq,
            now
        ],
    )?;
    Ok(())
}

fn sync_running_tasks(state: &HostState, connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare(
        "SELECT q.id,q.task_id,q.attempts,q.max_attempts,q.payload_json,b.id,
                COALESCE(b.last_ingested_host_seq,0)
         FROM task_queue q LEFT JOIN execution_bindings b
           ON b.id=(SELECT latest.id FROM execution_bindings latest
                    WHERE latest.task_id=q.task_id
                    ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
         WHERE q.status='running'
         ORDER BY q.started_at ASC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                ClaimedTask {
                    queue_id: row.get(0)?,
                    task_id: row.get(1)?,
                    attempts: row.get(2)?,
                    max_attempts: row.get(3)?,
                    payload: serde_json::from_str(&row.get::<_, String>(4)?)
                        .unwrap_or_else(|_| json!({})),
                },
                row.get::<_, Option<String>>(5)?,
                row.get::<_, i64>(6)? as u64,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for (task, binding_id, cursor) in rows {
        let execution_id = binding_id.unwrap_or(execution_id_for_attempt(
            &task.task_id,
            task.payload
                .get("_turn")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            task.attempts,
        )?);
        let route = match route_for(state, &execution_id) {
            Ok(route) => route,
            Err(error) => {
                if task.attempts == 0 {
                    connection.execute(
                        "UPDATE task_queue SET status='queued',updated_at=?1,next_attempt_at=?1 WHERE id=?2",
                        params![now_rfc3339(), task.queue_id],
                    )?;
                } else {
                    settle_launch_failure(connection, &task, &error.to_string())?;
                }
                continue;
            }
        };
        let snapshot = ExecutionSnapshot::from(&route.manifest);
        upsert_binding(connection, &task, &snapshot)?;
        let persisted_cursor = connection.query_row(
            "SELECT COALESCE(MAX(host_seq),0) FROM execution_host_events WHERE execution_id=?1",
            params![execution_id],
            |row| row.get::<_, u64>(0),
        )?;
        ingest_and_ack(
            state,
            connection,
            &task,
            &snapshot,
            cursor.max(persisted_cursor),
        )?;
        if snapshot.status.is_terminal() {
            settle_terminal(connection, &task, &snapshot)?;
        }
    }
    Ok(())
}

fn ingest_and_ack(
    state: &HostState,
    connection: &Connection,
    task: &ClaimedTask,
    snapshot: &ExecutionSnapshot,
    mut cursor: u64,
) -> Result<()> {
    loop {
        let response: ResponseEnvelope = dispatch_local(
            state,
            "execution.events",
            json!({ "executionId": snapshot.execution_id, "afterHostSeq": cursor, "limit": EVENT_PAGE_LIMIT }),
            &Uuid::new_v4().to_string(),
        )?;
        let result = response.result.unwrap_or_else(|| json!({}));
        let events = result
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if events.is_empty() {
            break;
        }
        for event in &events {
            let host_seq = event.get("hostSeq").and_then(Value::as_u64).unwrap_or(0);
            if host_seq <= cursor {
                continue;
            }
            ingest_host_event(connection, task, event)?;
            cursor = host_seq;
        }
        if events.len() < EVENT_PAGE_LIMIT {
            break;
        }
    }
    if cursor > snapshot.last_acked_host_seq {
        let response = dispatch_local(
            state,
            "execution.ack",
            json!({
                "executionId": snapshot.execution_id,
                "hostSeq": cursor,
                "operationId": format!("rust-task-ack-{}-{cursor}", snapshot.execution_id)
            }),
            &Uuid::new_v4().to_string(),
        )?;
        if let Some(error) = response.error {
            bail!("{}: {}", error.code, error.message);
        }
        connection.execute(
            "UPDATE execution_bindings SET last_ingested_host_seq=?1,last_acked_host_seq=?1,
             last_seen_host_seq=MAX(last_seen_host_seq,?1),updated_at=?2 WHERE id=?3",
            params![cursor, now_rfc3339(), snapshot.execution_id],
        )?;
    } else {
        if snapshot.last_acked_host_seq > cursor {
            bail!(
                "durable event cursor {} is behind acknowledged worker cursor {} for {}",
                cursor,
                snapshot.last_acked_host_seq,
                snapshot.execution_id
            );
        }
        connection.execute(
            "UPDATE execution_bindings SET last_ingested_host_seq=MAX(last_ingested_host_seq,?1),
             last_acked_host_seq=MAX(last_acked_host_seq,?1),
             last_seen_host_seq=MAX(last_seen_host_seq,?1),updated_at=?2 WHERE id=?3",
            params![cursor, now_rfc3339(), snapshot.execution_id],
        )?;
    }
    Ok(())
}

fn ingest_host_event(connection: &Connection, task: &ClaimedTask, event: &Value) -> Result<()> {
    let execution_id = event
        .get("executionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let host_seq = event.get("hostSeq").and_then(Value::as_u64).unwrap_or(0);
    let event_id = event
        .get("eventId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{execution_id}:{host_seq}"));
    let host_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("system");
    let at = event
        .get("at")
        .and_then(Value::as_str)
        .unwrap_or_else(|| "")
        .to_string();
    let payload = event.get("payload").cloned().unwrap_or_else(|| json!({}));
    connection.execute(
        "INSERT OR IGNORE INTO execution_host_events
         (execution_id,host_seq,event_id,event_type,event_at,payload_json,event_json,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            execution_id,
            host_seq,
            event_id,
            host_type,
            at,
            payload.to_string(),
            event.to_string(),
            now_rfc3339()
        ],
    )?;
    let (event_type, text, projected_payload) = project_host_event(host_type, &payload);
    insert_task_event_with_id(
        connection,
        &task.task_id,
        &event_id,
        &event_type,
        &text,
        projected_payload.clone(),
        if at.is_empty() { now_rfc3339() } else { at },
    )?;
    if event_type == "provider.approval.required" {
        persist_approval_request(connection, task, execution_id, host_seq, &projected_payload)?;
    }
    if matches!(
        event_type.as_str(),
        "provider.approval.delivered" | "provider.approval.applied" | "provider.approval.stale"
    ) {
        settle_approval_delivery(connection, &event_type, &projected_payload)?;
    }
    if let Some(thread_id) = projected_payload
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        connection.execute(
            "UPDATE tasks SET session_id=?1,updated_at=?2
             WHERE id=?3 AND COALESCE(session_id,'')=''",
            params![thread_id, now_rfc3339(), task.task_id],
        )?;
    }
    Ok(())
}

fn settle_approval_delivery(
    connection: &Connection,
    event_type: &str,
    payload: &Value,
) -> Result<()> {
    let continuation_ref = payload
        .get("continuationRef")
        .and_then(Value::as_str)
        .unwrap_or("");
    if continuation_ref.is_empty() {
        return Ok(());
    }
    let status = event_type
        .strip_prefix("provider.approval.")
        .unwrap_or("delivered");
    let now = now_rfc3339();
    connection.execute(
        "UPDATE approval_outbox SET status=?1,updated_at=?2,
         delivered_at=CASE WHEN ?1 IN ('delivered','applied') THEN COALESCE(delivered_at,?2) ELSE delivered_at END,
         applied_at=CASE WHEN ?1='applied' THEN ?2 ELSE applied_at END,
         next_attempt_at=NULL,last_error=CASE WHEN ?1='stale' THEN ?3 ELSE '' END
         WHERE continuation_ref=?4 AND status IN ('delivering','delivered')",
        params![
            status,
            now,
            payload.get("reason").and_then(Value::as_str).unwrap_or(""),
            continuation_ref
        ],
    )?;
    connection.execute(
        "UPDATE approval_requests SET delivery_status=?1,updated_at=?2
         WHERE continuation_ref=?3",
        params![status, now, continuation_ref],
    )?;
    Ok(())
}

fn persist_approval_request(
    connection: &Connection,
    task: &ClaimedTask,
    execution_id: &str,
    host_seq: u64,
    payload: &Value,
) -> Result<()> {
    let request_id = payload
        .get("requestId")
        .map(Value::to_string)
        .unwrap_or_default();
    let continuation_ref = payload
        .get("continuationRef")
        .and_then(Value::as_str)
        .unwrap_or("");
    let approval_id = payload
        .get("approvalId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("provider:{execution_id}:{request_id}"));
    let now = now_rfc3339();
    let request = json!({
        "executionId": execution_id,
        "approvalHostSeq": host_seq,
        "request": payload.get("request").cloned().unwrap_or_else(|| payload.clone())
    });
    connection.execute(
        "INSERT OR IGNORE INTO approval_requests (
           id,tool_run_id,task_id,workspace_id,kind,status,title,reason,request_json,risk_json,
           provider,thread_id,turn_id,item_id,continuation_ref,decision_version,delivery_status,
           requested_permissions_json,available_decisions_json,created_at,updated_at,expires_at
         ) VALUES (?1,NULL,?2,'',?3,'pending','Provider approval required',?4,?5,'{}',
                   ?6,?7,?8,?9,?10,?11,'pending',?12,?13,?14,?14,'')",
        params![
            approval_id,
            task.task_id,
            format!(
                "provider.{}",
                payload
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("approval")
            ),
            payload.get("reason").and_then(Value::as_str).unwrap_or(""),
            request.to_string(),
            task.payload
                .get("agent")
                .and_then(Value::as_str)
                .unwrap_or("codex"),
            payload
                .get("threadId")
                .and_then(Value::as_str)
                .unwrap_or(""),
            payload.get("turnId").and_then(Value::as_str).unwrap_or(""),
            payload.get("itemId").and_then(Value::as_str).unwrap_or(""),
            continuation_ref,
            payload
                .get("expectedDecisionVersion")
                .or_else(|| payload.get("decisionVersion"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            payload
                .get("requestedPermissions")
                .cloned()
                .unwrap_or(Value::Null)
                .to_string(),
            payload
                .get("availableDecisions")
                .cloned()
                .unwrap_or_else(|| json!([]))
                .to_string(),
            now
        ],
    )?;
    Ok(())
}

fn project_host_event(host_type: &str, payload: &Value) -> (String, String, Value) {
    if host_type == "provider.event" {
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("provider.event")
            .to_string();
        let text = payload
            .get("text")
            .or_else(|| payload.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        return (event_type, text, payload.clone());
    }
    if matches!(host_type, "stream.stdout" | "stream.stderr" | "stream.pty") {
        let text = if payload.get("encoding").and_then(Value::as_str) == Some("base64") {
            payload
                .get("data")
                .and_then(Value::as_str)
                .and_then(|value| BASE64.decode(value).ok())
                .map(|value| String::from_utf8_lossy(&value).into_owned())
                .unwrap_or_default()
        } else {
            payload
                .get("text")
                .or_else(|| payload.get("data"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let kind = if host_type == "stream.stderr" {
            "stderr"
        } else {
            "stdout"
        };
        return (kind.to_string(), text, payload.clone());
    }
    (host_type.to_string(), String::new(), payload.clone())
}

fn settle_terminal(
    connection: &Connection,
    task: &ClaimedTask,
    snapshot: &ExecutionSnapshot,
) -> Result<()> {
    let status = match snapshot.status {
        ExecutionStatus::Completed => "completed",
        ExecutionStatus::Cancelled => "cancelled",
        _ => "failed",
    };
    let task_status = if status == "completed" {
        "done"
    } else {
        status
    };
    let now = now_rfc3339();
    if snapshot.status == ExecutionStatus::Completed && queue_next_input(connection, task, &now)? {
        return Ok(());
    }
    if !matches!(
        snapshot.status,
        ExecutionStatus::Completed | ExecutionStatus::Cancelled
    ) && task.attempts < task.max_attempts
    {
        connection.execute(
            "UPDATE execution_bindings SET status=?1,attach_state=?2,ended_at=?3,exit_code=?4,
             signal=?5,last_seen_host_seq=?6,updated_at=?3 WHERE id=?7",
            params![
                status_name(snapshot.status),
                attach_name(snapshot),
                snapshot.ended_at,
                snapshot.exit_code,
                snapshot.signal,
                snapshot.last_host_seq,
                snapshot.execution_id
            ],
        )?;
        return settle_launch_failure(
            connection,
            task,
            &format!(
                "Execution {} ended with status {}.",
                snapshot.execution_id,
                status_name(snapshot.status)
            ),
        );
    }
    connection.execute(
        "UPDATE task_queue SET status=?1,updated_at=?2,completed_at=?2,next_attempt_at=NULL
         WHERE id=?3 AND status='running'",
        params![status, now, task.queue_id],
    )?;
    connection.execute(
        "UPDATE tasks SET status=?1,updated_at=?2,exit_code=?3 WHERE id=?4",
        params![task_status, now, snapshot.exit_code, task.task_id],
    )?;
    connection.execute(
        "UPDATE execution_bindings SET status=?1,attach_state=?2,ended_at=?3,exit_code=?4,
         signal=?5,last_seen_host_seq=MAX(last_seen_host_seq,?6),updated_at=?3 WHERE id=?7",
        params![
            status_name(snapshot.status),
            attach_name(snapshot),
            snapshot.ended_at,
            snapshot.exit_code,
            snapshot.signal,
            snapshot.last_host_seq,
            snapshot.execution_id
        ],
    )?;
    Ok(())
}

fn queue_next_input(connection: &Connection, task: &ClaimedTask, now: &str) -> Result<bool> {
    let input = connection
        .query_row(
            "SELECT cursor,text,payload_json FROM task_events
             WHERE task_id=?1 AND event_type='stdin'
               AND json_extract(COALESCE(payload_json,'{}'),'$.queued')=1
               AND COALESCE(json_extract(payload_json,'$.consumed'),0)=0
             ORDER BY cursor ASC LIMIT 1",
            params![task.task_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((cursor, prompt, payload_json)) = input else {
        return Ok(false);
    };
    let session_id = connection
        .query_row(
            "SELECT COALESCE(session_id,'') FROM tasks WHERE id=?1",
            params![task.task_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    let mut launch_payload = task.payload.clone();
    launch_payload["prompt"] = Value::String(prompt);
    launch_payload["_turn"] = json!(
        task.payload
            .get("_turn")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            + 1
    );
    if !session_id.is_empty() {
        launch_payload["mode"] = Value::String("resume".to_string());
        launch_payload["sessionId"] = Value::String(session_id);
    } else if let Some(object) = launch_payload.as_object_mut() {
        object.remove("mode");
        object.remove("sessionId");
    }
    let mut event_payload: Value =
        serde_json::from_str(&payload_json).unwrap_or_else(|_| json!({}));
    event_payload["consumed"] = Value::Bool(true);
    connection.execute(
        "UPDATE task_events SET payload_json=?1,
         event_json=json_set(event_json,'$.payload.consumed',json('true')) WHERE cursor=?2",
        params![event_payload.to_string(), cursor],
    )?;
    connection.execute(
        "UPDATE task_queue SET status='queued',attempts=0,payload_json=?1,updated_at=?2,
         started_at=NULL,completed_at=NULL,next_attempt_at=?2,last_error=NULL WHERE id=?3",
        params![launch_payload.to_string(), now, task.queue_id],
    )?;
    connection.execute(
        "UPDATE tasks SET status='queued',updated_at=?1 WHERE id=?2",
        params![now, task.task_id],
    )?;
    insert_task_event(
        connection,
        &task.task_id,
        "system",
        "Turn completed; Rust scheduler queued the next resume.",
        json!({ "sessionId": launch_payload.get("sessionId").cloned().unwrap_or(Value::Null) }),
    )?;
    Ok(true)
}

fn settle_launch_failure(connection: &Connection, task: &ClaimedTask, error: &str) -> Result<()> {
    let now = now_rfc3339();
    if task.attempts < task.max_attempts {
        let delay_seconds = 2_i64.pow((task.attempts.saturating_sub(1) as u32).min(6));
        let retry_at = chrono::DateTime::<chrono::Utc>::from(
            SystemTime::now() + Duration::from_secs(delay_seconds as u64),
        )
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        connection.execute(
            "UPDATE task_queue SET status='queued',updated_at=?1,next_attempt_at=?2,last_error=?3
             WHERE id=?4",
            params![now, retry_at, error, task.queue_id],
        )?;
        connection.execute(
            "UPDATE tasks SET status='queued',updated_at=?1 WHERE id=?2",
            params![now, task.task_id],
        )?;
    } else {
        connection.execute(
            "UPDATE task_queue SET status='failed',updated_at=?1,completed_at=?1,
             next_attempt_at=NULL,last_error=?2 WHERE id=?3",
            params![now, error, task.queue_id],
        )?;
        connection.execute(
            "UPDATE tasks SET status='failed',updated_at=?1 WHERE id=?2",
            params![now, task.task_id],
        )?;
    }
    insert_task_event(
        connection,
        &task.task_id,
        "error",
        error,
        json!({ "owner": "rust-execd", "attempt": task.attempts }),
    )?;
    Ok(())
}

fn status_name(status: ExecutionStatus) -> &'static str {
    match status {
        ExecutionStatus::Starting => "starting",
        ExecutionStatus::Running => "running",
        ExecutionStatus::AwaitingApproval => "awaiting_approval",
        ExecutionStatus::Stopping => "stopping",
        ExecutionStatus::Completed => "completed",
        ExecutionStatus::Failed => "failed",
        ExecutionStatus::Cancelled => "cancelled",
        ExecutionStatus::Lost => "lost",
        ExecutionStatus::OutcomeUnknown => "outcome_unknown",
    }
}

fn attach_name(snapshot: &ExecutionSnapshot) -> &'static str {
    use super::protocol::AttachState;
    match snapshot.attach_state {
        AttachState::Attached => "attached",
        AttachState::Reconnecting => "reconnecting",
        AttachState::Unreachable => "unreachable",
        AttachState::Lost => "lost",
        AttachState::External => "external",
    }
}

fn insert_task_event(
    connection: &Connection,
    task_id: &str,
    event_type: &str,
    text: &str,
    payload: Value,
) -> Result<()> {
    insert_task_event_with_id(
        connection,
        task_id,
        &Uuid::new_v4().to_string(),
        event_type,
        text,
        payload,
        now_rfc3339(),
    )
}

fn insert_task_event_with_id(
    connection: &Connection,
    task_id: &str,
    event_id: &str,
    event_type: &str,
    text: &str,
    payload: Value,
    at: String,
) -> Result<()> {
    let event = json!({
        "id": event_id,
        "taskId": task_id,
        "type": event_type,
        "at": at,
        "text": text,
        "payload": payload
    });
    connection.execute(
        "INSERT OR IGNORE INTO task_events
         (task_id,event_id,event_type,event_at,text,payload_json,event_json,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            task_id,
            event_id,
            event_type,
            at,
            text,
            payload.to_string(),
            event.to_string(),
            now_rfc3339()
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_attempt_preserves_task_identity() {
        let id = Uuid::new_v4().to_string();
        assert_eq!(execution_id_for_attempt(&id, 0, 1).unwrap(), id);
        assert_eq!(
            execution_id_for_attempt(&id, 0, 2).unwrap(),
            execution_id_for_attempt(&id, 0, 2).unwrap()
        );
        assert_ne!(execution_id_for_attempt(&id, 0, 2).unwrap(), id);
        assert_ne!(
            execution_id_for_attempt(&id, 1, 1).unwrap(),
            execution_id_for_attempt(&id, 0, 2).unwrap()
        );
    }

    #[test]
    fn codex_task_uses_app_server_contract() {
        let dir = env::temp_dir().join(format!("vibelink-scheduler-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("settings.json"),
            r#"{"codexCommand":"C:\\tools\\codex.exe","defaultCwd":"C:\\repo","security":{"sandboxMode":"workspace-write","approvalPolicy":"on-request","networkAccess":true}}"#,
        )
        .unwrap();
        let task = ClaimedTask {
            queue_id: Uuid::new_v4().to_string(),
            task_id: Uuid::new_v4().to_string(),
            attempts: 1,
            max_attempts: 3,
            payload: json!({ "agent": "codex", "prompt": "hello", "cwd": "C:\\repo" }),
        };
        let start = build_start_params(&dir, &task, &task.task_id).unwrap();
        assert_eq!(start.kind, "provider.appServer");
        assert_eq!(start.backend, BackendKind::AppServer);
        assert_eq!(start.execution_id.as_deref(), Some(task.task_id.as_str()));
        assert!(start.app_server.is_some());
        fs::remove_dir_all(dir).unwrap();
    }
}
