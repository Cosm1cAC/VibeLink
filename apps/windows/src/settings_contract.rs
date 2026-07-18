use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Number, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::SystemTime;

pub(crate) const SETTINGS_EXPORT_KEYS: [&str; 18] = [
    "defaultCwd",
    "claudeCommand",
    "codexCommand",
    "codexTemplate",
    "doubaoCommand",
    "doubaoCdpEndpoint",
    "doubaoUrl",
    "permissionMode",
    "security",
    "allowedRoots",
    "hostAllowlist",
    "allowTryCloudflare",
    "allowLegacyPairingTokenLogin",
    "webPush",
    "nativePush",
    "toolEvents",
    "codebaseMemory",
    "mcp",
];

pub(crate) fn default_settings(root: &Path) -> Value {
    json!({
        "revision": 0,
        "_fieldRevisions": {},
        "host": std::env::var("MOBILE_AGENT_HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
        "port": std::env::var("MOBILE_AGENT_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8787),
        "pairingToken": std::env::var("MOBILE_AGENT_TOKEN").unwrap_or_default(),
        "defaultCwd": root.to_string_lossy(),
        "claudeCommand": std::env::var("CLAUDE_COMMAND").unwrap_or_else(|_| "claude".to_string()),
        "codexCommand": std::env::var("CODEX_COMMAND").unwrap_or_else(|_| "auto".to_string()),
        "codexTemplate": std::env::var("CODEX_TEMPLATE").unwrap_or_default(),
        "doubaoCommand": std::env::var("DOUBAO_COMMAND").unwrap_or_else(|_| "auto".to_string()),
        "doubaoCdpEndpoint": std::env::var("DOUBAO_CDP_ENDPOINT")
            .unwrap_or_else(|_| "http://127.0.0.1:9222".to_string()),
        "doubaoUrl": std::env::var("DOUBAO_WEB_URL")
            .unwrap_or_else(|_| "https://www.doubao.com/chat/".to_string()),
        "permissionMode": "default",
        "security": {
            "sandboxMode": "workspace-write",
            "approvalPolicy": "on-request",
            "networkAccess": true,
            "requireTrustedWorkspace": true,
            "requireDangerousCommandApproval": true,
            "trustedWorkspaces": []
        },
        "allowedRoots": [],
        "hostAllowlist": [],
        "allowTryCloudflare": false,
        "allowLegacyPairingTokenLogin": false,
        "notificationEmail": "",
        "webPush": { "publicKey": "", "privateKey": "", "subject": "" },
        "nativePush": { "provider": "fcm", "fcmProjectId": "" },
        "toolEvents": {
            "retentionDays": 30,
            "keepLatest": 5000,
            "autoPrune": true,
            "autoPruneIntervalMinutes": 360
        },
        "codebaseMemory": { "autoMcp": true },
        "mcp": { "probeTimeoutMs": 10000, "servers": [] },
        "apiKeys": { "openai": "", "anthropic": "", "zhipu": "" }
    })
}

pub(crate) fn load_settings(data_dir: &Path, root: &Path) -> Result<Value> {
    let path = data_dir.join("settings.json");
    let source = fs::read_to_string(&path)
        .map_err(anyhow::Error::from)
        .with_context(|| format!("Cannot read {}", path.display()))?;
    let parsed: Value = serde_json::from_str(source.trim_start_matches('\u{feff}'))
        .with_context(|| format!("Cannot parse {}", path.display()))?;
    let mut settings = merge_settings(&default_settings(root), &parsed);
    if cfg!(windows) {
        let codex = settings
            .get("codexCommand")
            .and_then(Value::as_str)
            .unwrap_or("");
        if codex.is_empty()
            || codex.eq_ignore_ascii_case("codex")
            || codex.eq_ignore_ascii_case("codex.exe")
            || codex
                .to_ascii_lowercase()
                .contains("\\windowsapps\\openai.codex_")
        {
            settings["codexCommand"] = Value::String("auto".to_string());
        }
    }
    if settings
        .get("codexTemplate")
        .and_then(Value::as_str)
        .is_some_and(|value| value.trim() == "exec {prompt}")
    {
        settings["codexTemplate"] = Value::String(String::new());
    }
    Ok(settings)
}

pub(crate) fn sanitize_settings_patch(patch: &Value) -> Result<Value> {
    let Some(patch) = patch.as_object() else {
        return Ok(json!({}));
    };
    let mut next = Map::new();
    for key in [
        "defaultCwd",
        "claudeCommand",
        "codexCommand",
        "codexTemplate",
        "doubaoCommand",
        "doubaoCdpEndpoint",
        "doubaoUrl",
        "permissionMode",
        "notificationEmail",
    ] {
        if let Some(value) = patch.get(key).and_then(Value::as_str) {
            next.insert(key.to_string(), Value::String(value.trim().to_string()));
        }
    }

    if let Some(api_keys) = patch.get("apiKeys").and_then(Value::as_object) {
        let mut sanitized = Map::new();
        for key in ["openai", "anthropic", "zhipu"] {
            if let Some(value) = api_keys.get(key).and_then(Value::as_str) {
                let value = value.trim();
                if !value.is_empty() {
                    sanitized.insert(key.to_string(), Value::String(value.to_string()));
                }
            }
        }
        next.insert("apiKeys".to_string(), Value::Object(sanitized));
    }

    if let Some(security) = patch.get("security").and_then(Value::as_object) {
        next.insert(
            "security".to_string(),
            Value::Object(sanitize_security(security)),
        );
    }
    for key in ["allowedRoots", "hostAllowlist"] {
        if let Some(items) = patch.get(key).and_then(Value::as_array) {
            next.insert(
                key.to_string(),
                Value::Array(
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                        .map(|item| Value::String(item.to_string()))
                        .collect(),
                ),
            );
        }
    }
    for key in ["allowTryCloudflare", "allowLegacyPairingTokenLogin"] {
        if let Some(value) = patch.get(key).and_then(Value::as_bool) {
            next.insert(key.to_string(), Value::Bool(value));
        }
    }
    if let Some(web_push) = patch.get("webPush").and_then(Value::as_object) {
        let mut sanitized = Map::new();
        if let Some(subject) = web_push.get("subject").and_then(Value::as_str) {
            sanitized.insert(
                "subject".to_string(),
                Value::String(subject.trim().to_string()),
            );
        }
        next.insert("webPush".to_string(), Value::Object(sanitized));
    }
    if let Some(tool_events) = patch.get("toolEvents").and_then(Value::as_object) {
        next.insert(
            "toolEvents".to_string(),
            Value::Object(sanitize_tool_events(tool_events)),
        );
    }
    if let Some(mcp) = patch.get("mcp").and_then(Value::as_object) {
        next.insert("mcp".to_string(), Value::Object(sanitize_mcp(mcp)?));
    }
    if let Some(native_push) = patch.get("nativePush").and_then(Value::as_object) {
        next.insert(
            "nativePush".to_string(),
            Value::Object(sanitize_native_push(native_push)),
        );
    }
    if let Some(codebase_memory) = patch.get("codebaseMemory").and_then(Value::as_object) {
        let mut sanitized = Map::new();
        if let Some(auto_mcp) = codebase_memory.get("autoMcp").and_then(Value::as_bool) {
            sanitized.insert("autoMcp".to_string(), Value::Bool(auto_mcp));
        }
        next.insert("codebaseMemory".to_string(), Value::Object(sanitized));
    }
    Ok(Value::Object(next))
}

fn sanitize_security(value: &Map<String, Value>) -> Map<String, Value> {
    let mut next = Map::new();
    if let Some(mode @ ("read-only" | "workspace-write" | "danger-full-access")) =
        value.get("sandboxMode").and_then(Value::as_str)
    {
        next.insert("sandboxMode".to_string(), Value::String(mode.to_string()));
    }
    if let Some(policy @ ("never" | "on-request" | "on-failure" | "untrusted" | "strict")) =
        value.get("approvalPolicy").and_then(Value::as_str)
    {
        next.insert(
            "approvalPolicy".to_string(),
            Value::String(policy.to_string()),
        );
    }
    for key in [
        "networkAccess",
        "requireTrustedWorkspace",
        "requireDangerousCommandApproval",
    ] {
        if let Some(value) = value.get(key).and_then(Value::as_bool) {
            next.insert(key.to_string(), Value::Bool(value));
        }
    }
    if let Some(items) = value.get("trustedWorkspaces").and_then(Value::as_array) {
        next.insert(
            "trustedWorkspaces".to_string(),
            Value::Array(
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(|item| Value::String(item.to_string()))
                    .collect(),
            ),
        );
    }
    next
}

fn sanitize_tool_events(value: &Map<String, Value>) -> Map<String, Value> {
    let mut next = Map::new();
    for (key, minimum, maximum) in [
        ("retentionDays", 1_i64, 3650_i64),
        ("keepLatest", 0, 500_000),
        ("autoPruneIntervalMinutes", 15, 10_080),
    ] {
        if let Some(number) = value.get(key).and_then(js_number) {
            let rounded = number.round().clamp(minimum as f64, maximum as f64) as i64;
            next.insert(key.to_string(), Value::Number(Number::from(rounded)));
        }
    }
    if let Some(auto_prune) = value.get("autoPrune").and_then(Value::as_bool) {
        next.insert("autoPrune".to_string(), Value::Bool(auto_prune));
    }
    next
}

fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(value) if value.trim().is_empty() => Some(0.0),
        Value::String(value) => value.trim().parse::<f64>().ok(),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
    .filter(|value| value.is_finite())
}

fn sanitize_mcp(value: &Map<String, Value>) -> Result<Map<String, Value>> {
    let mut next = Map::new();
    if let Some(timeout) = value.get("probeTimeoutMs").and_then(js_number) {
        next.insert(
            "probeTimeoutMs".to_string(),
            Value::Number(Number::from(timeout.round().clamp(1000.0, 60_000.0) as i64)),
        );
    }
    if let Some(servers) = value.get("servers").and_then(Value::as_array) {
        let mut seen = HashSet::new();
        let mut sanitized = Vec::new();
        for server in servers {
            let Some(server) = server.as_object() else {
                continue;
            };
            let server = sanitize_mcp_server(server)?;
            let Some(object) = server.as_object() else {
                continue;
            };
            let id = object.get("id").and_then(Value::as_str).unwrap_or("");
            let valid = match object.get("type").and_then(Value::as_str) {
                Some("stdio") => object
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty()),
                _ => object
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty()),
            };
            if id.is_empty() || !valid || !seen.insert(id.to_string()) {
                continue;
            }
            sanitized.push(server);
            if sanitized.len() == 50 {
                break;
            }
        }
        next.insert("servers".to_string(), Value::Array(sanitized));
    }
    Ok(next)
}

fn sanitize_mcp_server(value: &Map<String, Value>) -> Result<Value> {
    let kind = match value.get("type").and_then(Value::as_str) {
        Some("http") => "http",
        Some("streamable-http") => "streamable-http",
        _ => "stdio",
    };
    let id_source = value
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| value.get("name").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or(random_hex(4)?);
    let id = clean_name(&id_source, 80);
    let name_source = value
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| value.get("id").and_then(Value::as_str))
        .unwrap_or("mcp-server");
    let mut server = Map::from_iter([
        ("id".to_string(), Value::String(id)),
        (
            "name".to_string(),
            Value::String(clean_name(name_source, 80)),
        ),
        ("type".to_string(), Value::String(kind.to_string())),
        (
            "enabled".to_string(),
            Value::Bool(value.get("enabled") != Some(&Value::Bool(false))),
        ),
    ]);
    if kind == "stdio" {
        server.insert(
            "command".to_string(),
            Value::String(
                value
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .map(|value| truncate(value, 500))
                    .unwrap_or_default(),
            ),
        );
        let args = match value.get("args") {
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(Value::as_str)
                .take(40)
                .map(|item| Value::String(truncate(item, 500)))
                .collect(),
            Some(Value::String(items)) => items
                .split(['\r', '\n', ','])
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .take(40)
                .map(|item| Value::String(truncate(item, 500)))
                .collect(),
            _ => Vec::new(),
        };
        server.insert("args".to_string(), Value::Array(args));
        server.insert(
            "cwd".to_string(),
            Value::String(
                value
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .map(|value| truncate(value, 1000))
                    .unwrap_or_default(),
            ),
        );
        if let Some(env) = value.get("env").and_then(Value::as_object) {
            let mut output = Map::new();
            for (key, value) in env {
                let key = clean_name(key, 120);
                if !key.is_empty() {
                    if let Some(value) = value.as_str() {
                        output.insert(key, Value::String(truncate(value, 2000)));
                    }
                }
            }
            server.insert("env".to_string(), Value::Object(output));
        }
    } else {
        server.insert(
            "url".to_string(),
            Value::String(
                value
                    .get("url")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .map(|value| truncate(value, 2000))
                    .unwrap_or_default(),
            ),
        );
        if let Some(headers) = value.get("headers").and_then(Value::as_object) {
            let mut output = Map::new();
            for (key, value) in headers {
                let key = truncate(key.trim(), 120);
                if !key.is_empty() {
                    if let Some(value) = value.as_str() {
                        output.insert(key, Value::String(truncate(value, 2000)));
                    }
                }
            }
            server.insert("headers".to_string(), Value::Object(output));
        }
    }
    Ok(Value::Object(server))
}

fn sanitize_native_push(value: &Map<String, Value>) -> Map<String, Value> {
    let mut next = Map::new();
    if let Some(provider) = value
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|provider| matches!(provider.as_str(), "fcm" | "none"))
    {
        next.insert("provider".to_string(), Value::String(provider));
    }
    if let Some(project_id) = value.get("fcmProjectId").and_then(Value::as_str) {
        next.insert(
            "fcmProjectId".to_string(),
            Value::String(truncate(project_id.trim(), 200)),
        );
    }
    next
}

fn clean_name(value: &str, max: usize) -> String {
    let mut output = String::new();
    let mut separator = false;
    for character in value.trim().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
            output.push(character);
            separator = false;
        } else if !separator {
            output.push('-');
            separator = true;
        }
    }
    truncate(output.trim_matches('-'), max)
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn random_hex(bytes: usize) -> Result<String> {
    let mut value = vec![0_u8; bytes];
    getrandom::getrandom(&mut value)
        .map_err(|error| anyhow::anyhow!("Cannot generate settings identifier: {error}"))?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(crate) fn build_settings_export(settings: &Value) -> Result<Value> {
    let exported_at: chrono::DateTime<Utc> = SystemTime::now().into();
    Ok(json!({
        "kind": "vibelink.settings.export",
        "version": 1,
        "exportedAt": exported_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        "settings": settings_export_patch(settings)?
    }))
}

fn settings_export_patch(settings: &Value) -> Result<Value> {
    let mut patch = Map::new();
    if let Some(settings) = settings.as_object() {
        for key in SETTINGS_EXPORT_KEYS {
            if let Some(value) = settings.get(key) {
                patch.insert(key.to_string(), value.clone());
            }
        }
    }
    if let Some(web_push) = patch.get("webPush").and_then(Value::as_object) {
        patch.insert(
            "webPush".to_string(),
            json!({
                "subject": web_push
                    .get("subject")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            }),
        );
    }
    sanitize_settings_patch(&Value::Object(patch))
}

pub(crate) fn import_settings_snapshot(
    defaults: &Value,
    current: &Value,
    snapshot: &Value,
) -> Result<Value> {
    let raw_settings = snapshot
        .get("settings")
        .filter(|value| value.is_object())
        .unwrap_or(snapshot);
    let patch = settings_export_patch(raw_settings)?;
    let mut imported = current.as_object().cloned().unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        for (key, value) in patch {
            imported.insert(key.clone(), value.clone());
        }
    }
    imported.insert(
        "apiKeys".to_string(),
        current.get("apiKeys").cloned().unwrap_or_else(|| json!({})),
    );
    imported.insert(
        "notificationEmail".to_string(),
        current
            .get("notificationEmail")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    for key in [
        "security",
        "toolEvents",
        "codebaseMemory",
        "webPush",
        "nativePush",
    ] {
        imported.insert(
            key.to_string(),
            merge_objects(current.get(key), patch.get(key)),
        );
    }
    imported.insert(
        "mcp".to_string(),
        if patch.get("mcp").is_some() {
            merge_mcp_settings(
                current.get("mcp").unwrap_or(&Value::Null),
                patch.get("mcp").unwrap_or(&Value::Null),
            )
        } else {
            current.get("mcp").cloned().unwrap_or_else(|| json!({}))
        },
    );
    Ok(merge_settings(defaults, &Value::Object(imported)))
}

pub(crate) fn summarize_settings_import(previous: &Value, next: &Value) -> Value {
    let changed_keys = SETTINGS_EXPORT_KEYS
        .iter()
        .filter(|key| {
            previous.get(**key).unwrap_or(&Value::Null) != next.get(**key).unwrap_or(&Value::Null)
        })
        .map(|key| Value::String((*key).to_string()))
        .collect::<Vec<_>>();
    json!({ "ok": true, "changedKeys": changed_keys })
}

pub(crate) fn merge_settings(base: &Value, next: &Value) -> Value {
    let mut merged = base.as_object().cloned().unwrap_or_default();
    if let Some(next) = next.as_object() {
        for (key, value) in next {
            merged.insert(key.clone(), value.clone());
        }
    }
    for key in [
        "webPush",
        "nativePush",
        "apiKeys",
        "security",
        "toolEvents",
        "codebaseMemory",
        "mcp",
    ] {
        merged.insert(key.to_string(), merge_objects(base.get(key), next.get(key)));
    }
    if next
        .get("mcp")
        .and_then(|value| value.get("servers"))
        .and_then(Value::as_array)
        .is_none()
    {
        if let Some(servers) = base.get("mcp").and_then(|value| value.get("servers")) {
            if let Some(mcp) = merged.get_mut("mcp").and_then(Value::as_object_mut) {
                mcp.insert("servers".to_string(), servers.clone());
            }
        }
    }
    Value::Object(merged)
}

fn merge_objects(existing: Option<&Value>, next: Option<&Value>) -> Value {
    let mut merged = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(next) = next.and_then(Value::as_object) {
        for (key, value) in next {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

pub(crate) fn merge_mcp_settings(current: &Value, patch: &Value) -> Value {
    let mut merged = current.as_object().cloned().unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        for (key, value) in patch {
            merged.insert(key.clone(), value.clone());
        }
    }
    let Some(patch_servers) = patch.get("servers").and_then(Value::as_array) else {
        return Value::Object(merged);
    };
    let existing_by_id = current
        .get("servers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|server| {
            let key = server.get("id").or_else(|| server.get("name"))?.as_str()?;
            Some((key.to_string(), server.clone()))
        })
        .collect::<HashMap<_, _>>();
    let servers = patch_servers
        .iter()
        .map(|server| {
            let mut next = server.as_object().cloned().unwrap_or_default();
            let key = server
                .get("id")
                .or_else(|| server.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let existing = existing_by_id.get(key).unwrap_or(&Value::Null);
            let kind = server
                .get("type")
                .or_else(|| existing.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("stdio");
            let secret_key = if kind == "stdio" { "env" } else { "headers" };
            if server.get(secret_key).is_some() {
                next.insert(
                    secret_key.to_string(),
                    merge_secret_object(existing.get(secret_key), server.get(secret_key)),
                );
            } else if let Some(existing_secret) = existing.get(secret_key) {
                next.insert(secret_key.to_string(), existing_secret.clone());
            }
            Value::Object(next)
        })
        .collect();
    merged.insert("servers".to_string(), Value::Array(servers));
    Value::Object(merged)
}

fn merge_secret_object(existing: Option<&Value>, next: Option<&Value>) -> Value {
    let Some(next) = next.and_then(Value::as_object) else {
        return existing.cloned().unwrap_or_else(|| json!({}));
    };
    let mut merged = Map::new();
    for (key, value) in next {
        let value = if value == "configured" {
            existing
                .and_then(|value| value.get(key))
                .filter(|value| js_truthy(value))
                .cloned()
                .unwrap_or_else(|| value.clone())
        } else {
            value.clone()
        };
        merged.insert(key.clone(), value);
    }
    Value::Object(merged)
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value
            .as_f64()
            .is_some_and(|value| value != 0.0 && !value.is_nan()),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_settings_export, import_settings_snapshot, merge_mcp_settings,
        sanitize_settings_patch,
    };
    use serde_json::json;

    fn defaults() -> serde_json::Value {
        json!({
            "host": "0.0.0.0",
            "port": 8787,
            "pairingToken": "PAIR",
            "defaultCwd": "C:/default",
            "claudeCommand": "claude",
            "codexCommand": "auto",
            "codexTemplate": "",
            "doubaoCommand": "auto",
            "doubaoCdpEndpoint": "http://127.0.0.1:9222",
            "doubaoUrl": "https://www.doubao.com/chat/",
            "permissionMode": "default",
            "security": {
                "sandboxMode": "workspace-write",
                "approvalPolicy": "on-request",
                "networkAccess": true,
                "requireTrustedWorkspace": true,
                "requireDangerousCommandApproval": true,
                "trustedWorkspaces": []
            },
            "allowedRoots": [],
            "hostAllowlist": [],
            "allowTryCloudflare": false,
            "allowLegacyPairingTokenLogin": false,
            "notificationEmail": "",
            "webPush": { "publicKey": "", "privateKey": "", "subject": "" },
            "nativePush": { "provider": "fcm", "fcmProjectId": "" },
            "toolEvents": {
                "retentionDays": 30,
                "keepLatest": 5000,
                "autoPrune": true,
                "autoPruneIntervalMinutes": 360
            },
            "codebaseMemory": { "autoMcp": true },
            "mcp": { "probeTimeoutMs": 10000, "servers": [] },
            "apiKeys": { "openai": "", "anthropic": "", "zhipu": "" }
        })
    }

    #[test]
    fn export_omits_local_secrets_and_private_push_keys() {
        let mut settings = defaults();
        settings["defaultCwd"] = json!("C:/work/project");
        settings["notificationEmail"] = json!("ops@example.com");
        settings["webPush"] = json!({
            "publicKey": "public-vapid",
            "privateKey": "private-vapid",
            "subject": "mailto:test@example.com"
        });
        settings["apiKeys"] = json!({
            "openai": "sk-secret",
            "anthropic": "anthropic-secret",
            "zhipu": "zhipu-secret"
        });

        let exported = build_settings_export(&settings).unwrap();
        assert_eq!(exported["kind"], "vibelink.settings.export");
        assert_eq!(exported["settings"]["defaultCwd"], "C:/work/project");
        assert!(exported["settings"].get("notificationEmail").is_none());
        assert!(exported["settings"]["webPush"].get("privateKey").is_none());
        assert!(exported["settings"]["webPush"].get("publicKey").is_none());
        assert!(exported["settings"].get("apiKeys").is_none());
    }

    #[test]
    fn import_sanitizes_and_preserves_existing_secrets() {
        let mut current = defaults();
        current["defaultCwd"] = json!("C:/old");
        current["apiKeys"] = json!({
            "openai": "existing-openai",
            "anthropic": "existing-anthropic"
        });
        current["notificationEmail"] = json!("local@example.com");
        current["webPush"] = json!({
            "publicKey": "current-public",
            "privateKey": "current-private",
            "subject": "mailto:old@example.com"
        });
        let snapshot = json!({
            "kind": "vibelink.settings.export",
            "settings": {
                "defaultCwd": "C:/new",
                "hostAllowlist": ["example.com", ""],
                "security": { "sandboxMode": "read-only", "networkAccess": false },
                "apiKeys": { "openai": "should-not-import" },
                "notificationEmail": "foreign@example.com",
                "webPush": {
                    "publicKey": "foreign-public",
                    "privateKey": "foreign-private",
                    "subject": "mailto:new@example.com"
                },
                "unsupported": "ignored"
            }
        });

        let imported = import_settings_snapshot(&defaults(), &current, &snapshot).unwrap();
        assert_eq!(imported["defaultCwd"], "C:/new");
        assert_eq!(imported["hostAllowlist"], json!(["example.com"]));
        assert_eq!(imported["security"]["sandboxMode"], "read-only");
        assert_eq!(imported["security"]["networkAccess"], false);
        assert_eq!(imported["apiKeys"]["openai"], "existing-openai");
        assert_eq!(imported["notificationEmail"], "local@example.com");
        assert_eq!(imported["webPush"]["publicKey"], "current-public");
        assert_eq!(imported["webPush"]["privateKey"], "current-private");
        assert_eq!(imported["webPush"]["subject"], "mailto:new@example.com");
        assert!(imported.get("unsupported").is_none());
    }

    #[test]
    fn sanitizer_bounds_retention_and_mcp_settings() {
        let patch = sanitize_settings_patch(&json!({
            "toolEvents": {
                "retentionDays": 5000,
                "keepLatest": -2,
                "autoPrune": false,
                "autoPruneIntervalMinutes": 3
            },
            "mcp": { "probeTimeoutMs": 500 }
        }))
        .unwrap();
        assert_eq!(
            patch["toolEvents"],
            json!({
                "retentionDays": 3650,
                "keepLatest": 0,
                "autoPrune": false,
                "autoPruneIntervalMinutes": 15
            })
        );
        assert_eq!(patch["mcp"]["probeTimeoutMs"], 1000);
    }

    #[test]
    fn mcp_merge_preserves_configured_secret_placeholders() {
        let current = json!({
            "probeTimeoutMs": 10000,
            "servers": [{
                "id": "private-http",
                "name": "private-http",
                "type": "http",
                "url": "https://mcp.example.test",
                "headers": { "Authorization": "Bearer local-secret" }
            }]
        });
        let patch = json!({
            "servers": [{
                "id": "private-http",
                "name": "private-http",
                "type": "http",
                "url": "https://mcp.example.test/v2",
                "headers": { "Authorization": "configured" }
            }]
        });
        let merged = merge_mcp_settings(&current, &patch);
        assert_eq!(
            merged["servers"][0]["headers"]["Authorization"],
            "Bearer local-secret"
        );
        assert_eq!(merged["servers"][0]["url"], "https://mcp.example.test/v2");
    }
}
