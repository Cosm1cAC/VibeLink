use crate::settings_contract::load_settings;
use crate::settings_http::project_public_settings;
use crate::status_http::{
    authenticate_route_request, clean_host, is_host_allowed, HttpRouteResponse, ParsedRequest,
    RouteAuthentication, RouteMetrics,
};
use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct DoctorRouteConfig {
    data_dir: PathBuf,
    metrics: Arc<RouteMetrics>,
}

impl DoctorRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            metrics: Arc::new(RouteMetrics::default()),
        }
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.record_fallback();
    }
}

pub fn route_doctor_request(
    request: &ParsedRequest,
    config: &DoctorRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "GET" || request.path() != "/api/doctor" {
        return Ok(None);
    }

    let authentication = authenticate_route_request(request, &config.data_dir)?;
    if authentication == RouteAuthentication::Pending {
        return Ok(None);
    }
    config.metrics.record_attempt();
    let device_id = match authentication {
        RouteAuthentication::HostDenied => {
            config.metrics.record_host_denied();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")));
        }
        RouteAuthentication::Unauthorized => {
            config.metrics.record_unauthorized();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(401, "Unauthorized")));
        }
        RouteAuthentication::Device(device_id) => device_id,
        RouteAuthentication::Pending => unreachable!(),
    };

    let mut body = build_doctor_report(request, &device_id, config)?;
    let object = body
        .as_object_mut()
        .context("Internal Doctor report must be an object")?;
    object
        .get("checks")
        .and_then(Value::as_array)
        .context("Internal Doctor report must contain checks")?;
    object
        .get("toolRunId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .context("Internal Doctor report must contain toolRunId")?;
    let runtime = object
        .entry("controlPlaneRuntime")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("Doctor controlPlaneRuntime must be an object")?;
    config.metrics.record_response();
    runtime.insert("doctorHttp".to_string(), config.metrics.value());
    Ok(Some(HttpRouteResponse::json(200, body)))
}

fn build_doctor_report(
    request: &ParsedRequest,
    device_id: &str,
    config: &DoctorRouteConfig,
) -> Result<Value> {
    let settings = load_settings(&config.data_dir, Path::new("."))
        .context("Cannot load Rust Doctor settings")?;
    let public_settings = project_public_settings(&settings, &config.data_dir);
    let host_allowlist = settings
        .get("hostAllowlist")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let settings_check = doctor_check("settings", true, "Settings", "loaded by Rust", "error");
    let sqlite_path = config.data_dir.join("mobile-agent.sqlite");
    let sqlite_check = doctor_check(
        "sqlite",
        sqlite_path.exists(),
        "SQLite",
        &sqlite_path.to_string_lossy(),
        "error",
    );
    let credentials_available = public_settings
        .get("credentials")
        .and_then(|value| value.get("available"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let credential_detail = public_settings
        .get("credentials")
        .and_then(|value| value.get("description"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let credential_check = doctor_check(
        "credentials",
        credentials_available,
        "Credential backend",
        credential_detail,
        "warn",
    );
    let host_check = doctor_check(
        "host",
        is_host_allowed(request.host(), &host_allowlist),
        "Host allowlist",
        if request.host().is_empty() {
            "unknown"
        } else {
            request.host()
        },
        "error",
    );
    let checks = vec![settings_check, sqlite_check, credential_check, host_check];
    let failures = checks
        .iter()
        .filter(|item| {
            !item.get("ok").and_then(Value::as_bool).unwrap_or(false)
                && item.get("severity").and_then(Value::as_str) != Some("warn")
        })
        .cloned()
        .collect::<Vec<_>>();
    let warnings = checks
        .iter()
        .filter(|item| {
            !item.get("ok").and_then(Value::as_bool).unwrap_or(false)
                && item.get("severity").and_then(Value::as_str) == Some("warn")
        })
        .cloned()
        .collect::<Vec<_>>();
    Ok(json!({
        "ok": failures.is_empty(),
        "platform": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "node": "",
            "rust": env!("CARGO_PKG_VERSION")
        },
        "checks": checks,
        "failures": failures,
        "warningChecks": warnings,
        "warnings": warnings,
        "security": {
            "host": clean_host(request.host()),
            "deviceId": device_id
        },
        "providerRegistry": {
            "providers": [],
            "commands": []
        },
        "toolEvents": {},
        "mcp": { "enabled": 0, "configured": 0 },
        "desktop": {},
        "network": [],
        "generatedAt": now_iso(),
        "toolRunId": format!("rust-doctor-{device_id}-{}", std::process::id())
    }))
}

fn doctor_check(id: &str, ok: bool, label: &str, detail: &str, severity: &str) -> Value {
    json!({
        "id": id,
        "ok": ok,
        "label": label,
        "detail": detail,
        "severity": severity
    })
}

fn now_iso() -> String {
    let now: chrono::DateTime<Utc> = SystemTime::now().into();
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::{route_doctor_request, DoctorRouteConfig};
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_data_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "vibelink-doctor-http-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn ready_data_dir() -> PathBuf {
        let data_dir = temporary_data_dir();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":["bridge.test"]}"#,
        )
        .unwrap();
        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        database
            .execute_batch(
                "CREATE TABLE devices (
                    id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    last_seen_at TEXT,
                    revoked_at TEXT,
                    expires_at TEXT
                );",
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO devices (id, token_hash, last_seen_at, revoked_at, expires_at)
                 VALUES (?1, ?2, '', NULL, '')",
                params!["device-doctor", hash_token("doctor-token")],
            )
            .unwrap();
        data_dir
    }

    #[test]
    fn routes_authenticated_doctor_through_rust_local_tool_report() {
        let data_dir = ready_data_dir();
        let config = DoctorRouteConfig::new(data_dir.clone());

        let other =
            parse_request(b"GET /api/status HTTP/1.1\r\nHost: bridge.test\r\n\r\n").unwrap();
        assert!(route_doctor_request(&other, &config).unwrap().is_none());

        let blocked = parse_request(
            b"GET /api/doctor HTTP/1.1\r\nHost: attacker.test\r\nAuthorization: Bearer doctor-token\r\n\r\n",
        )
        .unwrap();
        assert_eq!(
            route_doctor_request(&blocked, &config)
                .unwrap()
                .unwrap()
                .status,
            403
        );

        let anonymous =
            parse_request(b"GET /api/doctor HTTP/1.1\r\nHost: bridge.test\r\n\r\n").unwrap();
        assert_eq!(
            route_doctor_request(&anonymous, &config)
                .unwrap()
                .unwrap()
                .status,
            401
        );

        let authenticated = parse_request(
            b"GET /api/doctor HTTP/1.1\r\nHost: bridge.test\r\nUser-Agent: doctor-test\r\nX-Forwarded-For: 203.0.113.7\r\nAuthorization: Bearer doctor-token\r\n\r\n",
        )
        .unwrap();
        let response = route_doctor_request(&authenticated, &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert!(response.body["checks"].as_array().unwrap().len() >= 4);
        assert!(response.body["toolRunId"]
            .as_str()
            .unwrap()
            .starts_with("rust-doctor-device-doctor-"));
        assert_eq!(
            response.body["controlPlaneRuntime"]["doctorHttp"],
            json!({
                "implementation": "rust",
                "attempts": 3,
                "responses": 3,
                "fallbacks": 0,
                "failures": 0,
                "hostDenied": 1,
                "unauthorized": 1,
                "pending": 0
            })
        );
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn waits_for_node_initialization_before_owning_doctor() {
        let data_dir = temporary_data_dir();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":[]}"#,
        )
        .unwrap();
        let config = DoctorRouteConfig::new(data_dir.clone());
        let request =
            parse_request(b"GET /api/doctor HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();

        assert!(route_doctor_request(&request, &config).unwrap().is_none());
        assert!(!data_dir.join("mobile-agent.sqlite").exists());
        fs::remove_dir_all(data_dir).unwrap();
    }
}
