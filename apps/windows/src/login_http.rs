use crate::settings_contract::{load_settings, sanitize_settings_patch};
use crate::settings_credentials::write_requested_secrets;
use crate::settings_http::project_public_settings;
use crate::status_http::{clean_host, is_host_allowed, HttpRouteResponse, ParsedRequest};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LOGIN_LIMIT: u32 = 8;
const LOGIN_WINDOW: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone)]
pub struct LoginRouteConfig {
    data_dir: PathBuf,
    rate_limits: Arc<Mutex<HashMap<String, RateBucket>>>,
}

#[derive(Debug, Clone, Copy)]
struct RateBucket {
    count: u32,
    reset_at: SystemTime,
}

impl LoginRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

pub fn login_request_requires_body(request: &ParsedRequest) -> bool {
    request.method == "POST" && request.path() == "/api/login"
}

pub fn route_login_request(
    request: &ParsedRequest,
    peer_ip: &str,
    body: Option<&[u8]>,
    config: &LoginRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "POST" || request.path() != "/api/login" {
        return Ok(None);
    }

    let settings = load_settings(&config.data_dir, Path::new("."))
        .context("Cannot load Rust login settings")?;
    let host_allowlist = settings
        .get("hostAllowlist")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !is_host_allowed(request.host(), &host_allowlist) {
        return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")));
    }

    let request_ip = request_ip(request, peer_ip);
    let rate_limit = check_rate_limit(config, &request_ip)?;
    let headers = rate_limit_headers(&rate_limit);
    if rate_limit.count > LOGIN_LIMIT {
        let retry_after_ms = rate_limit
            .reset_at
            .duration_since(SystemTime::now())
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        audit_only(
            &config.data_dir,
            request,
            &request_ip,
            "",
            "rate_limit",
            false,
            "login",
            "",
            &json!({
                "ok": false,
                "count": rate_limit.count,
                "limit": LOGIN_LIMIT,
                "resetAt": DateTime::<Utc>::from(rate_limit.reset_at)
                    .to_rfc3339_opts(SecondsFormat::Millis, true),
                "retryAfterMs": retry_after_ms
            }),
        )?;
        return Ok(Some(
            HttpRouteResponse::json(
                429,
                json!({ "error": "Rate limit exceeded.", "retryAfterMs": retry_after_ms }),
            )
            .with_headers(headers),
        ));
    }

    let Some(body) = body else {
        return Ok(None);
    };
    let raw_body: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => {
            return Ok(Some(
                HttpRouteResponse::error(400, "Invalid JSON body.").with_headers(headers),
            ))
        }
    };
    let pairing_token = raw_body
        .get("pairingToken")
        .and_then(Value::as_str)
        .unwrap_or("");
    let device_label = raw_body
        .get("deviceLabel")
        .and_then(Value::as_str)
        .unwrap_or("");
    let remember_keys = raw_body
        .get("rememberKeys")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let now: DateTime<Utc> = SystemTime::now().into();
    let now_iso = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let is_public = is_public_host(request.host());
    let allow_legacy = settings
        .get("allowLegacyPairingTokenLogin")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut connection = open_database(&config.data_dir)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin legacy login transaction")?;
    let active_devices = transaction
        .query_row(
            "SELECT COUNT(*) FROM devices
             WHERE revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at = '' OR expires_at > ?1)",
            [&now_iso],
            |row| row.get::<_, i64>(0),
        )
        .context("Cannot count active devices for legacy login")?;
    if !allow_legacy && (is_public || active_devices > 0) {
        let reason = if is_public {
            "Legacy pairing token login is disabled on public hosts."
        } else {
            "Legacy pairing token login is disabled after a device is paired."
        };
        record_audit(
            &transaction,
            request,
            &request_ip,
            "",
            "login",
            false,
            reason,
            "",
            &json!({}),
        )?;
        transaction
            .commit()
            .context("Cannot commit rejected legacy login audit")?;
        return Ok(Some(
            HttpRouteResponse::error(
                403,
                "Legacy pairing token login is disabled. Use QR pairing and approve the device from an existing session.",
            )
            .with_headers(headers),
        ));
    }

    let expected_token = settings
        .get("pairingToken")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !expected_token.is_empty() && pairing_token != expected_token {
        record_audit(
            &transaction,
            request,
            &request_ip,
            "",
            "login",
            false,
            "Pairing token mismatch",
            "",
            &json!({}),
        )?;
        transaction
            .commit()
            .context("Cannot commit failed legacy login audit")?;
        return Ok(Some(
            HttpRouteResponse::error(401, "Pairing token mismatch").with_headers(headers),
        ));
    }

    let device_id = uuid::Uuid::new_v4().to_string();
    let token = random_hex(32)?;
    let label = clean_string(
        if device_label.trim().is_empty() {
            request.header("user-agent").unwrap_or("Browser")
        } else {
            device_label
        },
        120,
    );
    let label = if label.is_empty() {
        "Browser".to_string()
    } else {
        label
    };
    let expires_at =
        (now + chrono::Duration::days(90)).to_rfc3339_opts(SecondsFormat::Millis, true);
    transaction
        .execute(
            "INSERT INTO devices (
                id, label, token_hash, created_at, last_seen_at, revoked_at,
                expires_at, rotated_at, meta_json
             ) VALUES (?1, ?2, ?3, ?4, ?4, NULL, ?5, NULL, '{}')",
            params![
                device_id,
                label,
                crate::status_http::hash_token(&token),
                now_iso,
                expires_at
            ],
        )
        .context("Cannot create legacy login device")?;

    transaction
        .commit()
        .context("Cannot commit legacy login device")?;

    let credential_result =
        if remember_keys && raw_body.get("apiKeys").is_some_and(Value::is_object) {
            let sanitized = sanitize_settings_patch(&raw_body)?;
            let (result, _) = write_requested_secrets(&config.data_dir, &sanitized, &raw_body)?;
            result
        } else {
            json!({})
        };
    audit_only(
        &config.data_dir,
        request,
        &request_ip,
        &device_id,
        "login",
        true,
        "",
        &device_id,
        &json!({
            "legacyPairingToken": true,
            "credentials": credential_result
        }),
    )?;

    Ok(Some(
        HttpRouteResponse::json(
            200,
            json!({
                "ok": true,
                "token": token,
                "device": { "id": device_id, "label": label },
                "settings": project_public_settings(&settings, &config.data_dir)
            }),
        )
        .with_headers(headers),
    ))
}

fn is_public_host(value: &str) -> bool {
    let host = clean_host(value);
    !host.is_empty()
        && !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]")
        && !host.starts_with("10.")
        && !host.starts_with("192.168.")
        && !host
            .strip_prefix("172.")
            .and_then(|rest| rest.split('.').next())
            .and_then(|value| value.parse::<u8>().ok())
            .is_some_and(|second| (16..=31).contains(&second))
}

fn request_ip(request: &ParsedRequest, peer_ip: &str) -> String {
    request
        .header("x-forwarded-for")
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(peer_ip)
        .to_string()
}

fn open_database(data_dir: &Path) -> Result<Connection> {
    let path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("Cannot configure login database timeout")?;
    Ok(connection)
}

fn random_hex(bytes: usize) -> Result<String> {
    let mut value = vec![0_u8; bytes];
    getrandom::getrandom(&mut value)
        .map_err(|error| anyhow::anyhow!("Cannot generate legacy login token: {error}"))?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn clean_string(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn check_rate_limit(config: &LoginRouteConfig, request_ip: &str) -> Result<RateBucket> {
    let now = SystemTime::now();
    let mut buckets = config
        .rate_limits
        .lock()
        .map_err(|_| anyhow::anyhow!("Login rate limiter is unavailable"))?;
    let bucket = buckets
        .entry(format!("login:{request_ip}"))
        .or_insert(RateBucket {
            count: 0,
            reset_at: now + LOGIN_WINDOW,
        });
    if bucket.reset_at <= now {
        bucket.count = 0;
        bucket.reset_at = now + LOGIN_WINDOW;
    }
    bucket.count += 1;
    Ok(*bucket)
}

fn rate_limit_headers(bucket: &RateBucket) -> Vec<(String, String)> {
    let mut headers = vec![
        ("X-RateLimit-Limit".to_string(), LOGIN_LIMIT.to_string()),
        (
            "X-RateLimit-Remaining".to_string(),
            LOGIN_LIMIT.saturating_sub(bucket.count).to_string(),
        ),
        (
            "X-RateLimit-Reset".to_string(),
            bucket
                .reset_at
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .to_string(),
        ),
    ];
    if bucket.count > LOGIN_LIMIT {
        headers.push((
            "Retry-After".to_string(),
            bucket
                .reset_at
                .duration_since(SystemTime::now())
                .unwrap_or_default()
                .as_millis()
                .div_ceil(1000)
                .to_string(),
        ));
    }
    headers
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
    let mut connection = open_database(data_dir)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin login audit transaction")?;
    record_audit(
        &transaction,
        request,
        request_ip,
        device_id,
        event_type,
        success,
        reason,
        target,
        meta,
    )?;
    transaction.commit().context("Cannot commit login audit")
}

#[allow(clippy::too_many_arguments)]
fn record_audit(
    connection: &Connection,
    request: &ParsedRequest,
    request_ip: &str,
    device_id: &str,
    event_type: &str,
    success: bool,
    reason: &str,
    target: &str,
    meta: &Value,
) -> Result<()> {
    let current =
        DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true);
    connection
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
        .context("Cannot write login audit record")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{route_login_request, LoginRouteConfig};
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;

    fn ready_data_dir(allow_legacy: bool) -> PathBuf {
        let data_dir =
            std::env::temp_dir().join(format!("vibelink-login-http-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(
            data_dir.join("settings.json"),
            format!(
                r#"{{"pairingToken":"PAIR","hostAllowlist":["bridge.test"],"allowLegacyPairingTokenLogin":{allow_legacy}}}"#
            ),
        )
        .unwrap();
        Connection::open(data_dir.join("mobile-agent.sqlite"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE devices (
                    id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT,
                    expires_at TEXT, rotated_at TEXT, meta_json TEXT
                 );
                 CREATE TABLE audit_log (
                    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL, event_at TEXT NOT NULL, device_id TEXT,
                    ip TEXT, user_agent TEXT, method TEXT, path TEXT,
                    success INTEGER NOT NULL DEFAULT 0, reason TEXT, target TEXT,
                    meta_json TEXT, created_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        data_dir
    }

    fn request(host: &str) -> crate::status_http::ParsedRequest {
        parse_request(
            format!(
                "POST /api/login HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Contract Browser\r\nContent-Length: 0\r\n\r\n"
            )
            .as_bytes(),
        )
        .unwrap()
    }

    fn login(
        data_dir: &PathBuf,
        host: &str,
        pairing_token: &str,
    ) -> crate::status_http::HttpRouteResponse {
        let body = serde_json::to_vec(&serde_json::json!({
            "pairingToken": pairing_token,
            "deviceLabel": "Legacy browser"
        }))
        .unwrap();
        route_login_request(
            &request(host),
            "198.51.100.9",
            Some(&body),
            &LoginRouteConfig::new(data_dir.clone()),
        )
        .unwrap()
        .unwrap()
    }

    fn insert_device(data_dir: &PathBuf, id: &str, revoked_at: Option<&str>, expires_at: &str) {
        Connection::open(data_dir.join("mobile-agent.sqlite"))
            .unwrap()
            .execute(
                "INSERT INTO devices (
                    id, label, token_hash, created_at, last_seen_at, revoked_at,
                    expires_at, rotated_at, meta_json
                 ) VALUES (?1, 'Existing', ?2, '2026-01-01T00:00:00.000Z',
                           '2026-01-01T00:00:00.000Z', ?3, ?4, NULL, '{}')",
                params![id, hash_token(id), revoked_at, expires_at],
            )
            .unwrap();
    }

    #[test]
    fn local_login_without_active_devices_is_allowed_when_legacy_setting_is_false() {
        let data_dir = ready_data_dir(false);
        let response = login(&data_dir, "192.168.1.10:5177", "PAIR");

        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["device"]["label"], "Legacy browser");
        assert_eq!(response.body["token"].as_str().unwrap().len(), 64);
        assert_eq!(
            response.body["settings"]["allowLegacyPairingTokenLogin"],
            false
        );
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn local_login_with_active_device_is_denied_when_legacy_setting_is_false() {
        let data_dir = ready_data_dir(false);
        insert_device(&data_dir, "active", None, "2099-01-01T00:00:00.000Z");

        let response = login(&data_dir, "192.168.1.10:5177", "PAIR");

        assert_eq!(response.status, 403);
        assert_eq!(
            response.body["error"],
            "Legacy pairing token login is disabled. Use QR pairing and approve the device from an existing session."
        );
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn public_login_is_denied_when_legacy_setting_is_false() {
        let data_dir = ready_data_dir(false);

        let response = login(&data_dir, "bridge.test", "PAIR");

        assert_eq!(response.status, 403);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn enabled_legacy_setting_allows_public_and_repeated_pairing_token_login() {
        let data_dir = ready_data_dir(true);
        insert_device(&data_dir, "active", None, "2099-01-01T00:00:00.000Z");

        let first = login(&data_dir, "bridge.test", "PAIR");
        let second = login(&data_dir, "bridge.test", "PAIR");

        assert_eq!(first.status, 200);
        assert_eq!(second.status, 200);
        assert_ne!(first.body["token"], second.body["token"]);
        assert_ne!(first.body["device"]["id"], second.body["device"]["id"]);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn expired_and_revoked_devices_do_not_block_local_bootstrap_login() {
        let data_dir = ready_data_dir(false);
        insert_device(&data_dir, "expired", None, "2000-01-01T00:00:00.000Z");
        insert_device(
            &data_dir,
            "revoked",
            Some("2026-01-02T00:00:00.000Z"),
            "2099-01-01T00:00:00.000Z",
        );

        let response = login(&data_dir, "127.0.0.1:5177", "PAIR");

        assert_eq!(response.status, 200);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn wrong_pairing_token_returns_node_compatible_error_and_audit() {
        let data_dir = ready_data_dir(true);

        let response = login(&data_dir, "bridge.test", "WRONG");

        assert_eq!(response.status, 401);
        assert_eq!(response.body["error"], "Pairing token mismatch");
        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let audit: (String, i64, String, String) = database
            .query_row(
                "SELECT event_type, success, reason, meta_json FROM audit_log ORDER BY cursor DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(audit.0, "login");
        assert_eq!(audit.1, 0);
        assert_eq!(audit.2, "Pairing token mismatch");
        assert_eq!(
            serde_json::from_str::<Value>(&audit.3).unwrap(),
            serde_json::json!({})
        );
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn successful_login_records_node_compatible_device_audit() {
        let data_dir = ready_data_dir(true);

        let response = login(&data_dir, "bridge.test", "PAIR");

        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let audit: (String, String, i64, String, String) = database
            .query_row(
                "SELECT event_type, device_id, success, target, meta_json FROM audit_log ORDER BY cursor DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(audit.0, "login");
        assert_eq!(audit.1, response.body["device"]["id"]);
        assert_eq!(audit.2, 1);
        assert_eq!(audit.3, response.body["device"]["id"]);
        assert_eq!(
            serde_json::from_str::<Value>(&audit.4).unwrap(),
            serde_json::json!({
                "legacyPairingToken": true,
                "credentials": {}
            })
        );
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }
}
