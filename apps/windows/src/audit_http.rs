use crate::device_http::apply_fields;
use crate::status_http::{
    authenticate_route_request, clean_host, HttpRouteResponse, ParsedRequest, RouteAuthentication,
    RouteMetrics,
};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 5_000;

#[derive(Debug, Clone)]
pub struct AuditRouteConfig {
    data_dir: PathBuf,
    metrics: Arc<RouteMetrics>,
}

impl AuditRouteConfig {
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

pub fn route_audit_request(
    request: &ParsedRequest,
    peer_ip: &str,
    config: &AuditRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "GET" || request.path() != "/api/audit-log" {
        return Ok(None);
    }

    let authentication = authenticate_route_request(request, &config.data_dir)?;
    if authentication == RouteAuthentication::Pending {
        return Ok(None);
    }
    config.metrics.record_attempt();
    match authentication {
        RouteAuthentication::HostDenied => {
            audit_route_rejection(
                &config.data_dir,
                request,
                peer_ip,
                "host.blocked",
                "Host is not allowed.",
                &clean_host(request.host()),
            )?;
            config.metrics.record_host_denied();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")));
        }
        RouteAuthentication::Unauthorized => {
            audit_route_rejection(
                &config.data_dir,
                request,
                peer_ip,
                "auth.failed",
                if request.token().is_empty() {
                    "missing_token"
                } else {
                    "invalid_or_expired_token"
                },
                "",
            )?;
            config.metrics.record_unauthorized();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(401, "Unauthorized")));
        }
        RouteAuthentication::Device(_) => {}
        RouteAuthentication::Pending => unreachable!(),
    }

    let (after, limit) = pagination(request);
    let fields = request.query_parameter("fields");
    let items = list_audit_logs(&config.data_dir, after, limit)?
        .into_iter()
        .map(|item| apply_fields(item, fields.as_deref()))
        .collect::<Vec<_>>();
    config.metrics.record_response();
    Ok(Some(HttpRouteResponse::json(
        200,
        json!({ "items": items }),
    )))
}

fn forwarded_ip(request: &ParsedRequest) -> Option<&str> {
    request
        .header("x-forwarded-for")
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(crate) fn audit_route_rejection(
    data_dir: &Path,
    request: &ParsedRequest,
    peer_ip: &str,
    event_type: &str,
    reason: &str,
    target: &str,
) -> Result<()> {
    audit_only(
        data_dir,
        request,
        forwarded_ip(request).unwrap_or(peer_ip),
        "",
        event_type,
        reason,
        target,
    )
}

fn pagination(request: &ParsedRequest) -> (i64, i64) {
    let after = request
        .query_parameter("after")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default()
        .max(0);
    let limit = request
        .query_parameter("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);
    (after, limit)
}

fn list_audit_logs(data_dir: &Path, after: i64, limit: i64) -> Result<Vec<Value>> {
    let database_path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", database_path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("Cannot configure audit-log database timeout")?;
    let mut statement = connection
        .prepare(
            "SELECT cursor, event_type, event_at, device_id, ip, user_agent,
                    method, path, success, reason, target, meta_json
             FROM audit_log
             WHERE cursor > ?1
             ORDER BY cursor DESC
             LIMIT ?2",
        )
        .context("Cannot prepare audit-log query")?;
    let rows = statement
        .query_map(params![after, limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                row.get::<_, i64>(8)? != 0,
                row.get::<_, Option<String>>(9)?.unwrap_or_default(),
                row.get::<_, Option<String>>(10)?.unwrap_or_default(),
                row.get::<_, Option<String>>(11)?.unwrap_or_default(),
            ))
        })
        .context("Cannot query audit log")?;
    rows.map(|row| {
        let (
            cursor,
            event_type,
            at,
            device_id,
            ip,
            user_agent,
            method,
            path,
            success,
            reason,
            target,
            meta_json,
        ) = row.context("Cannot read audit-log row")?;
        let meta = serde_json::from_str::<Value>(&meta_json).unwrap_or_else(|_| json!({}));
        let meta = if meta.is_null() { json!({}) } else { meta };
        Ok(json!({
            "cursor": cursor,
            "type": event_type,
            "at": at,
            "deviceId": device_id,
            "ip": ip,
            "userAgent": user_agent,
            "method": method,
            "path": path,
            "success": success,
            "reason": reason,
            "target": target,
            "meta": meta
        }))
    })
    .collect()
}

#[allow(clippy::too_many_arguments)]
fn audit_only(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    device_id: &str,
    event_type: &str,
    reason: &str,
    target: &str,
) -> Result<()> {
    let database_path = data_dir.join("mobile-agent.sqlite");
    let mut connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", database_path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("Cannot configure audit rejection database timeout")?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin audit rejection transaction")?;
    let current: DateTime<Utc> = SystemTime::now().into();
    let current = current.to_rfc3339_opts(SecondsFormat::Millis, true);
    transaction
        .execute(
            "INSERT INTO audit_log (
                event_type, event_at, device_id, ip, user_agent, method, path,
                success, reason, target, meta_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, '{}', ?2)",
            params![
                clean_string(event_type, 120),
                current,
                clean_string(device_id, 160),
                clean_string(request_ip, 120),
                clean_string(request.header("user-agent").unwrap_or(""), 500),
                clean_string(&request.method, 16),
                clean_string(request.path(), 500),
                clean_string(reason, 1000),
                clean_string(target, 500)
            ],
        )
        .context("Cannot write audit route rejection")?;
    transaction
        .commit()
        .context("Cannot commit audit rejection transaction")
}

fn clean_string(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::{pagination, route_audit_request, AuditRouteConfig};
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn ready_data_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!(
            "vibelink-audit-http-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&data_dir).unwrap();
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
                 ) VALUES (?1, ?2, ?3, ?4, ?4, NULL, ?5, NULL, '{}')",
                params![
                    "device-current",
                    "Audit admin",
                    hash_token("active-token"),
                    "2026-07-01T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z"
                ],
            )
            .unwrap();
        for (event_type, meta) in [
            ("task.create", r#"{"channel":"alpha"}"#),
            ("task.update", r#"["beta"]"#),
            ("task.complete", r#"{"channel":"stable"}"#),
        ] {
            database
                .execute(
                    "INSERT INTO audit_log (
                        event_type, event_at, device_id, ip, user_agent, method,
                        path, success, reason, target, meta_json, created_at
                     ) VALUES (?1, '2026-07-01T00:00:00.000Z', 'device-current',
                        '127.0.0.1', 'test', 'POST', '/api/tasks', 1, '', '', ?2,
                        '2026-07-01T00:00:00.000Z')",
                    params![event_type, meta],
                )
                .unwrap();
        }
        data_dir
    }

    #[test]
    fn lists_audit_rows_with_cursor_limit_and_nested_fields() {
        let data_dir = ready_data_dir();
        let config = AuditRouteConfig::new(data_dir.clone());
        let request = parse_request(
            b"GET /api/audit-log?after=1&limit=1&fields=cursor%2Ctype%2Cmeta.channel HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        let response = route_audit_request(&request, "127.0.0.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(
            response.body,
            json!({
                "items": [{
                    "cursor": 3,
                    "type": "task.complete",
                    "meta": { "channel": "stable" }
                }]
            })
        );

        let non_object_meta = parse_request(
            b"GET /api/audit-log?after=1&limit=2&fields=cursor%2Cmeta HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        let non_object_meta = route_audit_request(&non_object_meta, "127.0.0.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(
            non_object_meta.body,
            json!({
                "items": [
                    { "cursor": 3, "meta": { "channel": "stable" } },
                    { "cursor": 2, "meta": ["beta"] }
                ]
            })
        );
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn audits_host_and_authentication_rejections() {
        let data_dir = ready_data_dir();
        let config = AuditRouteConfig::new(data_dir.clone());
        let blocked = parse_request(
            b"GET /api/audit-log HTTP/1.1\r\nHost: attacker.test\r\nAuthorization: Bearer active-token\r\nX-Forwarded-For: 203.0.113.10, 10.0.0.1\r\nUser-Agent: audit-test\r\n\r\n",
        )
        .unwrap();
        assert_eq!(
            route_audit_request(&blocked, "127.0.0.1", &config)
                .unwrap()
                .unwrap()
                .status,
            403
        );
        let anonymous = parse_request(
            b"GET /api/audit-log HTTP/1.1\r\nHost: bridge.test\r\nX-Forwarded-For: 198.51.100.4\r\n\r\n",
        )
        .unwrap();
        assert_eq!(
            route_audit_request(&anonymous, "127.0.0.1", &config)
                .unwrap()
                .unwrap()
                .status,
            401
        );

        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let mut statement = database
            .prepare(
                "SELECT event_type, ip, reason, path, success
                 FROM audit_log WHERE event_type IN ('host.blocked', 'auth.failed')
                 ORDER BY cursor",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (
                    "host.blocked".to_string(),
                    "203.0.113.10".to_string(),
                    "Host is not allowed.".to_string(),
                    "/api/audit-log".to_string(),
                    0,
                ),
                (
                    "auth.failed".to_string(),
                    "198.51.100.4".to_string(),
                    "missing_token".to_string(),
                    "/api/audit-log".to_string(),
                    0,
                ),
            ]
        );
        drop(statement);
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn bounds_pagination_and_leaves_unready_or_unmatched_requests_for_node() {
        let negative = parse_request(
            b"GET /api/audit-log?after=-2&limit=-1 HTTP/1.1\r\nHost: bridge.test\r\n\r\n",
        )
        .unwrap();
        assert_eq!(pagination(&negative), (0, 1));
        let excessive = parse_request(
            b"GET /api/audit-log?after=invalid&limit=9000 HTTP/1.1\r\nHost: bridge.test\r\n\r\n",
        )
        .unwrap();
        assert_eq!(pagination(&excessive), (0, 5_000));
        let defaults =
            parse_request(b"GET /api/audit-log HTTP/1.1\r\nHost: bridge.test\r\n\r\n").unwrap();
        assert_eq!(pagination(&defaults), (0, 200));

        let data_dir = std::env::temp_dir().join(format!(
            "vibelink-audit-http-unready-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        let config = AuditRouteConfig::new(data_dir.clone());
        assert!(route_audit_request(&defaults, "127.0.0.1", &config)
            .unwrap()
            .is_none());
        let other = parse_request(b"GET /api/tasks HTTP/1.1\r\nHost: bridge.test\r\n\r\n").unwrap();
        assert!(route_audit_request(&other, "127.0.0.1", &config)
            .unwrap()
            .is_none());
        fs::remove_dir_all(data_dir).unwrap();
    }
}
