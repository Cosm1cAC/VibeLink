use crate::device_http::apply_fields;
use crate::status_http::{
    authenticate_route_request, prepare_route_request, HttpRouteResponse, ParsedRequest,
    RouteAuthentication, RouteMetrics, RoutePreparation,
};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STATUS_LIMIT: u32 = 60;
const STATUS_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct PairingRouteConfig {
    data_dir: PathBuf,
    rate_limits: Arc<Mutex<HashMap<String, RateBucket>>>,
    decision_lock: Arc<Mutex<()>>,
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
    limit: u32,
    reset_at: SystemTime,
    retry_after_ms: u64,
}

#[derive(Debug)]
enum PairingRequest {
    PublicStatus(String),
    AdminList,
    Approve(String),
    Deny(String),
}

#[derive(Debug)]
struct PairingRow {
    id: String,
    label: String,
    ip: String,
    user_agent: String,
    status: String,
    created_at: String,
    expires_at: String,
    approved_at: String,
    approved_by_device_id: String,
    claimed_at: String,
    device_id: String,
}

impl PairingRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            decision_lock: Arc::new(Mutex::new(())),
            metrics: Arc::new(RouteMetrics::default()),
        }
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.record_fallback();
    }
}

pub fn route_pairing_request(
    request: &ParsedRequest,
    peer_ip: &str,
    config: &PairingRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    let Some(route) = match_pairing_request(request) else {
        return Ok(None);
    };
    let request_ip = request
        .header("x-forwarded-for")
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(peer_ip);
    if let PairingRequest::PublicStatus(session_id) = route {
        return route_public_status(request, request_ip, config, &session_id);
    }

    let _decision_guard = matches!(route, PairingRequest::Approve(_) | PairingRequest::Deny(_))
        .then(|| {
            config
                .decision_lock
                .lock()
                .map_err(|_| anyhow::anyhow!("Pairing decision serializer is unavailable"))
        })
        .transpose()?;
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
            let reason = if request.token().is_empty() {
                "missing_token"
            } else {
                "invalid_or_expired_token"
            };
            let response = audit_only(
                &config.data_dir,
                request,
                request_ip,
                "",
                "auth.failed",
                false,
                reason,
                "",
                &json!({}),
            )
            .map(|()| HttpRouteResponse::error(401, "Unauthorized"));
            return Ok(Some(claimed_result(config, response)));
        }
        RouteAuthentication::Device(device_id) => device_id,
        RouteAuthentication::Pending => unreachable!(),
    };

    match route {
        PairingRequest::AdminList => {
            let status = request
                .query_parameter("status")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "pending".to_string());
            let fields = request.query_parameter("fields");
            let items = list_pairing_sessions(&config.data_dir, &status)?
                .into_iter()
                .map(|session| apply_fields(session, fields.as_deref()))
                .collect::<Vec<_>>();
            config.metrics.record_response();
            Ok(Some(HttpRouteResponse::json(
                200,
                json!({ "items": items }),
            )))
        }
        PairingRequest::Approve(session_id) => Ok(Some(claimed_result(
            config,
            decide_pairing(
                &config.data_dir,
                request,
                request_ip,
                &device_id,
                &session_id,
                true,
            ),
        ))),
        PairingRequest::Deny(session_id) => Ok(Some(claimed_result(
            config,
            decide_pairing(
                &config.data_dir,
                request,
                request_ip,
                &device_id,
                &session_id,
                false,
            ),
        ))),
        PairingRequest::PublicStatus(_) => unreachable!(),
    }
}

fn route_public_status(
    request: &ParsedRequest,
    request_ip: &str,
    config: &PairingRouteConfig,
    session_id: &str,
) -> Result<Option<HttpRouteResponse>> {
    match prepare_route_request(request, &config.data_dir)? {
        RoutePreparation::Pending => return Ok(None),
        RoutePreparation::HostDenied => {
            config.metrics.record_attempt();
            config.metrics.record_host_denied();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")));
        }
        RoutePreparation::Ready(_) => {}
    }
    config.metrics.record_attempt();
    let rate_limit = check_rate_limit(
        config,
        &format!("pairing.status:{request_ip}:{session_id}"),
        STATUS_LIMIT,
        STATUS_WINDOW,
    )?;
    let headers = rate_limit_headers(&rate_limit);
    if !rate_limit.ok {
        let response = audit_rate_limit(
            &config.data_dir,
            request,
            request_ip,
            "pairing.status",
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
        });
        return Ok(Some(claimed_result(config, response).with_headers(headers)));
    }
    let session = get_pairing_session(&config.data_dir, session_id)?;
    config.metrics.record_response();
    Ok(Some(
        match session {
            Some(session) => {
                HttpRouteResponse::json(200, json!({ "ok": true, "session": session }))
            }
            None => HttpRouteResponse::error(404, "Pairing session not found."),
        }
        .with_headers(headers),
    ))
}

fn match_pairing_request(request: &ParsedRequest) -> Option<PairingRequest> {
    let path = request.path();
    if path == "/api/pairing-sessions" && request.method == "GET" {
        return Some(PairingRequest::AdminList);
    }
    let tail = path.strip_prefix("/api/pairing-sessions/")?;
    if request.method == "GET" && !tail.is_empty() && !tail.contains('/') {
        return Some(PairingRequest::PublicStatus(tail.to_string()));
    }
    if request.method == "POST" {
        if let Some(id) = tail.strip_suffix("/approve") {
            if !id.is_empty() && !id.contains('/') {
                return Some(PairingRequest::Approve(id.to_string()));
            }
        }
        if let Some(id) = tail.strip_suffix("/deny") {
            if !id.is_empty() && !id.contains('/') {
                return Some(PairingRequest::Deny(id.to_string()));
            }
        }
    }
    None
}

fn claimed_result(
    config: &PairingRouteConfig,
    result: Result<HttpRouteResponse>,
) -> HttpRouteResponse {
    config.metrics.record_response();
    match result {
        Ok(response) => response,
        Err(error) => {
            config.metrics.record_failure();
            eprintln!("Rust Pairing decision failed without Node replay: {error:#}");
            HttpRouteResponse::error(500, "Pairing operation failed.")
        }
    }
}

fn check_rate_limit(
    config: &PairingRouteConfig,
    key: &str,
    limit: u32,
    window: Duration,
) -> Result<RateLimitResult> {
    let now = SystemTime::now();
    let mut buckets = config
        .rate_limits
        .lock()
        .map_err(|_| anyhow::anyhow!("Pairing rate limiter is unavailable"))?;
    let bucket = buckets.entry(key.to_string()).or_insert(RateBucket {
        count: 0,
        reset_at: now + window,
    });
    if bucket.reset_at <= now {
        bucket.count = 0;
        bucket.reset_at = now + window;
    }
    bucket.count += 1;
    let retry_after_ms = bucket
        .reset_at
        .duration_since(now)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    Ok(RateLimitResult {
        ok: bucket.count <= limit,
        count: bucket.count,
        limit,
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
    let mut headers = vec![
        ("X-RateLimit-Limit".to_string(), result.limit.to_string()),
        (
            "X-RateLimit-Remaining".to_string(),
            result.limit.saturating_sub(result.count).to_string(),
        ),
        ("X-RateLimit-Reset".to_string(), reset_at_ms.to_string()),
    ];
    if !result.ok {
        headers.push((
            "Retry-After".to_string(),
            result.retry_after_ms.div_ceil(1000).to_string(),
        ));
    }
    headers
}

fn open_database(data_dir: &Path, read_only: bool) -> Result<Connection> {
    let mut flags = OpenFlags::SQLITE_OPEN_NO_MUTEX;
    flags |= if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    let path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(&path, flags)
        .with_context(|| format!("Cannot open {}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("Cannot configure pairing database timeout")?;
    Ok(connection)
}

fn pairing_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PairingRow> {
    Ok(PairingRow {
        id: row.get(0)?,
        label: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        ip: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        user_agent: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        status: row.get(4)?,
        created_at: row.get(5)?,
        expires_at: row.get(6)?,
        approved_at: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        approved_by_device_id: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
        claimed_at: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
        device_id: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
    })
}

const PAIRING_COLUMNS: &str = "id, label, ip, user_agent, status, created_at, expires_at,
    approved_at, approved_by_device_id, claimed_at, device_id";

fn read_pairing(connection: &Connection, id: &str) -> Result<Option<PairingRow>> {
    connection
        .query_row(
            &format!("SELECT {PAIRING_COLUMNS} FROM pairing_sessions WHERE id = ?1"),
            [id],
            pairing_row,
        )
        .optional()
        .context("Cannot query pairing session")
}

fn public_pairing_session(row: PairingRow) -> Value {
    let now: DateTime<Utc> = SystemTime::now().into();
    let expired = DateTime::parse_from_rfc3339(&row.expires_at)
        .map(|value| value.with_timezone(&Utc) <= now)
        .unwrap_or(false);
    let status = if row.status == "pending" && expired {
        "expired".to_string()
    } else {
        row.status
    };
    json!({
        "id": row.id,
        "label": row.label,
        "ip": row.ip,
        "userAgent": row.user_agent,
        "status": status,
        "createdAt": row.created_at,
        "expiresAt": row.expires_at,
        "approvedAt": row.approved_at,
        "approvedByDeviceId": row.approved_by_device_id,
        "claimedAt": row.claimed_at,
        "deviceId": row.device_id,
        "expired": expired
    })
}

fn get_pairing_session(data_dir: &Path, id: &str) -> Result<Option<Value>> {
    let connection = open_database(data_dir, true)?;
    read_pairing(&connection, id).map(|row| row.map(public_pairing_session))
}

fn list_pairing_sessions(data_dir: &Path, status: &str) -> Result<Vec<Value>> {
    let connection = open_database(data_dir, true)?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT {PAIRING_COLUMNS} FROM pairing_sessions
             WHERE (?1 = '' OR status = ?1) ORDER BY created_at DESC LIMIT 20"
        ))
        .context("Cannot prepare pairing list query")?;
    let items = statement
        .query_map([status], pairing_row)
        .context("Cannot query pairing sessions")?
        .map(|row| {
            row.context("Cannot read pairing session")
                .map(public_pairing_session)
        })
        .collect();
    items
}

fn decide_pairing(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    device_id: &str,
    session_id: &str,
    approve: bool,
) -> Result<HttpRouteResponse> {
    let mut connection = open_database(data_dir, false)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin pairing decision transaction")?;
    let Some(mut row) = read_pairing(&transaction, session_id)? else {
        record_audit(
            &transaction,
            request,
            request_ip,
            device_id,
            if approve {
                "pairing.approve"
            } else {
                "pairing.deny"
            },
            false,
            if approve { "not_found" } else { "" },
            session_id,
            &json!({}),
        )?;
        transaction
            .commit()
            .context("Cannot commit missing pairing decision audit")?;
        return Ok(HttpRouteResponse::error(404, "Pairing session not found."));
    };
    let current: DateTime<Utc> = SystemTime::now().into();
    let current = current.to_rfc3339_opts(SecondsFormat::Millis, true);
    if approve {
        let expired = DateTime::parse_from_rfc3339(&row.expires_at)
            .map(|value| value.with_timezone(&Utc) <= DateTime::<Utc>::from(SystemTime::now()))
            .unwrap_or(false);
        if row.status == "pending" && !expired {
            transaction
                .execute(
                    "UPDATE pairing_sessions
                     SET status = 'approved', approved_at = ?1, approved_by_device_id = ?2
                     WHERE id = ?3",
                    params![current, device_id, session_id],
                )
                .context("Cannot approve pairing session")?;
            row = read_pairing(&transaction, session_id)?
                .context("Approved pairing session disappeared")?;
        }
    } else {
        transaction
            .execute(
                "UPDATE pairing_sessions
                 SET status = 'denied', approved_at = COALESCE(approved_at, ?1),
                     approved_by_device_id = COALESCE(approved_by_device_id, ?2)
                 WHERE id = ?3",
                params![current, device_id, session_id],
            )
            .context("Cannot deny pairing session")?;
        row = read_pairing(&transaction, session_id)?
            .context("Denied pairing session disappeared")?;
    }
    let session = public_pairing_session(row);
    let success = if approve {
        session["status"] == "approved"
    } else {
        true
    };
    let reason = if approve {
        session["status"].as_str().unwrap_or("")
    } else {
        ""
    };
    record_audit(
        &transaction,
        request,
        request_ip,
        device_id,
        if approve {
            "pairing.approve"
        } else {
            "pairing.deny"
        },
        success,
        reason,
        session_id,
        &json!({}),
    )?;
    transaction
        .commit()
        .context("Cannot commit pairing decision transaction")?;
    Ok(HttpRouteResponse::json(
        200,
        json!({ "ok": if approve { success } else { true }, "session": session }),
    ))
}

fn audit_rate_limit(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    scope: &str,
    result: &RateLimitResult,
) -> Result<()> {
    let reset_at: DateTime<Utc> = result.reset_at.into();
    audit_only(
        data_dir,
        request,
        request_ip,
        "",
        "rate_limit",
        false,
        scope,
        "",
        &json!({
            "ok": result.ok,
            "count": result.count,
            "limit": result.limit,
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
    device_id: &str,
    event_type: &str,
    success: bool,
    reason: &str,
    target: &str,
    meta: &Value,
) -> Result<()> {
    let mut connection = open_database(data_dir, false)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin pairing audit transaction")?;
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
    transaction.commit().context("Cannot commit pairing audit")
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
        .context("Cannot write pairing audit record")?;
    Ok(())
}

fn clean_string(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::{route_pairing_request, PairingRouteConfig};
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
            "vibelink-pairing-http-{}-{nonce}",
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
                CREATE TABLE pairing_sessions (
                    id TEXT PRIMARY KEY,
                    code_hash TEXT NOT NULL,
                    label TEXT,
                    ip TEXT,
                    user_agent TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    approved_at TEXT,
                    approved_by_device_id TEXT,
                    claimed_at TEXT,
                    device_id TEXT,
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
                 ) VALUES ('device-admin', 'Admin', ?1, '2026-01-01T00:00:00.000Z',
                           '2026-01-01T00:00:00.000Z', NULL,
                           '2099-01-01T00:00:00.000Z', '', '{}')",
                [hash_token("admin-token")],
            )
            .unwrap();
        for (id, label, created_at, expires_at) in [
            (
                "pairing-pending",
                "New phone",
                "2026-07-03T00:00:00.000Z",
                "2099-01-01T00:00:00.000Z",
            ),
            (
                "pairing-deny",
                "Denied phone",
                "2026-07-02T00:00:00.000Z",
                "2099-01-01T00:00:00.000Z",
            ),
            (
                "pairing-expired",
                "Expired phone",
                "2026-07-01T00:00:00.000Z",
                "2000-01-01T00:00:00.000Z",
            ),
        ] {
            database
                .execute(
                    "INSERT INTO pairing_sessions (
                        id, code_hash, label, ip, user_agent, status, created_at,
                        expires_at, approved_at, approved_by_device_id, claimed_at,
                        device_id, meta_json
                     ) VALUES (?1, 'hash', ?2, '203.0.113.1', 'VibeLink-Test',
                               'pending', ?3, ?4, NULL, NULL, NULL, NULL, '{}')",
                    params![id, label, created_at, expires_at],
                )
                .unwrap();
        }
        data_dir
    }

    fn request(method: &str, path: &str, token: &str) -> crate::status_http::ParsedRequest {
        let authorization = if token.is_empty() {
            String::new()
        } else {
            format!("Authorization: Bearer {token}\r\n")
        };
        parse_request(
            format!("{method} {path} HTTP/1.1\r\nHost: bridge.test\r\n{authorization}\r\n")
                .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn routes_public_status_and_authenticated_pairing_list() {
        let data_dir = ready_data_dir();
        let config = PairingRouteConfig::new(data_dir.clone());

        let status = request("GET", "/api/pairing-sessions/pairing-pending", "");
        let status = route_pairing_request(&status, "198.51.100.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(status.status, 200);
        assert_eq!(status.body["session"]["status"], "pending");
        assert_eq!(status.body["session"]["label"], "New phone");
        assert!(status.body["session"].get("code").is_none());

        let expired = request("GET", "/api/pairing-sessions/pairing-expired", "");
        let expired = route_pairing_request(&expired, "198.51.100.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(expired.body["session"]["status"], "expired");
        assert_eq!(expired.body["session"]["expired"], true);

        let missing = request("GET", "/api/pairing-sessions/missing", "");
        assert_eq!(
            route_pairing_request(&missing, "198.51.100.1", &config)
                .unwrap()
                .unwrap()
                .status,
            404
        );

        let anonymous_list = request("GET", "/api/pairing-sessions", "");
        assert_eq!(
            route_pairing_request(&anonymous_list, "198.51.100.1", &config)
                .unwrap()
                .unwrap()
                .status,
            401
        );
        let list = request(
            "GET",
            "/api/pairing-sessions?status=pending&fields=id%2Cstatus",
            "admin-token",
        );
        let list = route_pairing_request(&list, "198.51.100.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(list.status, 200);
        assert_eq!(list.body["items"].as_array().unwrap().len(), 3);
        assert_eq!(
            list.body["items"][0],
            json!({ "id": "pairing-pending", "status": "pending" })
        );
        assert_eq!(list.body["items"][2]["status"], "expired");
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn approves_and_denies_pairing_sessions_with_atomic_audits() {
        let data_dir = ready_data_dir();
        let config = PairingRouteConfig::new(data_dir.clone());
        let approve = request(
            "POST",
            "/api/pairing-sessions/pairing-pending/approve",
            "admin-token",
        );
        let approved = route_pairing_request(&approve, "198.51.100.2", &config)
            .unwrap()
            .unwrap();
        assert_eq!(approved.status, 200);
        assert_eq!(approved.body["ok"], true);
        assert_eq!(approved.body["session"]["status"], "approved");
        assert_eq!(
            approved.body["session"]["approvedByDeviceId"],
            "device-admin"
        );

        let deny = request(
            "POST",
            "/api/pairing-sessions/pairing-deny/deny",
            "admin-token",
        );
        let denied = route_pairing_request(&deny, "198.51.100.2", &config)
            .unwrap()
            .unwrap();
        assert_eq!(denied.status, 200);
        assert_eq!(denied.body["ok"], true);
        assert_eq!(denied.body["session"]["status"], "denied");

        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let audits = database
            .prepare(
                "SELECT event_type, device_id, ip, success, target
                 FROM audit_log ORDER BY cursor",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(audits.len(), 2);
        assert_eq!(audits[0].0, "pairing.approve");
        assert_eq!(audits[0].1, "device-admin");
        assert_eq!(audits[0].2, "198.51.100.2");
        assert_eq!(audits[0].3, 1);
        assert_eq!(audits[1].0, "pairing.deny");
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn rate_limits_public_pairing_status_polling() {
        let data_dir = ready_data_dir();
        let config = PairingRouteConfig::new(data_dir.clone());
        let status = request("GET", "/api/pairing-sessions/pairing-pending", "");
        for remaining in (0..60).rev() {
            let response = route_pairing_request(&status, "198.51.100.3", &config)
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
        let denied = route_pairing_request(&status, "198.51.100.3", &config)
            .unwrap()
            .unwrap();
        assert_eq!(denied.status, 429);
        assert_eq!(denied.body["error"], "Rate limit exceeded.");
        assert!(denied.header("Retry-After").is_some());
        fs::remove_dir_all(data_dir).unwrap();
    }
}
