use crate::settings_credentials;
use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;
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
            let command = if id == "codex" {
                resolve_codex_probe_command(configured)
            } else if configured == "auto" {
                default_command.to_string()
            } else {
                configured.to_string()
            };
            let mut health = probe_provider_command(&command, source);
            if id == "codex" && health.ok {
                let auth = probe_provider_args(&command, &["login", "status"], source);
                if !auth.ok {
                    health.ok = false;
                    health.status = "unavailable".to_string();
                    health.error = "Codex authentication is not ready.".to_string();
                    health.latency_ms += auth.latency_ms;
                }
            }
            health
        };
        cache_provider_health(connection, id, &health)?;
    }
    let doubao_configured = settings
        .get("doubaoCommand")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let doubao = if doubao_configured == "disabled" {
        ProviderHealth::failure(
            "disabled",
            "doubao-browser-bridge",
            "Doubao is disabled in settings.",
        )
    } else {
        probe_doubao_bridge(&settings, doubao_configured)
    };
    cache_provider_health(connection, "doubao", &doubao)?;
    refresh_remote_catalog(
        connection,
        data_dir,
        &settings,
        "claude",
        "anthropic",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODELS_URL",
        "https://api.anthropic.com/v1/models",
        "anthropic-model-api",
    )?;
    let zhipu = match refresh_remote_catalog(
        connection,
        data_dir,
        &settings,
        "zhipu",
        "zhipu",
        "ZHIPU_API_KEY",
        "ZHIPU_MODELS_URL",
        "https://open.bigmodel.cn/api/paas/v4/models",
        "zhipu-model-api",
    )? {
        CatalogRefresh::Ready(latency_ms) => ProviderHealth {
            ok: true,
            status: "ready".to_string(),
            source: "zhipu-model-api".to_string(),
            version: "v4".to_string(),
            latency_ms,
            error: String::new(),
        },
        CatalogRefresh::MissingCredentials => ProviderHealth::failure(
            "missing_credentials",
            "zhipu-model-api",
            "GLM API key is not configured.",
        ),
        CatalogRefresh::Failed(error) => {
            ProviderHealth::failure("unavailable", "zhipu-model-api", &error)
        }
    };
    cache_provider_health(connection, "zhipu", &zhipu)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn refresh_remote_catalog(
    connection: &Connection,
    data_dir: &Path,
    settings: &Value,
    provider_id: &str,
    secret_name: &str,
    environment_key: &str,
    url_environment_key: &str,
    default_url: &str,
    source: &str,
) -> Result<CatalogRefresh> {
    let secret = std::env::var(environment_key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            settings
                .get("apiKeys")
                .and_then(|value| value.get(secret_name))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            settings_credentials::read_secret(data_dir, secret_name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        });
    let Some(secret) = secret else {
        cache_catalog_error(
            connection,
            provider_id,
            "missing_credentials",
            source,
            &format!("{provider_id} API key is not configured."),
        )?;
        return Ok(CatalogRefresh::MissingCredentials);
    };
    let url = std::env::var(url_environment_key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_url.to_string());
    let started = Instant::now();
    let mut request = ureq::get(&url)
        .timeout(Duration::from_secs(8))
        .set("Accept", "application/json");
    request = if provider_id == "claude" {
        request
            .set("anthropic-version", "2023-06-01")
            .set("x-api-key", &secret)
    } else {
        request.set("Authorization", &format!("Bearer {secret}"))
    };
    let payload = match request.call() {
        Ok(response) => response
            .into_json::<Value>()
            .context("Provider model API returned invalid JSON"),
        Err(error) => Err(anyhow::anyhow!(
            "Provider model API request failed: {}",
            match error {
                ureq::Error::Status(status, _) => format!("HTTP {status}"),
                other => other.to_string(),
            }
        )),
    };
    let payload = match payload {
        Ok(payload) => payload,
        Err(error) => {
            cache_catalog_error(connection, provider_id, "stale", source, &error.to_string())?;
            return Ok(CatalogRefresh::Failed(error.to_string()));
        }
    };
    let raw_models = payload
        .get("data")
        .or_else(|| payload.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen = HashSet::new();
    let mut models = vec![json!({
        "id": "",
        "label": "Default model",
        "default": true
    })];
    for model in raw_models {
        let id = model
            .as_str()
            .or_else(|| model.get("id").and_then(Value::as_str))
            .or_else(|| model.get("model").and_then(Value::as_str))
            .unwrap_or("")
            .chars()
            .filter(|character| !character.is_control())
            .take(160)
            .collect::<String>();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let label = model
            .get("display_name")
            .or_else(|| model.get("displayName"))
            .or_else(|| model.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .chars()
            .filter(|character| !character.is_control())
            .take(160)
            .collect::<String>();
        models.push(json!({ "id": id, "label": label, "default": false }));
    }
    if models.len() == 1 {
        cache_catalog_error(
            connection,
            provider_id,
            "stale",
            source,
            "Provider model API returned no usable models.",
        )?;
        return Ok(CatalogRefresh::Failed(
            "Provider model API returned no usable models.".to_string(),
        ));
    }
    let latency_ms = started.elapsed().as_millis() as i64;
    cache_provider_catalog(connection, provider_id, &models, source)?;
    Ok(CatalogRefresh::Ready(latency_ms))
}

enum CatalogRefresh {
    MissingCredentials,
    Ready(i64),
    Failed(String),
}

fn cache_provider_catalog(
    connection: &Connection,
    provider_id: &str,
    models: &[Value],
    source: &str,
) -> Result<()> {
    let at = now_iso();
    connection.execute(
        "INSERT INTO provider_cache (
           provider_id,catalog_models_json,catalog_status,catalog_source,catalog_fetched_at,
           catalog_expires_at,catalog_error,updated_at
         ) VALUES (?1,?2,'fresh',?3,?4,?4,'',?4)
         ON CONFLICT(provider_id) DO UPDATE SET
           catalog_models_json=excluded.catalog_models_json,catalog_status='fresh',
           catalog_source=excluded.catalog_source,catalog_fetched_at=excluded.catalog_fetched_at,
           catalog_expires_at=excluded.catalog_expires_at,catalog_error='',updated_at=excluded.updated_at",
        params![provider_id, serde_json::to_string(models)?, source, at],
    )?;
    Ok(())
}

fn cache_catalog_error(
    connection: &Connection,
    provider_id: &str,
    status: &str,
    source: &str,
    error: &str,
) -> Result<()> {
    let at = now_iso();
    connection.execute(
        "INSERT INTO provider_cache (
           provider_id,catalog_status,catalog_source,catalog_error,updated_at
         ) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(provider_id) DO UPDATE SET
           catalog_status=CASE WHEN COALESCE(provider_cache.catalog_models_json,'')=''
                               THEN excluded.catalog_status ELSE 'stale' END,
           catalog_source=CASE WHEN provider_cache.catalog_source=''
                               THEN excluded.catalog_source ELSE provider_cache.catalog_source END,
           catalog_error=excluded.catalog_error,updated_at=excluded.updated_at",
        params![
            provider_id,
            status,
            source,
            error.chars().take(500).collect::<String>(),
            at
        ],
    )?;
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
    probe_provider_args(command_line, &["--version"], source)
}

fn probe_doubao_bridge(settings: &Value, configured: &str) -> ProviderHealth {
    let invocation = resolve_doubao_probe_command(configured);
    let mut args = invocation.prefix_args;
    args.extend(["doctor".to_string(), "--json".to_string()]);
    if let Some(endpoint) = settings.get("doubaoCdpEndpoint").and_then(Value::as_str) {
        if !endpoint.trim().is_empty() {
            args.extend(["--endpoint".to_string(), endpoint.to_string()]);
        }
    }
    if let Some(url) = settings.get("doubaoUrl").and_then(Value::as_str) {
        if !url.trim().is_empty() {
            args.extend(["--url".to_string(), url.to_string()]);
        }
    }
    let result = probe_command_args(&invocation.command, &args, "doubao-browser-bridge");
    if !result.ok {
        return ProviderHealth::failure(
            "unavailable",
            "doubao-browser-bridge",
            &bounded_doubao_error(&result.stdout, &result.stderr),
        );
    }
    let payload = result
        .stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .and_then(|line| serde_json::from_str::<Value>(line).ok())
        .unwrap_or_else(|| json!({}));
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        ProviderHealth {
            ok: true,
            status: "ready".to_string(),
            source: "doubao-browser-bridge".to_string(),
            version: payload
                .get("version")
                .or_else(|| payload.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or("doubao-web")
                .chars()
                .take(160)
                .collect(),
            latency_ms: result.latency_ms,
            error: String::new(),
        }
    } else {
        ProviderHealth::failure(
            "unavailable",
            "doubao-browser-bridge",
            &bounded_doubao_error(&payload.to_string(), &result.stderr),
        )
    }
}

struct CommandProbeResult {
    ok: bool,
    stdout: String,
    stderr: String,
    latency_ms: i64,
}

fn probe_provider_args(command_line: &str, args: &[&str], source: &str) -> ProviderHealth {
    let parts = split_command(command_line);
    let Some(command) = parts.first() else {
        return ProviderHealth::failure("unavailable", source, "Provider command is empty.");
    };
    let mut probe_args = parts[1..].to_vec();
    probe_args.extend(args.iter().map(|value| value.to_string()));
    let result = probe_command_args(command, &probe_args, source);
    ProviderHealth {
        ok: result.ok,
        status: if result.ok { "ready" } else { "unavailable" }.to_string(),
        source: source.to_string(),
        version: result
            .stdout
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .chars()
            .take(160)
            .collect::<String>(),
        latency_ms: result.latency_ms,
        error: if result.ok {
            String::new()
        } else if result.stderr.trim().is_empty() {
            "Provider command probe failed.".to_string()
        } else {
            result
                .stderr
                .lines()
                .next()
                .unwrap_or("Provider command probe failed.")
                .chars()
                .take(500)
                .collect()
        },
    }
}

fn probe_command_args(command: &str, args: &[String], source: &str) -> CommandProbeResult {
    let started = Instant::now();
    let mut process = Command::new(command);
    process
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
    }
    let Ok(mut child) = process.spawn() else {
        return CommandProbeResult {
            ok: false,
            stdout: String::new(),
            stderr: format!("{source} command is unavailable."),
            latency_ms: started.elapsed().as_millis() as i64,
        };
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().ok();
                return CommandProbeResult {
                    ok: status.success(),
                    stdout: output
                        .as_ref()
                        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
                        .unwrap_or_default(),
                    stderr: output
                        .as_ref()
                        .map(|output| String::from_utf8_lossy(&output.stderr).into_owned())
                        .unwrap_or_default(),
                    latency_ms: started.elapsed().as_millis() as i64,
                };
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return CommandProbeResult {
                    ok: false,
                    stdout: String::new(),
                    stderr: format!("{source} command probe timed out."),
                    latency_ms: started.elapsed().as_millis() as i64,
                };
            }
        }
    }
}

struct CommandInvocation {
    command: String,
    prefix_args: Vec<String>,
}

fn resolve_doubao_probe_command(configured: &str) -> CommandInvocation {
    let configured = configured.trim();
    if configured.is_empty() || configured == "auto" {
        let root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
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
        return CommandInvocation {
            command: node_command(&root),
            prefix_args: vec![script.to_string_lossy().into_owned()],
        };
    }
    let parts = split_command(configured);
    CommandInvocation {
        command: parts
            .first()
            .cloned()
            .unwrap_or_else(|| "doubao".to_string()),
        prefix_args: parts.get(1..).unwrap_or(&[]).to_vec(),
    }
}

fn node_command(root: &Path) -> String {
    std::env::var("VIBELINK_NODE_COMMAND")
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

fn bounded_doubao_error(stdout: &str, stderr: &str) -> String {
    for candidate in [stderr, stdout] {
        let text = candidate.trim();
        if text.is_empty() {
            continue;
        }
        let line = text
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or(text);
        if let Ok(payload) = serde_json::from_str::<Value>(line) {
            if let Some(message) = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .or_else(|| {
                    payload
                        .get("status")
                        .and_then(|status| status.get("target"))
                        .and_then(|target| target.get("reason"))
                        .and_then(Value::as_str)
                })
            {
                return message.chars().take(500).collect();
            }
        }
        return line.chars().take(500).collect();
    }
    "Doubao browser bridge is not ready.".to_string()
}

fn resolve_codex_probe_command(configured: &str) -> String {
    if !configured.is_empty()
        && configured != "auto"
        && !configured.eq_ignore_ascii_case("codex")
        && !configured.eq_ignore_ascii_case("codex.exe")
    {
        return configured.to_string();
    }
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return "codex".to_string();
    };
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
    candidates
        .into_iter()
        .max_by_key(|path| {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
        })
        .map(|path| format!("\"{}\"", path.to_string_lossy()))
        .unwrap_or_else(|| "codex".to_string())
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
    use std::io::{Read, Write};
    use std::net::TcpListener;

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

    #[test]
    fn rust_model_probe_persists_zhipu_catalog_and_health_source() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let bytes = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..bytes]);
            assert!(request.contains("Authorization: Bearer test-key"));
            let body = r#"{"data":[{"id":"glm-test","name":"GLM Test"}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let dir =
            std::env::temp_dir().join(format!("vibelink-provider-http-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("settings.json"), "{}").unwrap();
        Connection::open(dir.join("mobile-agent.sqlite"))
            .unwrap()
            .close()
            .unwrap();
        let connection = open_provider_db(&dir).unwrap();
        let settings = json!({ "apiKeys": { "zhipu": "test-key" } });
        let result = refresh_remote_catalog(
            &connection,
            &dir,
            &settings,
            "zhipu",
            "zhipu",
            "VIBELINK_TEST_ZHIPU_KEY",
            "VIBELINK_TEST_ZHIPU_URL",
            &format!("http://{address}/models"),
            "zhipu-model-api",
        )
        .unwrap();
        assert!(matches!(result, CatalogRefresh::Ready(_)));
        let cached =
            merge_cached_provider(builtin_providers().pop().unwrap(), &connection).unwrap();
        assert_eq!(cached["catalog"]["status"], "fresh");
        assert_eq!(cached["catalog"]["source"], "zhipu-model-api");
        assert_eq!(cached["models"][1]["id"], "glm-test");
        assert!(!cached.to_string().contains("test-key"));
        server.join().unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn doubao_fresh_probe_uses_real_doctor_status_for_readiness() {
        let dir =
            std::env::temp_dir().join(format!("vibelink-provider-http-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let probe = dir.join("doubao-ready.cmd");
        fs::write(
            &probe,
            r#"@echo off
echo {"ok":true,"status":{"target":{"url":"https://www.doubao.com/chat/"}}}
"#,
        )
        .unwrap();
        fs::write(
            dir.join("settings.json"),
            json!({
                "pairingToken": "pair",
                "hostAllowlist": [],
                "doubaoCommand": format!("cmd.exe /C \"{}\"", probe.to_string_lossy())
            })
            .to_string(),
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
        let request = parse_request(b"GET /api/provider-registry?fresh=1 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let response = route_provider_request(&request, &config).unwrap().unwrap();
        let doubao = response.body["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|provider| provider["id"] == "doubao")
            .unwrap();
        assert_eq!(doubao["available"], true);
        assert_eq!(doubao["status"], "ready");
        assert_eq!(doubao["health"]["source"], "doubao-browser-bridge");
        assert_eq!(doubao["capabilities"]["protocolVersion"], "doubao-web");
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn doubao_fresh_probe_reports_bounded_bridge_failure() {
        let dir =
            std::env::temp_dir().join(format!("vibelink-provider-http-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let probe = dir.join("doubao-offline.cmd");
        fs::write(
            &probe,
            r#"@echo off
echo {"ok":false,"error":{"message":"extension offline"}}
exit /b 1
"#,
        )
        .unwrap();
        let health = probe_doubao_bridge(
            &json!({}),
            &format!("cmd.exe /C \"{}\"", probe.to_string_lossy()),
        );
        assert!(!health.ok);
        assert_eq!(health.status, "unavailable");
        assert_eq!(health.source, "doubao-browser-bridge");
        assert_eq!(health.error, "extension offline");
        let _ = fs::remove_dir_all(dir);
    }
}
