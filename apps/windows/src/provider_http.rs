use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

#[derive(Clone)]
pub struct ProviderRouteConfig {
    pub data_dir: PathBuf,
    metrics: Arc<ProviderRouteMetrics>,
}

#[derive(Default)]
struct ProviderRouteMetrics {
    attempts: AtomicU64,
    responses: AtomicU64,
    fallbacks: AtomicU64,
}

impl ProviderRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            metrics: Arc::new(ProviderRouteMetrics::default()),
        }
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.fallbacks.fetch_add(1, Ordering::SeqCst);
    }
}

pub fn route_provider_request(
    request: &ParsedRequest,
    config: &ProviderRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.path() != "/api/provider-registry" || request.method != "GET" {
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
    let connection = open_provider_db(&config.data_dir)?;
    if request.query_parameter("fresh").as_deref() == Some("1") {
        refresh_provider_health(&connection, &config.data_dir)?;
    }
    let providers = builtin_providers()
        .into_iter()
        .map(|provider| merge_cached_provider(provider, &connection))
        .collect::<Result<Vec<_>>>()?;
    let default_provider = providers
        .iter()
        .find(|provider| {
            provider["id"].as_str() == Some("codex")
                && provider["available"].as_bool() == Some(true)
        })
        .or_else(|| {
            providers
                .iter()
                .find(|provider| provider["available"].as_bool() == Some(true))
        })
        .and_then(|provider| provider["id"].as_str())
        .unwrap_or("codex");
    config.metrics.responses.fetch_add(1, Ordering::SeqCst);
    Ok(Some(HttpRouteResponse::json(
        200,
        json!({
            "version": 2,
            "catalogVersion": 1,
            "defaultProvider": default_provider,
            "providers": providers,
            "generatedAt": now_iso()
        }),
    )))
}

fn open_provider_db(data_dir: &Path) -> Result<Connection> {
    let path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS provider_cache (
          provider_id TEXT PRIMARY KEY, catalog_models_json TEXT,
          catalog_status TEXT NOT NULL DEFAULT '', catalog_source TEXT NOT NULL DEFAULT '',
          catalog_fetched_at TEXT NOT NULL DEFAULT '', catalog_expires_at TEXT NOT NULL DEFAULT '',
          catalog_error TEXT NOT NULL DEFAULT '', health_ok INTEGER,
          health_status TEXT NOT NULL DEFAULT '', health_cache_status TEXT NOT NULL DEFAULT '',
          health_source TEXT NOT NULL DEFAULT '', health_checked_at TEXT NOT NULL DEFAULT '',
          health_expires_at TEXT NOT NULL DEFAULT '', health_latency_ms INTEGER,
          health_version TEXT NOT NULL DEFAULT '', health_error TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );",
    )?;
    Ok(connection)
}

fn builtin_providers() -> Vec<Value> {
    vec![
        provider(
            "codex",
            "Codex",
            "cli",
            "vibelink-host",
            "codex-app-server",
            "",
            vec!["", "gpt-5.5", "gpt-5.5[1m]", "gpt-5.4"],
            vec!["", "low", "medium", "high", "xhigh"],
            true,
            true,
            true,
            true,
            true,
            "observed",
            "complete",
            "authoritative",
        ),
        provider(
            "claude",
            "Claude",
            "cli",
            "vibelink-host",
            "claude-cli-stream-json",
            "",
            vec!["", "opus", "sonnet", "fable"],
            vec!["", "low", "medium", "high", "xhigh", "max"],
            true,
            true,
            true,
            true,
            false,
            "observed",
            "complete",
            "authoritative",
        ),
        provider(
            "doubao",
            "Doubao",
            "web",
            "external",
            "doubao-browser-bridge",
            "doubao-web",
            vec!["doubao-web"],
            vec![""],
            false,
            false,
            false,
            false,
            false,
            "unavailable",
            "sampled",
            "observed",
        ),
        provider(
            "zhipu",
            "GLM",
            "cli",
            "vibelink-host",
            "zhipu-http-cli",
            "glm-5.2",
            vec!["", "glm-5.2", "glm-5.1", "glm-5.0", "glm-4.7", "glm-4.6"],
            vec!["", "low", "medium", "high", "xhigh"],
            false,
            true,
            true,
            true,
            false,
            "unavailable",
            "complete",
            "authoritative",
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
fn provider(
    id: &str,
    label: &str,
    kind: &str,
    execution_ownership: &str,
    protocol: &str,
    default_model: &str,
    models: Vec<&str>,
    reasoning_efforts: Vec<&str>,
    resume: bool,
    model_override: bool,
    reasoning_effort: bool,
    reattach: bool,
    approval_continuation: bool,
    structured_tool_events: &str,
    tool_output: &str,
    exit_status: &str,
) -> Value {
    json!({
        "id": id,
        "label": label,
        "kind": kind,
        "available": id == "codex" || id == "doubao",
        "status": if id == "codex" || id == "doubao" { "configured" } else { "missing_credentials" },
        "reason": if id == "claude" || id == "zhipu" { format!("{label} API key is not configured.") } else { String::new() },
        "executionOwnership": execution_ownership,
        "defaultModel": default_model,
        "capabilities": {
            "modelOverride": model_override,
            "reasoningEffort": reasoning_effort,
            "resume": resume,
            "liveCallAssistant": true,
            "reattach": reattach,
            "approvalContinuation": approval_continuation,
            "liveInput": false,
            "structuredToolEvents": structured_tool_events,
            "toolOutput": tool_output,
            "exitStatus": exit_status,
            "protocol": protocol,
            "protocolVersion": "unavailable"
        },
        "fidelity": {
            "executionState": if execution_ownership == "vibelink-host" { "authoritative" } else { "observed" },
            "structuredToolEvents": structured_tool_events,
            "toolOutput": if tool_output == "complete" { "authoritative" } else { tool_output },
            "exitStatus": exit_status
        },
        "models": models.into_iter().enumerate().map(|(index, model)| json!({
            "id": model,
            "label": if model.is_empty() { "Default model" } else if model == "doubao-web" { "Web default" } else { model },
            "default": index == 0
        })).collect::<Vec<_>>(),
        "reasoningEfforts": reasoning_efforts,
        "catalog": { "status": "builtin", "source": "builtin", "fetchedAt": "", "expiresAt": "", "error": "" },
        "health": null
    })
}

fn merge_cached_provider(mut provider: Value, connection: &Connection) -> Result<Value> {
    let row = connection
        .query_row(
            "SELECT catalog_models_json,catalog_status,catalog_source,catalog_fetched_at,catalog_expires_at,catalog_error,
                    health_ok,health_status,health_cache_status,health_source,health_checked_at,health_expires_at,
                    health_latency_ms,health_version,health_error
             FROM provider_cache WHERE provider_id = ?1",
            params![provider["id"].as_str().unwrap_or_default()],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                ))
            },
        )
        .optional()?;
    let Some((
        models,
        catalog_status,
        catalog_source,
        fetched_at,
        expires_at,
        catalog_error,
        health_ok,
        health_status,
        health_cache_status,
        health_source,
        checked_at,
        health_expires_at,
        latency_ms,
        version,
        health_error,
    )) = row
    else {
        return Ok(provider);
    };
    if let Some(models) = models.and_then(|value| serde_json::from_str::<Value>(&value).ok()) {
        if models.is_array() {
            provider["models"] = models;
        }
    }
    provider["catalog"] = json!({
        "status": catalog_status,
        "source": catalog_source,
        "fetchedAt": fetched_at,
        "expiresAt": expires_at,
        "error": catalog_error
    });
    if let Some(ok) = health_ok {
        provider["health"] = json!({
            "ok": ok != 0,
            "status": health_status,
            "cacheStatus": health_cache_status,
            "source": health_source,
            "checkedAt": checked_at,
            "expiresAt": health_expires_at,
            "latencyMs": latency_ms,
            "version": version,
            "error": health_error
        });
        provider["available"] = json!(ok != 0);
        provider["status"] = json!(if ok != 0 {
            "ready"
        } else if health_status.is_empty() {
            "unavailable"
        } else {
            health_status.as_str()
        });
        provider["reason"] = json!(if ok != 0 { "" } else { health_error.as_str() });
        provider["capabilities"]["protocolVersion"] = json!(if version.is_empty() {
            "unavailable"
        } else {
            version.as_str()
        });
    }
    Ok(provider)
}

fn refresh_provider_health(connection: &Connection, data_dir: &Path) -> Result<()> {
    let settings = fs::read_to_string(data_dir.join("settings.json"))
        .ok()
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .unwrap_or_else(|| json!({}));
    for (id, setting_key, default_command, source) in [
        ("codex", "codexCommand", "codex", "codex-cli"),
        ("claude", "claudeCommand", "claude", "claude-cli"),
    ] {
        let configured = settings
            .get(setting_key)
            .and_then(Value::as_str)
            .unwrap_or(default_command);
        let health = if configured == "disabled" {
            ProviderHealth::failure(
                "disabled",
                source,
                &format!("{id} is disabled in settings."),
            )
        } else {
            let command = if configured == "auto" {
                default_command
            } else {
                configured
            };
            probe_provider_command(command, source)
        };
        cache_provider_health(connection, id, &health)?;
    }
    let doubao_disabled = settings.get("doubaoCommand").and_then(Value::as_str) == Some("disabled");
    let doubao = if doubao_disabled {
        ProviderHealth::failure(
            "disabled",
            "doubao-browser-bridge",
            "Doubao is disabled in settings.",
        )
    } else {
        ProviderHealth::failure(
            "unavailable",
            "doubao-browser-bridge",
            "Doubao browser bridge has no active Rust runtime session.",
        )
    };
    cache_provider_health(connection, "doubao", &doubao)?;
    let zhipu = ProviderHealth::failure(
        "missing_credentials",
        "zhipu-model-api",
        "GLM credentials are not available to the Rust probe.",
    );
    cache_provider_health(connection, "zhipu", &zhipu)?;
    Ok(())
}

struct ProviderHealth {
    ok: bool,
    status: String,
    source: String,
    version: String,
    latency_ms: i64,
    error: String,
}

impl ProviderHealth {
    fn failure(status: &str, source: &str, error: &str) -> Self {
        Self {
            ok: false,
            status: status.to_string(),
            source: source.to_string(),
            version: String::new(),
            latency_ms: 0,
            error: error.to_string(),
        }
    }
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

fn probe_provider_command(command_line: &str, source: &str) -> ProviderHealth {
    let parts = split_command(command_line);
    let Some(command) = parts.first() else {
        return ProviderHealth::failure("unavailable", source, "Provider command is empty.");
    };
    let started = Instant::now();
    let mut process = Command::new(command);
    process
        .args(&parts[1..])
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
    }
    let Ok(mut child) = process.spawn() else {
        return ProviderHealth::failure("unavailable", source, "Provider command is unavailable.");
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().ok();
                let version = output
                    .as_ref()
                    .map(|output| String::from_utf8_lossy(&output.stdout))
                    .unwrap_or_default()
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .chars()
                    .take(160)
                    .collect::<String>();
                return ProviderHealth {
                    ok: status.success(),
                    status: if status.success() {
                        "ready"
                    } else {
                        "unavailable"
                    }
                    .to_string(),
                    source: source.to_string(),
                    version,
                    latency_ms: started.elapsed().as_millis() as i64,
                    error: if status.success() {
                        String::new()
                    } else {
                        "Provider command probe failed.".to_string()
                    },
                };
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return ProviderHealth::failure(
                    "unavailable",
                    source,
                    "Provider command probe timed out.",
                );
            }
        }
    }
}

fn cache_provider_health(
    connection: &Connection,
    provider_id: &str,
    health: &ProviderHealth,
) -> Result<()> {
    let at = now_iso();
    connection.execute(
        "INSERT INTO provider_cache (
           provider_id,health_ok,health_status,health_cache_status,health_source,
           health_checked_at,health_expires_at,health_latency_ms,health_version,health_error,updated_at
         ) VALUES (?1,?2,?3,'fresh',?4,?5,?5,?6,?7,?8,?5)
         ON CONFLICT(provider_id) DO UPDATE SET
           health_ok=excluded.health_ok,health_status=excluded.health_status,
           health_cache_status='fresh',health_source=excluded.health_source,
           health_checked_at=excluded.health_checked_at,health_expires_at=excluded.health_expires_at,
           health_latency_ms=excluded.health_latency_ms,health_version=excluded.health_version,
           health_error=excluded.health_error,updated_at=excluded.updated_at",
        params![
            provider_id,
            i64::from(health.ok),
            health.status,
            health.source,
            at,
            health.latency_ms,
            health.version,
            health.error
        ],
    )?;
    Ok(())
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

    #[test]
    fn serves_cached_provider_fidelity_without_forcing_a_probe() {
        let dir =
            std::env::temp_dir().join(format!("vibelink-provider-http-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("settings.json"),
            r#"{"pairingToken":"pair","hostAllowlist":[]}"#,
        )
        .unwrap();
        let db = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE devices(id TEXT PRIMARY KEY,label TEXT,token_hash TEXT UNIQUE,created_at TEXT,last_seen_at TEXT,revoked_at TEXT,expires_at TEXT,rotated_at TEXT,meta_json TEXT);").unwrap();
        db.execute(
            "INSERT INTO devices VALUES ('d','Device',?1,'now',NULL,NULL,NULL,NULL,NULL)",
            params![hash_token("token")],
        )
        .unwrap();
        let config = ProviderRouteConfig::new(dir.clone());
        let request = parse_request(b"GET /api/provider-registry HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let response = route_provider_request(&request, &config).unwrap().unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["version"], 2);
        assert_eq!(response.body["defaultProvider"], "codex");
        assert_eq!(response.body["providers"].as_array().unwrap().len(), 4);
        assert_eq!(response.body["providers"][0]["available"], true);
        assert_eq!(response.body["providers"][0]["status"], "configured");
        assert_eq!(response.body["providers"][0]["models"][0]["default"], true);
        assert_eq!(
            response.body["providers"][0]["reasoningEfforts"][4],
            "xhigh"
        );
        assert_eq!(
            response.body["providers"][0]["fidelity"]["executionState"],
            "authoritative"
        );
        assert_eq!(
            response.body["providers"][0]["capabilities"]["reattach"],
            true
        );
        assert_eq!(
            response.body["providers"][0]["capabilities"]["liveInput"],
            false
        );
        assert_eq!(
            response.body["providers"][2]["capabilities"]["modelOverride"],
            false
        );
        assert_eq!(
            response.body["providers"][2]["capabilities"]["liveCallAssistant"],
            true
        );
        assert!(response.body.get("items").is_none());
        fs::write(
            dir.join("settings.json"),
            r#"{"pairingToken":"pair","hostAllowlist":[],"codexCommand":"disabled","claudeCommand":"disabled","doubaoCommand":"disabled"}"#,
        )
        .unwrap();
        let fresh = parse_request(b"GET /api/provider-registry?fresh=1 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let fresh_response = route_provider_request(&fresh, &config).unwrap().unwrap();
        assert_eq!(fresh_response.body["providers"][0]["status"], "disabled");
        assert_eq!(fresh_response.body["providers"][1]["status"], "disabled");
        assert_eq!(fresh_response.body["providers"][2]["status"], "disabled");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cached_health_controls_provider_readiness_without_changing_fidelity() {
        let dir =
            std::env::temp_dir().join(format!("vibelink-provider-http-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("settings.json"),
            r#"{"pairingToken":"pair","hostAllowlist":[]}"#,
        )
        .unwrap();
        let db = Connection::open(dir.join("mobile-agent.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE devices(id TEXT PRIMARY KEY,label TEXT,token_hash TEXT UNIQUE,created_at TEXT,last_seen_at TEXT,revoked_at TEXT,expires_at TEXT,rotated_at TEXT,meta_json TEXT);
             CREATE TABLE provider_cache (
               provider_id TEXT PRIMARY KEY, catalog_models_json TEXT,
               catalog_status TEXT NOT NULL DEFAULT '', catalog_source TEXT NOT NULL DEFAULT '',
               catalog_fetched_at TEXT NOT NULL DEFAULT '', catalog_expires_at TEXT NOT NULL DEFAULT '',
               catalog_error TEXT NOT NULL DEFAULT '', health_ok INTEGER,
               health_status TEXT NOT NULL DEFAULT '', health_cache_status TEXT NOT NULL DEFAULT '',
               health_source TEXT NOT NULL DEFAULT '', health_checked_at TEXT NOT NULL DEFAULT '',
               health_expires_at TEXT NOT NULL DEFAULT '', health_latency_ms INTEGER,
               health_version TEXT NOT NULL DEFAULT '', health_error TEXT NOT NULL DEFAULT '',
               updated_at TEXT NOT NULL
             );",
        ).unwrap();
        db.execute(
            "INSERT INTO devices VALUES ('d','Device',?1,'now',NULL,NULL,NULL,NULL,NULL)",
            params![hash_token("token")],
        )
        .unwrap();
        db.execute(
            "INSERT INTO provider_cache (
              provider_id,health_ok,health_status,health_cache_status,health_source,
              health_checked_at,health_expires_at,health_latency_ms,health_version,health_error,updated_at
             ) VALUES ('claude',0,'unavailable','fresh','claude-cli','now','later',12,'','Claude is unavailable.','now')",
            [],
        ).unwrap();
        let config = ProviderRouteConfig::new(dir.clone());
        let request = parse_request(b"GET /api/provider-registry HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let response = route_provider_request(&request, &config).unwrap().unwrap();
        let claude = response.body["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|provider| provider["id"] == "claude")
            .unwrap();
        assert_eq!(claude["available"], false);
        assert_eq!(claude["status"], "unavailable");
        assert_eq!(claude["reason"], "Claude is unavailable.");
        assert_eq!(claude["fidelity"]["executionState"], "authoritative");
        assert_eq!(claude["capabilities"]["protocolVersion"], "unavailable");
        let _ = fs::remove_dir_all(dir);
    }
}
