use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication, RouteMetrics,
};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const ROTATION_LIMIT: u32 = 6;
const ROTATION_WINDOW: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone)]
pub struct DeviceRouteConfig {
    data_dir: PathBuf,
    metrics: Arc<RouteMetrics>,
}

#[derive(Debug, Clone)]
pub struct DeviceMutationRouteConfig {
    data_dir: PathBuf,
    rate_limits: Arc<Mutex<HashMap<String, RateBucket>>>,
    mutation_lock: Arc<Mutex<()>>,
    metrics: Arc<RouteMetrics>,
}

#[derive(Debug, Clone, Copy)]
struct RateBucket {
    count: u32,
    reset_at: SystemTime,
}

#[derive(Debug)]
struct RateLimitResult {
    ok: bool,
    count: u32,
    reset_at: SystemTime,
    retry_after_ms: u64,
}

#[derive(Debug)]
enum DeviceMutation {
    RotateCurrent,
    Rotate(String),
    Revoke(String),
}

impl DeviceRouteConfig {
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

impl DeviceMutationRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            mutation_lock: Arc::new(Mutex::new(())),
            metrics: Arc::new(RouteMetrics::default()),
        }
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.record_fallback();
    }
}

pub fn route_device_request(
    request: &ParsedRequest,
    config: &DeviceRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "GET" || request.path() != "/api/devices" {
        return Ok(None);
    }

    let authentication = authenticate_route_request(request, &config.data_dir)?;
    if authentication == RouteAuthentication::Pending {
        return Ok(None);
    }
    config.metrics.record_attempt();
    let current_device_id = match authentication {
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

    let fields = request.query_parameter("fields");
    let items = list_devices(&config.data_dir)?
        .into_iter()
        .map(|device| apply_fields(device, fields.as_deref()))
        .collect::<Vec<_>>();
    config.metrics.record_response();
    Ok(Some(HttpRouteResponse::json(
        200,
        json!({
            "items": items,
            "currentDeviceId": current_device_id,
            "controlPlaneRuntime": { "devicesHttp": config.metrics.value() }
        }),
    )))
}

pub fn route_device_mutation_request(
    request: &ParsedRequest,
    peer_ip: &str,
    config: &DeviceMutationRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    let Some(mutation) = match_device_mutation(request) else {
        return Ok(None);
    };
    let _mutation_guard = config
        .mutation_lock
        .lock()
        .map_err(|_| anyhow::anyhow!("Device mutation serializer is unavailable"))?;
    let authentication = authenticate_route_request(request, &config.data_dir)?;
    if authentication == RouteAuthentication::Pending {
        return Ok(None);
    }
    config.metrics.record_attempt();
    let request_ip = request
        .header("x-forwarded-for")
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(peer_ip);
    let device_id = match authentication {
        RouteAuthentication::HostDenied => {
            return Ok(Some(claimed_result(
                config,
                audit_only(
                    &config.data_dir,
                    request,
                    request_ip,
                    "",
                    "host.blocked",
                    false,
                    "Host is not allowed.",
                    &crate::status_http::clean_host(request.host()),
                    json!({}),
                )
                .map(|()| HttpRouteResponse::error(403, "Host is not allowed.")),
            )));
        }
        RouteAuthentication::Unauthorized => {
            let reason = if request.token().is_empty() {
                "missing_token"
            } else {
                "invalid_or_expired_token"
            };
            return Ok(Some(claimed_result(
                config,
                audit_only(
                    &config.data_dir,
                    request,
                    request_ip,
                    "",
                    "auth.failed",
                    false,
                    reason,
                    "",
                    json!({}),
                )
                .map(|()| HttpRouteResponse::error(401, "Unauthorized")),
            )));
        }
        RouteAuthentication::Device(device_id) => device_id,
        RouteAuthentication::Pending => unreachable!(),
    };
    let target = match &mutation {
        DeviceMutation::RotateCurrent => device_id.clone(),
        DeviceMutation::Rotate(target) | DeviceMutation::Revoke(target) => target.clone(),
    };

    let (response, response_headers) = match mutation {
        DeviceMutation::RotateCurrent | DeviceMutation::Rotate(_) => {
            match check_rotation_rate_limit(config, request_ip, &target) {
                Ok(rate_limit) if !rate_limit.ok => (
                    audit_rate_limit(
                        &config.data_dir,
                        request,
                        request_ip,
                        &device_id,
                        &rate_limit,
                    )
                    .map(|()| {
                        HttpRouteResponse::json(
                            429,
                            json!({
                                "error": "Rate limit exceeded.",
                                "retryAfterMs": rate_limit.retry_after_ms
                            }),
                        )
                    }),
                    rate_limit_headers(&rate_limit),
                ),
                Ok(rate_limit) => (
                    rotate_device(&config.data_dir, request, request_ip, &device_id, &target),
                    rate_limit_headers(&rate_limit),
                ),
                Err(error) => (Err(error), Vec::new()),
            }
        }
        DeviceMutation::Revoke(_) => (
            revoke_device(&config.data_dir, request, request_ip, &device_id, &target),
            Vec::new(),
        ),
    };
    Ok(Some(
        claimed_result(config, response).with_headers(response_headers),
    ))
}

fn match_device_mutation(request: &ParsedRequest) -> Option<DeviceMutation> {
    if request.method != "POST" {
        return None;
    }
    if request.path() == "/api/devices/current/rotate" {
        return Some(DeviceMutation::RotateCurrent);
    }
    match_device_path(request.path(), "/rotate")
        .map(DeviceMutation::Rotate)
        .or_else(|| match_device_path(request.path(), "/revoke").map(DeviceMutation::Revoke))
}

fn match_device_path(path: &str, suffix: &str) -> Option<String> {
    let target = path.strip_prefix("/api/devices/")?.strip_suffix(suffix)?;
    (!target.is_empty() && !target.contains('/')).then(|| target.to_string())
}

fn claimed_result(
    config: &DeviceMutationRouteConfig,
    result: Result<HttpRouteResponse>,
) -> HttpRouteResponse {
    config.metrics.record_response();
    match result {
        Ok(response) => response,
        Err(error) => {
            config.metrics.record_failure();
            eprintln!("Rust Device mutation failed without Node replay: {error:#}");
            HttpRouteResponse::error(500, "Device mutation failed.")
        }
    }
}

fn check_rotation_rate_limit(
    config: &DeviceMutationRouteConfig,
    request_ip: &str,
    target: &str,
) -> Result<RateLimitResult> {
    let now = SystemTime::now();
    let key = format!("device.rotate:{request_ip}:{target}");
    let mut buckets = config
        .rate_limits
        .lock()
        .map_err(|_| anyhow::anyhow!("Device rotation rate limiter is unavailable"))?;
    let bucket = buckets.entry(key).or_insert(RateBucket {
        count: 0,
        reset_at: now + ROTATION_WINDOW,
    });
    if bucket.reset_at <= now {
        bucket.count = 0;
        bucket.reset_at = now + ROTATION_WINDOW;
    }
    bucket.count += 1;
    let retry_after_ms = bucket
        .reset_at
        .duration_since(now)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    Ok(RateLimitResult {
        ok: bucket.count <= ROTATION_LIMIT,
        count: bucket.count,
        reset_at: bucket.reset_at,
        retry_after_ms,
    })
}

fn rate_limit_headers(result: &RateLimitResult) -> Vec<(String, String)> {
    let reset_at_ms = result
        .reset_at
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let retry_after_seconds = result.retry_after_ms.div_ceil(1000);
    let mut headers = vec![
        ("X-RateLimit-Limit".to_string(), ROTATION_LIMIT.to_string()),
        (
            "X-RateLimit-Remaining".to_string(),
            ROTATION_LIMIT.saturating_sub(result.count).to_string(),
        ),
        ("X-RateLimit-Reset".to_string(), reset_at_ms.to_string()),
    ];
    if !result.ok {
        headers.push(("Retry-After".to_string(), retry_after_seconds.to_string()));
    }
    headers
}

fn rotate_device(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    actor_device_id: &str,
    target: &str,
) -> Result<HttpRouteResponse> {
    let mut connection = open_mutation_database(data_dir)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin device rotation transaction")?;
    let row = transaction
        .query_row(
            "SELECT id, label, created_at, last_seen_at, revoked_at, expires_at,
                    rotated_at, meta_json
             FROM devices WHERE id = ?1 AND revoked_at IS NULL",
            [target],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                ))
            },
        )
        .optional()
        .context("Cannot find device for token rotation")?;
    let Some((id, label, created_at, _, revoked_at, _, _, meta_json)) = row else {
        record_audit(
            &transaction,
            request,
            request_ip,
            actor_device_id,
            "device.rotate",
            false,
            "Device not found.",
            target,
            &json!({}),
        )?;
        transaction
            .commit()
            .context("Cannot commit failed device rotation audit")?;
        return Ok(HttpRouteResponse::error(404, "Device not found."));
    };

    let mut token_bytes = [0_u8; 32];
    getrandom::getrandom(&mut token_bytes)
        .map_err(|error| anyhow::anyhow!("Cannot generate device token: {error}"))?;
    let token = token_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let current: DateTime<Utc> = SystemTime::now().into();
    let current = current.to_rfc3339_opts(SecondsFormat::Millis, true);
    let expires_at = (DateTime::parse_from_rfc3339(&current)
        .context("Cannot parse device rotation timestamp")?
        .with_timezone(&Utc)
        + chrono::Duration::days(90))
    .to_rfc3339_opts(SecondsFormat::Millis, true);
    transaction
        .execute(
            "UPDATE devices
             SET token_hash = ?1, rotated_at = ?2, expires_at = ?3, last_seen_at = ?2
             WHERE id = ?4",
            params![
                crate::status_http::hash_token(&token),
                current,
                expires_at,
                id
            ],
        )
        .context("Cannot rotate device token")?;
    record_audit(
        &transaction,
        request,
        request_ip,
        actor_device_id,
        "device.rotate",
        true,
        "",
        target,
        &json!({}),
    )?;
    transaction
        .commit()
        .context("Cannot commit device rotation transaction")?;
    let meta = serde_json::from_str::<Value>(&meta_json).unwrap_or_else(|_| json!({}));
    Ok(HttpRouteResponse::json(
        200,
        json!({
            "ok": true,
            "token": token,
            "device": {
                "id": id,
                "label": label,
                "createdAt": created_at,
                "lastSeenAt": current,
                "revokedAt": revoked_at,
                "expiresAt": expires_at,
                "rotatedAt": current,
                "expired": false,
                "meta": if meta.is_null() { json!({}) } else { meta }
            }
        }),
    ))
}

fn revoke_device(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    actor_device_id: &str,
    target: &str,
) -> Result<HttpRouteResponse> {
    let mut connection = open_mutation_database(data_dir)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin device revocation transaction")?;
    let current: DateTime<Utc> = SystemTime::now().into();
    let current = current.to_rfc3339_opts(SecondsFormat::Millis, true);
    let changed = transaction
        .execute(
            "UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
            params![current, target],
        )
        .context("Cannot revoke device token")?
        > 0;
    record_audit(
        &transaction,
        request,
        request_ip,
        actor_device_id,
        "device.revoke",
        changed,
        if changed {
            ""
        } else {
            "Device not found or already revoked."
        },
        target,
        &json!({}),
    )?;
    transaction
        .commit()
        .context("Cannot commit device revocation transaction")?;
    Ok(HttpRouteResponse::json(200, json!({ "ok": changed })))
}

fn audit_rate_limit(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    actor_device_id: &str,
    result: &RateLimitResult,
) -> Result<()> {
    let reset_at: DateTime<Utc> = result.reset_at.into();
    audit_only(
        data_dir,
        request,
        request_ip,
        actor_device_id,
        "rate_limit",
        false,
        "device.rotate",
        "",
        json!({
            "ok": result.ok,
            "count": result.count,
            "limit": ROTATION_LIMIT,
            "resetAt": reset_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            "retryAfterMs": result.retry_after_ms
        }),
    )
}

#[allow(clippy::too_many_arguments)]
fn audit_only(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    actor_device_id: &str,
    event_type: &str,
    success: bool,
    reason: &str,
    target: &str,
    meta: Value,
) -> Result<()> {
    let mut connection = open_mutation_database(data_dir)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin device audit transaction")?;
    record_audit(
        &transaction,
        request,
        request_ip,
        actor_device_id,
        event_type,
        success,
        reason,
        target,
        &meta,
    )?;
    transaction
        .commit()
        .context("Cannot commit device audit transaction")
}

#[allow(clippy::too_many_arguments)]
fn record_audit(
    connection: &Connection,
    request: &ParsedRequest,
    request_ip: &str,
    actor_device_id: &str,
    event_type: &str,
    success: bool,
    reason: &str,
    target: &str,
    meta: &Value,
) -> Result<()> {
    let current: DateTime<Utc> = SystemTime::now().into();
    let current = current.to_rfc3339_opts(SecondsFormat::Millis, true);
    connection
        .execute(
            "INSERT INTO audit_log (
                event_type, event_at, device_id, ip, user_agent, method, path,
                success, reason, target, meta_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?2)",
            params![
                clean_string(event_type, 120),
                current,
                clean_string(actor_device_id, 160),
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
        .context("Cannot write device mutation audit record")?;
    Ok(())
}

fn open_mutation_database(data_dir: &Path) -> Result<Connection> {
    let database_path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", database_path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("Cannot configure device mutation database timeout")?;
    Ok(connection)
}

fn clean_string(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn list_devices(data_dir: &Path) -> Result<Vec<Value>> {
    let database_path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", database_path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("Cannot configure device-list database timeout")?;
    let mut statement = connection
        .prepare(
            "SELECT id, label, created_at, last_seen_at, revoked_at, expires_at,
                    rotated_at, meta_json
             FROM devices
             ORDER BY COALESCE(last_seen_at, created_at) DESC",
        )
        .context("Cannot prepare device-list query")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                row.get::<_, Option<String>>(7)?.unwrap_or_default(),
            ))
        })
        .context("Cannot query devices")?;
    let now: DateTime<Utc> = SystemTime::now().into();
    rows.map(|row| {
        let (id, label, created_at, last_seen_at, revoked_at, expires_at, rotated_at, meta_json) =
            row.context("Cannot read device row")?;
        let expired = !expires_at.is_empty()
            && DateTime::parse_from_rfc3339(&expires_at)
                .map(|value| value.with_timezone(&Utc) <= now)
                .unwrap_or(false);
        let meta = serde_json::from_str::<Value>(&meta_json).unwrap_or_else(|_| json!({}));
        Ok(json!({
            "id": id,
            "label": label,
            "createdAt": created_at,
            "lastSeenAt": last_seen_at,
            "revokedAt": revoked_at,
            "expiresAt": expires_at,
            "rotatedAt": rotated_at,
            "expired": expired,
            "meta": if meta.is_null() { json!({}) } else { meta }
        }))
    })
    .collect()
}

pub(crate) fn apply_fields(value: Value, fields: Option<&str>) -> Value {
    let Some(fields) = fields else {
        return value;
    };
    let paths = fields
        .split(',')
        .map(str::trim)
        .filter(|field| !field.is_empty())
        .map(|field| field.split('.').collect::<Vec<_>>())
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return value;
    }

    let mut selected = Map::new();
    for path in paths {
        if let Some(found) = value_at_path(&value, &path) {
            insert_path(&mut selected, &path, found.clone());
        }
    }
    Value::Object(selected)
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |current, part| match current {
        Value::Object(object) => object.get(*part),
        Value::Array(items) => part
            .parse::<usize>()
            .ok()
            .and_then(|index| items.get(index)),
        _ => None,
    })
}

fn insert_path(target: &mut Map<String, Value>, path: &[&str], value: Value) {
    if let Some((field, rest)) = path.split_first() {
        if rest.is_empty() {
            target.insert((*field).to_string(), value);
            return;
        }
        let nested = target
            .entry((*field).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !nested.is_object() {
            *nested = Value::Object(Map::new());
        }
        insert_path(nested.as_object_mut().expect("nested object"), rest, value);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        route_device_mutation_request, route_device_request, DeviceMutationRouteConfig,
        DeviceRouteConfig,
    };
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_data_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "vibelink-devices-http-{}-{nonce}",
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
                    label TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT,
                    revoked_at TEXT,
                    expires_at TEXT,
                    rotated_at TEXT,
                    meta_json TEXT
                );
                CREATE TABLE audit_log (
                    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    event_at TEXT NOT NULL,
                    device_id TEXT,
                    ip TEXT,
                    user_agent TEXT,
                    method TEXT,
                    path TEXT,
                    success INTEGER NOT NULL DEFAULT 0,
                    reason TEXT,
                    target TEXT,
                    meta_json TEXT,
                    created_at TEXT NOT NULL
                );",
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO devices (
                    id, label, token_hash, created_at, last_seen_at, revoked_at,
                    expires_at, rotated_at, meta_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, '', ?7)",
                params![
                    "device-current",
                    "Android phone",
                    hash_token("active-token"),
                    "2026-07-01T00:00:00.000Z",
                    "2026-07-10T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z",
                    r#"{"platform":"android","nested":{"channel":"stable"}}"#
                ],
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO devices (
                    id, label, token_hash, created_at, last_seen_at, revoked_at,
                    expires_at, rotated_at, meta_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    "device-old",
                    "Old browser",
                    hash_token("old-token"),
                    "2025-01-01T00:00:00.000Z",
                    "2026-06-01T00:00:00.000Z",
                    "2026-06-02T00:00:00.000Z",
                    "2000-01-01T00:00:00.000Z",
                    "2026-05-01T00:00:00.000Z",
                    "{}"
                ],
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO devices (
                    id, label, token_hash, created_at, last_seen_at, revoked_at,
                    expires_at, rotated_at, meta_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, '', ?7)",
                params![
                    "device-other",
                    "Other browser",
                    hash_token("other-token"),
                    "2026-06-15T00:00:00.000Z",
                    "2026-06-20T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z",
                    "{}"
                ],
            )
            .unwrap();
        data_dir
    }

    #[test]
    fn routes_authenticated_device_lists_with_node_compatible_fields() {
        let data_dir = ready_data_dir();
        let config = DeviceRouteConfig::new(data_dir.clone());

        let other = parse_request(
            b"GET /api/status HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        assert!(route_device_request(&other, &config).unwrap().is_none());

        let blocked = parse_request(
            b"GET /api/devices HTTP/1.1\r\nHost: attacker.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        assert_eq!(
            route_device_request(&blocked, &config)
                .unwrap()
                .unwrap()
                .status,
            403
        );

        let anonymous =
            parse_request(b"GET /api/devices HTTP/1.1\r\nHost: bridge.test\r\n\r\n").unwrap();
        assert_eq!(
            route_device_request(&anonymous, &config)
                .unwrap()
                .unwrap()
                .status,
            401
        );

        let authenticated = parse_request(
            b"GET /api/devices HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        let response = route_device_request(&authenticated, &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["currentDeviceId"], "device-current");
        assert_eq!(response.body["items"].as_array().unwrap().len(), 3);
        assert_eq!(response.body["items"][0]["id"], "device-current");
        assert_eq!(response.body["items"][0]["label"], "Android phone");
        assert_eq!(response.body["items"][0]["expired"], false);
        assert_eq!(response.body["items"][0]["meta"]["platform"], "android");
        assert_eq!(response.body["items"][2]["id"], "device-old");
        assert_eq!(
            response.body["items"][2]["revokedAt"],
            "2026-06-02T00:00:00.000Z"
        );
        assert_eq!(response.body["items"][2]["expired"], true);

        let filtered = parse_request(
            b"GET /api/devices?fields=id%2Cmeta.platform HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        let filtered = route_device_request(&filtered, &config).unwrap().unwrap();
        assert_eq!(
            filtered.body["items"][0],
            json!({ "id": "device-current", "meta": { "platform": "android" } })
        );
        assert_eq!(filtered.body["currentDeviceId"], "device-current");
        assert_eq!(
            filtered.body["controlPlaneRuntime"]["devicesHttp"],
            json!({
                "implementation": "rust",
                "attempts": 4,
                "responses": 4,
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
    fn rotates_and_revokes_devices_with_atomic_audit_records() {
        let data_dir = ready_data_dir();
        let config = DeviceMutationRouteConfig::new(data_dir.clone());
        let rotate = parse_request(
            b"POST /api/devices/current/rotate HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\nX-Forwarded-For: 203.0.113.10\r\nUser-Agent: VibeLink-Test\r\nContent-Length: 2\r\n\r\n{}",
        )
        .unwrap();
        let response = route_device_mutation_request(&rotate, "127.0.0.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["device"]["id"], "device-current");
        let token = response.body["token"].as_str().unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|character| character.is_ascii_hexdigit()));
        assert_eq!(response.header("X-RateLimit-Limit"), Some("6"));
        assert_eq!(response.header("X-RateLimit-Remaining"), Some("5"));

        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let (token_hash, expires_at): (String, String) = database
            .query_row(
                "SELECT token_hash, expires_at FROM devices WHERE id = 'device-current'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(token_hash, hash_token(token));
        assert_ne!(token_hash, token);
        let expires_at = chrono::DateTime::parse_from_rfc3339(&expires_at).unwrap();
        let now: chrono::DateTime<chrono::Utc> = SystemTime::now().into();
        let days = (expires_at.with_timezone(&chrono::Utc) - now).num_days();
        assert!((89..=90).contains(&days));
        let audit: (String, String, String, String, i64, String) = database
            .query_row(
                "SELECT event_type, device_id, ip, target, success, path
                 FROM audit_log ORDER BY cursor DESC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            audit,
            (
                "device.rotate".to_string(),
                "device-current".to_string(),
                "203.0.113.10".to_string(),
                "device-current".to_string(),
                1,
                "/api/devices/current/rotate".to_string()
            )
        );
        drop(database);

        let revoke_source = format!(
            "POST /api/devices/device-other/revoke HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer {token}\r\nContent-Length: 2\r\n\r\n{{}}"
        );
        let revoke = parse_request(revoke_source.as_bytes()).unwrap();
        let response = route_device_mutation_request(&revoke, "127.0.0.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, json!({ "ok": true }));
        let response = route_device_mutation_request(&revoke, "127.0.0.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, json!({ "ok": false }));

        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let records = database
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE event_type = 'device.revoke' AND target = 'device-other'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(records, 2);
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn rate_limits_rotation_and_audits_the_denial() {
        let data_dir = ready_data_dir();
        let config = DeviceMutationRouteConfig::new(data_dir.clone());
        let request = parse_request(
            b"POST /api/devices/device-other/rotate HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\nX-Forwarded-For: 203.0.113.20\r\nContent-Length: 2\r\n\r\n{}",
        )
        .unwrap();
        for remaining in (0..6).rev() {
            let response = route_device_mutation_request(&request, "127.0.0.1", &config)
                .unwrap()
                .unwrap();
            assert_eq!(response.status, 200);
            assert_eq!(
                response
                    .header("X-RateLimit-Remaining")
                    .and_then(|value| value.parse::<usize>().ok()),
                Some(remaining)
            );
        }
        let denied = route_device_mutation_request(&request, "127.0.0.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(denied.status, 429);
        assert_eq!(denied.body["error"], "Rate limit exceeded.");
        assert!(denied.body["retryAfterMs"].as_u64().unwrap() > 0);
        assert!(denied.header("Retry-After").is_some());

        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let reason = database
            .query_row(
                "SELECT reason FROM audit_log WHERE event_type = 'rate_limit' ORDER BY cursor DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(reason, "device.rotate");
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn denies_and_audits_invalid_mutation_access() {
        let data_dir = ready_data_dir();
        let config = DeviceMutationRouteConfig::new(data_dir.clone());
        let unrelated = parse_request(
            b"GET /api/devices/device-other/revoke HTTP/1.1\r\nHost: bridge.test\r\n\r\n",
        )
        .unwrap();
        assert!(
            route_device_mutation_request(&unrelated, "127.0.0.1", &config)
                .unwrap()
                .is_none()
        );

        let blocked = parse_request(
            b"POST /api/devices/device-other/revoke HTTP/1.1\r\nHost: attacker.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        let blocked = route_device_mutation_request(&blocked, "198.51.100.4", &config)
            .unwrap()
            .unwrap();
        assert_eq!(blocked.status, 403);

        let unauthorized = parse_request(
            b"POST /api/devices/device-other/revoke HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer invalid-token\r\n\r\n",
        )
        .unwrap();
        let unauthorized = route_device_mutation_request(&unauthorized, "198.51.100.5", &config)
            .unwrap()
            .unwrap();
        assert_eq!(unauthorized.status, 401);

        let missing = parse_request(
            b"POST /api/devices/device-old/rotate HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        let missing = route_device_mutation_request(&missing, "198.51.100.6", &config)
            .unwrap()
            .unwrap();
        assert_eq!(missing.status, 404);
        assert_eq!(missing.body["error"], "Device not found.");

        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let events = database
            .prepare("SELECT event_type, reason, success FROM audit_log ORDER BY cursor")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(events[0].0, "host.blocked");
        assert_eq!(
            events[1],
            (
                "auth.failed".to_string(),
                "invalid_or_expired_token".to_string(),
                0
            )
        );
        assert_eq!(
            events[2],
            (
                "device.rotate".to_string(),
                "Device not found.".to_string(),
                0
            )
        );
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn waits_for_node_initialization_before_owning_device_mutations() {
        let data_dir = temporary_data_dir();
        let config = DeviceMutationRouteConfig::new(data_dir.clone());
        let request =
            parse_request(b"POST /api/devices/current/rotate HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .unwrap();

        assert!(
            route_device_mutation_request(&request, "127.0.0.1", &config)
                .unwrap()
                .is_none()
        );
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn serializes_concurrent_current_device_rotations() {
        let data_dir = ready_data_dir();
        let config = DeviceMutationRouteConfig::new(data_dir.clone());
        let barrier = Arc::new(Barrier::new(3));
        let threads = (0..2)
            .map(|_| {
                let config = config.clone();
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    let request = parse_request(
                        b"POST /api/devices/current/rotate HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\n\r\n",
                    )
                    .unwrap();
                    barrier.wait();
                    route_device_mutation_request(&request, "127.0.0.1", &config)
                        .unwrap()
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let mut responses = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        responses.sort_by_key(|response| response.status);
        assert_eq!(
            responses
                .iter()
                .map(|response| response.status)
                .collect::<Vec<_>>(),
            vec![200, 401]
        );
        let token = responses[0].body["token"].as_str().unwrap();
        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let token_hash = database
            .query_row(
                "SELECT token_hash FROM devices WHERE id = 'device-current'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(token_hash, hash_token(token));
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn waits_for_node_initialization_before_owning_device_lists() {
        let data_dir = temporary_data_dir();
        let config = DeviceRouteConfig::new(data_dir.clone());
        let request =
            parse_request(b"GET /api/devices HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();

        assert!(route_device_request(&request, &config).unwrap().is_none());
        fs::remove_dir_all(data_dir).unwrap();
    }
}
