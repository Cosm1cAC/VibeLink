use crate::settings_contract::{
    build_settings_export, default_settings, import_settings_snapshot, load_settings,
    merge_mcp_settings, sanitize_settings_patch, summarize_settings_import,
};
use crate::settings_credentials::{
    public_credential_state, restore_secret_snapshots, write_requested_secrets,
};
use crate::status_http::{
    authenticate_route_request, clean_host, HttpRouteResponse, ParsedRequest, RouteAuthentication,
    RouteMetrics,
};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone)]
pub struct SettingsRouteConfig {
    data_dir: PathBuf,
    root_dir: PathBuf,
    internal_settings: Option<InternalSettingsConfig>,
    mutation_lock: Arc<Mutex<()>>,
    metrics: Arc<RouteMetrics>,
}

#[derive(Debug, Clone)]
struct InternalSettingsConfig {
    upstream: SocketAddr,
    token: String,
}

struct SettingsMutationMetadata<'a> {
    event_type: &'a str,
    audit: &'a Value,
    response: &'a Value,
}

impl SettingsRouteConfig {
    pub fn new(data_dir: PathBuf, root_dir: PathBuf) -> Self {
        Self {
            data_dir,
            root_dir,
            internal_settings: None,
            mutation_lock: Arc::new(Mutex::new(())),
            metrics: Arc::new(RouteMetrics::default()),
        }
    }

    pub fn with_internal_settings(mut self, upstream: SocketAddr, token: String) -> Self {
        self.internal_settings = Some(InternalSettingsConfig { upstream, token });
        self
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.record_fallback();
    }
}

pub fn settings_request_requires_body(request: &ParsedRequest) -> bool {
    request.method == "POST" && matches!(request.path(), "/api/settings" | "/api/settings/import")
}

pub fn route_settings_request(
    request: &ParsedRequest,
    peer_ip: &str,
    config: &SettingsRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "GET"
        || !matches!(request.path(), "/api/settings" | "/api/settings/export")
    {
        return Ok(None);
    }

    let authentication = authenticate_route_request(request, &config.data_dir)?;
    if authentication == RouteAuthentication::Pending {
        return Ok(None);
    }
    config.metrics.record_attempt();
    let request_ip = forwarded_ip(request).unwrap_or(peer_ip);
    let device_id = match authentication {
        RouteAuthentication::HostDenied => {
            audit_only(
                &config.data_dir,
                request,
                request_ip,
                "",
                "host.blocked",
                false,
                "Host is not allowed.",
                &clean_host(request.host()),
                &json!({}),
            )?;
            config.metrics.record_host_denied();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")));
        }
        RouteAuthentication::Unauthorized => {
            audit_only(
                &config.data_dir,
                request,
                request_ip,
                "",
                "auth.failed",
                false,
                if request.token().is_empty() {
                    "missing_token"
                } else {
                    "invalid_or_expired_token"
                },
                "",
                &json!({}),
            )?;
            config.metrics.record_unauthorized();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(401, "Unauthorized")));
        }
        RouteAuthentication::Device(device_id) => device_id,
        RouteAuthentication::Pending => unreachable!(),
    };

    let settings = load_settings(&config.data_dir, &config.root_dir)?;
    let (body, event_type, headers) = if request.path() == "/api/settings" {
        let public = fetch_public_settings(config)
            .unwrap_or_else(|_| project_public_settings(&settings, &config.data_dir));
        (
            json!({ "settings": public }),
            "settings.read",
            vec![(
                "ETag".to_string(),
                revision_etag(settings_revision(&settings)),
            )],
        )
    } else {
        (
            build_settings_export(&settings)?,
            "settings.export",
            Vec::new(),
        )
    };
    audit_only(
        &config.data_dir,
        request,
        request_ip,
        &device_id,
        event_type,
        true,
        "",
        "",
        &json!({}),
    )?;
    config.metrics.record_response();
    Ok(Some(
        HttpRouteResponse::json(200, body).with_headers(headers),
    ))
}

pub fn route_settings_request_with_body(
    request: &ParsedRequest,
    peer_ip: &str,
    body: Option<&[u8]>,
    config: &SettingsRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if !settings_request_requires_body(request) {
        return route_settings_request(request, peer_ip, config);
    }

    let authentication = authenticate_route_request(request, &config.data_dir)?;
    if authentication == RouteAuthentication::Pending {
        return Ok(None);
    }
    config.metrics.record_attempt();
    let request_ip = forwarded_ip(request).unwrap_or(peer_ip);
    let device_id = match authentication {
        RouteAuthentication::HostDenied => {
            audit_only(
                &config.data_dir,
                request,
                request_ip,
                "",
                "host.blocked",
                false,
                "Host is not allowed.",
                &clean_host(request.host()),
                &json!({}),
            )?;
            config.metrics.record_host_denied();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")));
        }
        RouteAuthentication::Unauthorized => {
            audit_only(
                &config.data_dir,
                request,
                request_ip,
                "",
                "auth.failed",
                false,
                if request.token().is_empty() {
                    "missing_token"
                } else {
                    "invalid_or_expired_token"
                },
                "",
                &json!({}),
            )?;
            config.metrics.record_unauthorized();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(401, "Unauthorized")));
        }
        RouteAuthentication::Device(device_id) => device_id,
        RouteAuthentication::Pending => unreachable!(),
    };
    let body = parse_json_body(body.unwrap_or_default());
    let _mutation_guard = config
        .mutation_lock
        .lock()
        .map_err(|_| anyhow::anyhow!("Settings mutation lock is poisoned"))?;

    let result = if request.path() == "/api/settings" {
        update_settings(request, request_ip, &device_id, &body, config)
    } else {
        import_settings(request, request_ip, &device_id, &body, config)
    };
    let response = match result {
        Ok(response) => response,
        Err(error) => {
            config.metrics.record_failure();
            eprintln!("Rust Settings mutation failed without Node replay: {error:#}");
            HttpRouteResponse::error(500, "Settings operation failed.")
        }
    };
    config.metrics.record_response();
    Ok(Some(response))
}

fn settings_revision(settings: &Value) -> u64 {
    settings
        .get("revision")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn revision_etag(revision: u64) -> String {
    format!("\"vibelink:settings:{revision}\"")
}

fn expected_revision(request: &ParsedRequest, body: &Value) -> Option<u64> {
    if let Some(revision) = body.get("expectedRevision").and_then(Value::as_u64) {
        return Some(revision);
    }
    let value = request.header("if-match")?.trim();
    let value = value.strip_prefix("W/").unwrap_or(value);
    value
        .strip_prefix("\"vibelink:settings:")
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<u64>().ok())
        .or(Some(u64::MAX))
}

fn settings_patch_fields(patch: &Value) -> Vec<String> {
    fn collect(value: &Value, prefix: &str, fields: &mut Vec<String>) {
        let Some(object) = value.as_object() else {
            if !prefix.is_empty() {
                fields.push(prefix.to_string());
            }
            return;
        };
        for (key, child) in object {
            if matches!(
                key.as_str(),
                "expectedRevision" | "revision" | "_fieldRevisions"
            ) {
                continue;
            }
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            if child.is_object() {
                collect(child, &path, fields);
            } else {
                fields.push(path);
            }
        }
    }

    let mut fields = Vec::new();
    collect(patch, "", &mut fields);
    fields.sort();
    fields.dedup();
    fields
}

fn settings_conflict_response(
    request: &ParsedRequest,
    body: &Value,
    current: &Value,
    fields: &[String],
    config: &SettingsRouteConfig,
) -> Option<HttpRouteResponse> {
    let expected = expected_revision(request, body)?;
    let actual = settings_revision(current);
    if expected == actual {
        return None;
    }
    let field_revisions = current.get("_fieldRevisions").and_then(Value::as_object);
    let conflicting = if expected > actual {
        fields.to_vec()
    } else {
        fields
            .iter()
            .filter(|field| {
                field_revisions
                    .and_then(|revisions| revisions.get(field.as_str()))
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    > expected
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    if conflicting.is_empty() {
        return None;
    }
    let public = project_public_settings(current, &config.data_dir);
    Some(
        HttpRouteResponse::json(
            409,
            json!({
                "error": "Settings changed on another device.",
                "code": "SETTINGS_CONFLICT",
                "expectedRevision": expected,
                "actualRevision": actual,
                "conflictingFields": conflicting,
                "current": { "settings": public }
            }),
        )
        .with_headers(vec![("ETag".to_string(), revision_etag(actual))]),
    )
}

fn bump_settings_revision(mut next: Value, current: &Value, fields: &[String]) -> Value {
    if fields.is_empty() {
        return next;
    }
    let revision = settings_revision(current) + 1;
    let mut field_revisions = current
        .get("_fieldRevisions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for field in fields {
        field_revisions.insert(field.clone(), json!(revision));
    }
    if let Some(settings) = next.as_object_mut() {
        settings.insert("revision".to_string(), json!(revision));
        settings.insert(
            "_fieldRevisions".to_string(),
            Value::Object(field_revisions),
        );
    }
    next
}

fn update_settings(
    request: &ParsedRequest,
    request_ip: &str,
    device_id: &str,
    body: &Value,
    config: &SettingsRouteConfig,
) -> Result<HttpRouteResponse> {
    let issues = validate_settings_patch(body);
    if !issues.is_empty() {
        return Ok(HttpRouteResponse::json(
            400,
            json!({ "error": "Validation failed", "details": issues }),
        ));
    }
    let current = load_settings(&config.data_dir, &config.root_dir)?;
    let patch = sanitize_settings_patch(body)?;
    let fields = settings_patch_fields(&patch);
    if let Some(response) = settings_conflict_response(request, body, &current, &fields, config) {
        return Ok(response);
    }
    if is_dry_run(request) {
        let current_public = fetch_public_settings(config)
            .unwrap_or_else(|_| project_public_settings(&current, &config.data_dir));
        let mut diff = serde_json::Map::new();
        if let Some(patch) = patch.as_object() {
            for (key, value) in patch {
                diff.insert(
                    key.clone(),
                    json!({ "from": current_public.get(key).cloned().unwrap_or(Value::Null), "to": value }),
                );
            }
        }
        return Ok(HttpRouteResponse::json(
            200,
            json!({
                "dryRun": true,
                "wouldChange": !diff.is_empty(),
                "diff": diff
            }),
        )
        .with_headers(vec![(
            "ETag".to_string(),
            revision_etag(settings_revision(&current)),
        )]));
    }

    let next = bump_settings_revision(apply_update_patch(&current, &patch), &current, &fields);
    let (credential_results, credential_snapshots) =
        write_requested_secrets(&config.data_dir, &patch, body)?;
    let keys = patch
        .as_object()
        .map(|value| value.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let audit_meta = json!({ "keys": keys, "credentials": credential_results });
    let response_meta = json!({});
    let result = persist_and_reload(
        request,
        request_ip,
        device_id,
        &next,
        SettingsMutationMetadata {
            event_type: "settings.update",
            audit: &audit_meta,
            response: &response_meta,
        },
        config,
    );
    match result {
        Ok(response) => Ok(response),
        Err(error) => {
            restore_secret_snapshots(&credential_snapshots)
                .context("Cannot restore credentials after settings failure")?;
            Err(error)
        }
    }
}

fn import_settings(
    request: &ParsedRequest,
    request_ip: &str,
    device_id: &str,
    body: &Value,
    config: &SettingsRouteConfig,
) -> Result<HttpRouteResponse> {
    let current = load_settings(&config.data_dir, &config.root_dir)?;
    let imported = import_settings_snapshot(&default_settings(&config.root_dir), &current, body)?;
    let fields = settings_patch_fields(body.get("settings").unwrap_or(body));
    if let Some(response) = settings_conflict_response(request, body, &current, &fields, config) {
        return Ok(response);
    }
    let summary = summarize_settings_import(&current, &imported);
    let dry_run =
        is_dry_run(request) || body.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
    if dry_run {
        let mut response = summary.as_object().cloned().unwrap_or_default();
        response.insert("dryRun".to_string(), Value::Bool(true));
        response.insert(
            "settings".to_string(),
            project_public_settings(&imported, &config.data_dir),
        );
        return Ok(HttpRouteResponse::json(200, Value::Object(response)));
    }
    let next = bump_settings_revision(imported, &current, &fields);
    persist_and_reload(
        request,
        request_ip,
        device_id,
        &next,
        SettingsMutationMetadata {
            event_type: "settings.import",
            audit: &summary,
            response: &summary,
        },
        config,
    )
}

fn persist_and_reload(
    request: &ParsedRequest,
    request_ip: &str,
    device_id: &str,
    next: &Value,
    metadata: SettingsMutationMetadata<'_>,
    config: &SettingsRouteConfig,
) -> Result<HttpRouteResponse> {
    let path = config.data_dir.join("settings.json");
    let original =
        fs::read(&path).with_context(|| format!("Cannot snapshot {}", path.display()))?;
    let safe = settings_for_disk(next);
    let serialized = serde_json::to_vec_pretty(&safe).context("Cannot serialize settings")?;
    let mut serialized_with_newline = serialized;
    serialized_with_newline.push(b'\n');
    atomic_replace(&path, &serialized_with_newline)?;

    let public = match reload_internal_settings(config) {
        Ok(public) => public,
        Err(error) => {
            let rollback = atomic_replace(&path, &original);
            let _ = reload_internal_settings(config);
            rollback.context("Cannot restore settings after reload failure")?;
            return Err(error).context("Cannot synchronize hybrid Node settings");
        }
    };
    if let Err(error) = audit_only(
        &config.data_dir,
        request,
        request_ip,
        device_id,
        metadata.event_type,
        true,
        "",
        "",
        metadata.audit,
    ) {
        atomic_replace(&path, &original).context("Cannot restore settings after audit failure")?;
        let _ = reload_internal_settings(config);
        return Err(error).context("Cannot audit settings mutation");
    }
    let mut response = metadata.response.as_object().cloned().unwrap_or_default();
    response.insert("ok".to_string(), Value::Bool(true));
    response.insert("settings".to_string(), public);
    Ok(
        HttpRouteResponse::json(200, Value::Object(response)).with_headers(vec![(
            "ETag".to_string(),
            revision_etag(settings_revision(next)),
        )]),
    )
}

fn apply_update_patch(current: &Value, patch: &Value) -> Value {
    let mut next = current.as_object().cloned().unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        for (key, value) in patch {
            if matches!(
                key.as_str(),
                "security" | "toolEvents" | "codebaseMemory" | "webPush" | "nativePush"
            ) {
                next.insert(key.clone(), merge_objects(current.get(key), Some(value)));
            } else {
                next.insert(key.clone(), value.clone());
            }
        }
        if let Some(mcp) = patch.get("mcp") {
            next.insert(
                "mcp".to_string(),
                merge_mcp_settings(current.get("mcp").unwrap_or(&Value::Null), mcp),
            );
        }
    }
    next.insert(
        "apiKeys".to_string(),
        current.get("apiKeys").cloned().unwrap_or_else(|| json!({})),
    );
    Value::Object(next)
}

fn settings_for_disk(settings: &Value) -> Value {
    let mut safe = settings.as_object().cloned().unwrap_or_default();
    safe.insert(
        "apiKeys".to_string(),
        json!({ "openai": "", "anthropic": "", "zhipu": "" }),
    );
    Value::Object(safe)
}

fn atomic_replace(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path.parent().context("Settings path has no parent")?;
    fs::create_dir_all(parent).with_context(|| format!("Cannot create {}", parent.display()))?;
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(".settings-{}-{nonce}.tmp", std::process::id()));
    let backup = parent.join(format!(".settings-{}-{nonce}.bak", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .with_context(|| format!("Cannot create {}", temp.display()))?;
    file.write_all(content)
        .with_context(|| format!("Cannot write {}", temp.display()))?;
    file.sync_all()
        .with_context(|| format!("Cannot sync {}", temp.display()))?;
    drop(file);

    let had_original = path.exists();
    if had_original {
        fs::rename(path, &backup)
            .with_context(|| format!("Cannot move {} to {}", path.display(), backup.display()))?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if had_original {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temp);
        return Err(error).with_context(|| format!("Cannot replace {}", path.display()));
    }
    if had_original {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

fn reload_internal_settings(config: &SettingsRouteConfig) -> Result<Value> {
    let internal = config
        .internal_settings
        .as_ref()
        .context("Hybrid Node settings synchronization is not configured")?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(5))
        .timeout_write(Duration::from_secs(2))
        .build();
    let response = agent
        .post(&format!(
            "http://{}/internal/reload-settings",
            internal.upstream
        ))
        .set("X-VibeLink-Internal-Token", &internal.token)
        .call()
        .context("Internal settings reload request failed")?;
    response
        .into_json::<Value>()
        .context("Cannot parse internal settings reload response")
}

fn fetch_public_settings(config: &SettingsRouteConfig) -> Result<Value> {
    let internal = config
        .internal_settings
        .as_ref()
        .context("Hybrid Node public settings endpoint is not configured")?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(5))
        .timeout_write(Duration::from_secs(2))
        .build();
    let response = agent
        .get(&format!(
            "http://{}/internal/public-settings",
            internal.upstream
        ))
        .set("X-VibeLink-Internal-Token", &internal.token)
        .call()
        .context("Internal public settings request failed")?;
    response
        .into_json::<Value>()
        .context("Cannot parse internal public settings response")
}

fn project_public_settings(settings: &Value, data_dir: &Path) -> Value {
    let defaults = default_settings(Path::new("."));
    let value = |key: &str| {
        settings
            .get(key)
            .cloned()
            .or_else(|| defaults.get(key).cloned())
            .unwrap_or(Value::Null)
    };
    let web_push = settings.get("webPush").unwrap_or(&Value::Null);
    let native_push = settings.get("nativePush").unwrap_or(&Value::Null);
    let mut security = defaults
        .get("security")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(current) = settings.get("security").and_then(Value::as_object) {
        security.extend(current.clone());
    }
    let mut tool_events = defaults
        .get("toolEvents")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(current) = settings.get("toolEvents").and_then(Value::as_object) {
        tool_events.extend(current.clone());
    }
    let (codebase_server, codebase_install) = codebase_memory_install_info();
    let mut source_servers = settings
        .get("mcp")
        .and_then(|value| value.get("servers"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let auto_mcp = settings
        .get("codebaseMemory")
        .and_then(|value| value.get("autoMcp"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if auto_mcp {
        if let Some(server) = codebase_server {
            let exists = source_servers.iter().any(|item| {
                item.get("id")
                    .or_else(|| item.get("name"))
                    .and_then(Value::as_str)
                    == Some("codebase-memory-mcp")
            });
            if !exists {
                source_servers.push(server);
            }
        }
    }
    let mcp_servers = source_servers
        .iter()
        .filter_map(Value::as_object)
        .map(|server| {
            let mut public = server.clone();
            let env_keys = public
                .remove("env")
                .and_then(|value| value.as_object().cloned())
                .map(|value| value.keys().cloned().map(Value::String).collect::<Vec<_>>())
                .unwrap_or_default();
            let header_keys = public
                .remove("headers")
                .and_then(|value| value.as_object().cloned())
                .map(|value| value.keys().cloned().map(Value::String).collect::<Vec<_>>())
                .unwrap_or_default();
            public.insert("envKeys".to_string(), Value::Array(env_keys));
            public.insert("headerKeys".to_string(), Value::Array(header_keys));
            Value::Object(public)
        })
        .collect::<Vec<_>>();
    let credential_state = public_credential_state(data_dir);
    json!({
        "revision": settings_revision(settings),
        "host": value("host"),
        "port": value("port"),
        "pairingTokenConfigured": settings.get("pairingToken").and_then(Value::as_str).is_some_and(|value| !value.is_empty()),
        "defaultCwd": value("defaultCwd"),
        "claudeCommand": value("claudeCommand"),
        "codexCommand": value("codexCommand"),
        "codexTemplate": value("codexTemplate"),
        "doubaoCommand": value("doubaoCommand"),
        "doubaoCdpEndpoint": value("doubaoCdpEndpoint"),
        "doubaoUrl": value("doubaoUrl"),
        "permissionMode": value("permissionMode"),
        "security": security,
        "allowedRoots": value("allowedRoots"),
        "hostAllowlist": value("hostAllowlist"),
        "allowTryCloudflare": settings.get("allowTryCloudflare").and_then(Value::as_bool).unwrap_or(true),
        "allowLegacyPairingTokenLogin": settings.get("allowLegacyPairingTokenLogin").and_then(Value::as_bool).unwrap_or(false),
        "notificationEmailConfigured": settings.get("notificationEmail").and_then(Value::as_str).is_some_and(|value| !value.is_empty()),
        "webPush": {
            "enabled": web_push.get("publicKey").and_then(Value::as_str).is_some_and(|value| !value.is_empty()),
            "publicKey": web_push.get("publicKey").and_then(Value::as_str).unwrap_or("")
        },
        "nativePush": {
            "provider": native_push.get("provider").and_then(Value::as_str).unwrap_or("fcm"),
            "fcmProjectId": native_push.get("fcmProjectId").and_then(Value::as_str).unwrap_or(""),
            "configured": credential_state["nativePushConfigured"]
        },
        "toolEvents": tool_events,
        "mcp": {
            "probeTimeoutMs": settings.get("mcp").and_then(|value| value.get("probeTimeoutMs")).cloned().unwrap_or_else(|| json!(10000)),
            "servers": mcp_servers
        },
        "codebaseMemory": {
            "autoMcp": auto_mcp,
            "install": codebase_install
        },
        "credentials": credential_state["credentials"],
        "hasOpenAIKey": credential_state["hasOpenAIKey"],
        "hasAnthropicKey": credential_state["hasAnthropicKey"],
        "hasZhipuKey": credential_state["hasZhipuKey"]
    })
}

fn codebase_memory_install_info() -> (Option<Value>, Value) {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Local"));
    let executable = if cfg!(windows) {
        "codebase-memory-mcp.exe"
    } else {
        "codebase-memory-mcp"
    };
    let path_candidates = if cfg!(windows) {
        vec![
            local_app_data.join("Programs").join("codebase-memory-mcp"),
            home.join(".local").join("bin"),
        ]
    } else {
        vec![
            home.join(".local").join("bin"),
            home.join(".cargo").join("bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
        ]
    };
    let path_entries = unique_paths(path_candidates)
        .into_iter()
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    let explicit = std::env::var("CODEBASE_MEMORY_MCP_COMMAND")
        .ok()
        .or_else(|| std::env::var("CBM_COMMAND").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut candidates = Vec::new();
    if let Some(explicit) = explicit.as_ref() {
        candidates.push(PathBuf::from(explicit));
    }
    if cfg!(windows) {
        candidates.push(
            local_app_data
                .join("Programs")
                .join("codebase-memory-mcp")
                .join(executable),
        );
        candidates.push(home.join(".local").join("bin").join(executable));
    } else {
        candidates.extend([
            home.join(".local").join("bin").join(executable),
            home.join(".cargo").join("bin").join(executable),
            PathBuf::from("/usr/local/bin").join(executable),
            PathBuf::from("/opt/homebrew/bin").join(executable),
        ]);
    }
    let candidates = unique_paths(candidates);
    let command = explicit
        .map(PathBuf::from)
        .or_else(|| candidates.iter().find(|path| path.is_file()).cloned());
    let server = command.as_ref().map(|command| {
        json!({
            "id": "codebase-memory-mcp",
            "name": "codebase-memory-mcp",
            "type": "stdio",
            "enabled": true,
            "command": command.to_string_lossy(),
            "args": []
        })
    });
    let paths = |values: &[PathBuf]| {
        values
            .iter()
            .map(|value| Value::String(value.to_string_lossy().into_owned()))
            .collect::<Vec<_>>()
    };
    let install = json!({
        "available": server.is_some(),
        "server": server,
        "pathEntries": paths(&path_entries),
        "candidates": paths(&candidates)
    });
    (
        install
            .get("server")
            .cloned()
            .filter(|value| !value.is_null()),
        install,
    )
}

fn unique_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|path| {
            let resolved = if path.is_absolute() {
                path.clone()
            } else {
                std::env::current_dir().unwrap_or_default().join(path)
            };
            seen.insert(resolved.to_string_lossy().to_ascii_lowercase())
        })
        .collect()
}

fn parse_json_body(body: &[u8]) -> Value {
    if body.is_empty() {
        return json!({});
    }
    let raw = String::from_utf8_lossy(body);
    serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "raw": raw }))
}

fn is_dry_run(request: &ParsedRequest) -> bool {
    matches!(
        request.query_parameter("dryRun").as_deref(),
        Some("1" | "true")
    )
}

fn validate_settings_patch(body: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    let Some(body) = body.as_object() else {
        return vec![validation_issue(
            "",
            "Invalid input: expected object",
            "invalid_type",
        )];
    };
    if let Some(port) = body.get("port") {
        let valid = port
            .as_u64()
            .is_some_and(|value| (1..=65_535).contains(&value));
        if !valid {
            issues.push(validation_issue("port", "Invalid port", "invalid_type"));
        }
    }
    validate_string_array(body, "hostAllowlist", &mut issues);
    validate_object(body, "auth", &mut issues, |value, issues| {
        validate_bool(value, "authRequired", "auth", issues);
        validate_string(value, "pairingToken", "auth", issues);
    });
    validate_object(body, "security", &mut issues, |value, issues| {
        validate_enum(
            value,
            "sandboxMode",
            "security",
            &["read-only", "workspace-write", "danger-full-access"],
            issues,
        );
        validate_enum(
            value,
            "approvalPolicy",
            "security",
            &["never", "on-request", "on-failure", "untrusted", "strict"],
            issues,
        );
        validate_bool(value, "networkAccess", "security", issues);
        validate_bool(value, "requireTrustedWorkspace", "security", issues);
    });
    validate_object(body, "apiKeys", &mut issues, |value, issues| {
        for key in ["openai", "anthropic", "zhipu"] {
            validate_string(value, key, "apiKeys", issues);
        }
    });
    for key in [
        "doubaoCommand",
        "doubaoCdpEndpoint",
        "doubaoUrl",
        "notificationEmail",
    ] {
        validate_string(body, key, "", &mut issues);
    }
    validate_object(body, "nativePush", &mut issues, |value, issues| {
        validate_enum(value, "provider", "nativePush", &["fcm", "none"], issues);
        validate_string(value, "fcmProjectId", "nativePush", issues);
        validate_string(value, "fcmServiceAccountJson", "nativePush", issues);
    });
    validate_object(body, "codebaseMemory", &mut issues, |value, issues| {
        validate_bool(value, "autoMcp", "codebaseMemory", issues);
    });
    issues
}

fn validate_object(
    parent: &serde_json::Map<String, Value>,
    key: &str,
    issues: &mut Vec<Value>,
    validate: impl FnOnce(&serde_json::Map<String, Value>, &mut Vec<Value>),
) {
    let Some(value) = parent.get(key) else {
        return;
    };
    if let Some(value) = value.as_object() {
        validate(value, issues);
    } else {
        issues.push(validation_issue(
            key,
            "Invalid input: expected object",
            "invalid_type",
        ));
    }
}

fn validate_string_array(
    parent: &serde_json::Map<String, Value>,
    key: &str,
    issues: &mut Vec<Value>,
) {
    let Some(value) = parent.get(key) else {
        return;
    };
    let valid = value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string));
    if !valid {
        issues.push(validation_issue(
            key,
            "Invalid string array",
            "invalid_type",
        ));
    }
}

fn validate_string(
    parent: &serde_json::Map<String, Value>,
    key: &str,
    prefix: &str,
    issues: &mut Vec<Value>,
) {
    if parent.get(key).is_some_and(|value| !value.is_string()) {
        issues.push(validation_issue(
            &field_path(prefix, key),
            "Invalid input: expected string",
            "invalid_type",
        ));
    }
}

fn validate_bool(
    parent: &serde_json::Map<String, Value>,
    key: &str,
    prefix: &str,
    issues: &mut Vec<Value>,
) {
    if parent.get(key).is_some_and(|value| !value.is_boolean()) {
        issues.push(validation_issue(
            &field_path(prefix, key),
            "Invalid input: expected boolean",
            "invalid_type",
        ));
    }
}

fn validate_enum(
    parent: &serde_json::Map<String, Value>,
    key: &str,
    prefix: &str,
    allowed: &[&str],
    issues: &mut Vec<Value>,
) {
    let Some(value) = parent.get(key) else {
        return;
    };
    if !value.as_str().is_some_and(|value| allowed.contains(&value)) {
        issues.push(validation_issue(
            &field_path(prefix, key),
            "Invalid option",
            "invalid_value",
        ));
    }
}

fn field_path(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        key.to_string()
    } else {
        format!("{prefix}.{key}")
    }
}

fn validation_issue(path: &str, message: &str, code: &str) -> Value {
    json!({ "path": path, "message": message, "code": code })
}

fn forwarded_ip(request: &ParsedRequest) -> Option<&str> {
    request
        .header("x-forwarded-for")
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[allow(clippy::too_many_arguments)]
fn audit_only(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    device_id: &str,
    event_type: &str,
    success: bool,
    reason: &str,
    target: &str,
    meta: &Value,
) -> Result<()> {
    let database_path = data_dir.join("mobile-agent.sqlite");
    let mut connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", database_path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("Cannot configure settings audit database timeout")?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin settings audit transaction")?;
    let current: DateTime<Utc> = SystemTime::now().into();
    let current = current.to_rfc3339_opts(SecondsFormat::Millis, true);
    transaction
        .execute(
            "INSERT INTO audit_log (
                event_type, event_at, device_id, ip, user_agent, method, path,
                success, reason, target, meta_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?2)",
            params![
                clean_string(event_type, 120),
                current,
                clean_string(device_id, 160),
                clean_string(request_ip, 120),
                clean_string(request.header("user-agent").unwrap_or(""), 500),
                clean_string(&request.method, 16),
                clean_string(request.path(), 500),
                i64::from(success),
                clean_string(reason, 1000),
                clean_string(target, 500),
                meta.to_string()
            ],
        )
        .context("Cannot write settings audit record")?;
    transaction
        .commit()
        .context("Cannot commit settings audit transaction")
}

fn clean_string(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::{route_settings_request, route_settings_request_with_body, SettingsRouteConfig};
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use serde_json::Value;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn ready_data_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!(
            "vibelink-settings-http-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(
            data_dir.join("settings.json"),
            r#"{
                "host":"127.0.0.1",
                "port":8787,
                "pairingToken":"PAIR",
                "defaultCwd":"C:/work",
                "hostAllowlist":["bridge.test"],
                "security":{"sandboxMode":"workspace-write","networkAccess":true},
                "webPush":{"publicKey":"public","privateKey":"private","subject":"mailto:test@example.com"},
                "apiKeys":{"openai":"","anthropic":"","zhipu":""}
            }"#,
        )
        .unwrap();
        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        database
            .execute_batch(
                "CREATE TABLE devices (
                    id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT,
                    expires_at TEXT, rotated_at TEXT, meta_json TEXT
                 );
                 CREATE TABLE audit_log (
                    cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
                    event_at TEXT NOT NULL, device_id TEXT, ip TEXT, user_agent TEXT,
                    method TEXT, path TEXT, success INTEGER NOT NULL DEFAULT 0,
                    reason TEXT, target TEXT, meta_json TEXT, created_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO devices (
                    id, label, token_hash, created_at, last_seen_at, expires_at, meta_json
                 ) VALUES ('device-admin', 'Admin', ?1, '2026-01-01T00:00:00.000Z',
                    '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '{}')",
                params![hash_token("admin-token")],
            )
            .unwrap();
        data_dir
    }

    fn internal_settings_server(
        status: u16,
        body: &'static str,
    ) -> (std::net::SocketAddr, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                if request.windows(4).any(|value| value == b"\r\n\r\n") {
                    break;
                }
            }
            let reason = if status == 200 {
                "OK"
            } else {
                "Internal Server Error"
            };
            write!(
                stream,
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            String::from_utf8(request).unwrap()
        });
        (address, thread)
    }

    fn repeated_internal_settings_server(
        count: usize,
        body: &'static str,
    ) -> (std::net::SocketAddr, std::thread::JoinHandle<usize>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            for _ in 0..count {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..count]);
                    if request.windows(4).any(|value| value == b"\r\n\r\n") {
                        break;
                    }
                }
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
            count
        });
        (address, thread)
    }

    #[test]
    fn exports_authenticated_settings_without_secrets() {
        let data_dir = ready_data_dir();
        let config = SettingsRouteConfig::new(data_dir.clone(), PathBuf::from("C:/app"));
        let request = parse_request(
            b"GET /api/settings/export HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer admin-token\r\n\r\n",
        )
        .unwrap();
        let response = route_settings_request(&request, "127.0.0.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["kind"], "vibelink.settings.export");
        assert_eq!(response.body["settings"]["defaultCwd"], "C:/work");
        assert_eq!(
            response.body["settings"]["webPush"],
            serde_json::json!({ "subject": "mailto:test@example.com" })
        );
        assert!(response.body["settings"].get("apiKeys").is_none());
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn updates_settings_and_reloads_the_hybrid_node_runtime() {
        let data_dir = ready_data_dir();
        let (upstream, server) = internal_settings_server(
            200,
            r#"{"defaultCwd":"C:/new","pairingTokenConfigured":true}"#,
        );
        let config = SettingsRouteConfig::new(data_dir.clone(), PathBuf::from("C:/app"))
            .with_internal_settings(upstream, "internal-secret".to_string());
        let request = parse_request(
            b"POST /api/settings HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer admin-token\r\nContent-Length: 23\r\n\r\n",
        )
        .unwrap();
        let response = route_settings_request_with_body(
            &request,
            "127.0.0.1",
            Some(br#"{"defaultCwd":"C:/new"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["settings"]["defaultCwd"], "C:/new");
        assert!(response.body.get("keys").is_none());
        assert!(response.body.get("credentials").is_none());
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(data_dir.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(saved["defaultCwd"], "C:/new");
        assert_eq!(
            saved["apiKeys"],
            serde_json::json!({
                "openai": "", "anthropic": "", "zhipu": ""
            })
        );
        let internal_request = server.join().unwrap().to_ascii_lowercase();
        assert!(internal_request.starts_with("post /internal/reload-settings "));
        assert!(internal_request.contains("x-vibelink-internal-token: internal-secret"));
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn rejects_invalid_settings_patch_without_writing() {
        let data_dir = ready_data_dir();
        let original = fs::read(data_dir.join("settings.json")).unwrap();
        let config = SettingsRouteConfig::new(data_dir.clone(), PathBuf::from("C:/app"));
        let request = parse_request(
            b"POST /api/settings HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer admin-token\r\nContent-Length: 15\r\n\r\n",
        )
        .unwrap();
        let response = route_settings_request_with_body(
            &request,
            "127.0.0.1",
            Some(br#"{"port":"8787"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 400);
        assert_eq!(response.body["error"], "Validation failed");
        assert!(response.body["details"].is_array());
        assert_eq!(fs::read(data_dir.join("settings.json")).unwrap(), original);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn reload_failure_restores_the_original_settings_without_node_replay() {
        let data_dir = ready_data_dir();
        let original = fs::read(data_dir.join("settings.json")).unwrap();
        let (upstream, server) = internal_settings_server(500, r#"{"error":"reload failed"}"#);
        let config = SettingsRouteConfig::new(data_dir.clone(), PathBuf::from("C:/app"))
            .with_internal_settings(upstream, "internal-secret".to_string());
        let request = parse_request(
            b"POST /api/settings HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer admin-token\r\nContent-Length: 23\r\n\r\n",
        )
        .unwrap();
        let response = route_settings_request_with_body(
            &request,
            "127.0.0.1",
            Some(br#"{"defaultCwd":"C:/new"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 500);
        assert_eq!(fs::read(data_dir.join("settings.json")).unwrap(), original);
        server.join().unwrap();
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn serializes_concurrent_settings_mutations() {
        let data_dir = ready_data_dir();
        let (upstream, server) = repeated_internal_settings_server(
            2,
            r#"{"defaultCwd":"C:/serialized","pairingTokenConfigured":true}"#,
        );
        let config = SettingsRouteConfig::new(data_dir.clone(), PathBuf::from("C:/app"))
            .with_internal_settings(upstream, "internal-secret".to_string());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut workers = Vec::new();
        for cwd in ["C:/first", "C:/second"] {
            let config = config.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                let request = parse_request(
                    b"POST /api/settings HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer admin-token\r\nContent-Length: 24\r\n\r\n",
                )
                .unwrap();
                let body = format!(r#"{{"defaultCwd":"{cwd}"}}"#);
                barrier.wait();
                route_settings_request_with_body(
                    &request,
                    "127.0.0.1",
                    Some(body.as_bytes()),
                    &config,
                )
                .unwrap()
                .unwrap()
            }));
        }
        barrier.wait();
        for worker in workers {
            assert_eq!(worker.join().unwrap().status, 200);
        }
        assert_eq!(server.join().unwrap(), 2);
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(data_dir.join("settings.json")).unwrap())
                .unwrap();
        assert!(matches!(
            saved["defaultCwd"].as_str(),
            Some("C:/first" | "C:/second")
        ));
        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let audits = database
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE event_type = 'settings.update'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(audits, 2);
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn rejects_a_stale_second_device_settings_mutation() {
        let data_dir = ready_data_dir();
        let (upstream, server) = internal_settings_server(
            200,
            r#"{"revision":1,"defaultCwd":"C:/first","pairingTokenConfigured":true}"#,
        );
        let config = SettingsRouteConfig::new(data_dir.clone(), PathBuf::from("C:/app"))
            .with_internal_settings(upstream, "internal-secret".to_string());
        let first_request = parse_request(
            b"POST /api/settings HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer admin-token\r\nIf-Match: \"vibelink:settings:0\"\r\nContent-Length: 56\r\n\r\n",
        )
        .unwrap();
        let first = route_settings_request_with_body(
            &first_request,
            "127.0.0.1",
            Some(br#"{"defaultCwd":"C:/first","expectedRevision":0}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(first.status, 200);
        assert_eq!(first.header("etag"), Some("\"vibelink:settings:1\""));

        let stale = route_settings_request_with_body(
            &first_request,
            "127.0.0.1",
            Some(br#"{"defaultCwd":"C:/second","expectedRevision":0}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(stale.status, 409);
        assert_eq!(stale.body["code"], "SETTINGS_CONFLICT");
        assert_eq!(stale.body["actualRevision"], 1);
        assert_eq!(
            server
                .join()
                .unwrap()
                .to_ascii_lowercase()
                .matches("post /internal/reload-settings")
                .count(),
            1
        );
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn previews_import_without_persisting_it() {
        let data_dir = ready_data_dir();
        let original = fs::read(data_dir.join("settings.json")).unwrap();
        let config = SettingsRouteConfig::new(data_dir.clone(), PathBuf::from("C:/app"));
        let request = parse_request(
            b"POST /api/settings/import?dryRun=1 HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer admin-token\r\nContent-Length: 65\r\n\r\n",
        )
        .unwrap();
        let response = route_settings_request_with_body(
            &request,
            "127.0.0.1",
            Some(br#"{"settings":{"defaultCwd":"C:/imported"}}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["dryRun"], true);
        assert_eq!(
            response.body["changedKeys"],
            serde_json::json!(["defaultCwd"])
        );
        assert_eq!(response.body["settings"]["defaultCwd"], "C:/imported");
        assert_eq!(fs::read(data_dir.join("settings.json")).unwrap(), original);
        fs::remove_dir_all(data_dir).unwrap();
    }
}
