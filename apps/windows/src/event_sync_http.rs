use crate::audit_http::audit_route_rejection;
use crate::device_http::apply_fields;
use crate::event_store_sidecar::EventStoreSidecar;
use crate::status_http::{
    authenticate_route_request, clean_host, HttpRouteResponse, ParsedRequest, RouteAuthentication,
    RouteMetrics,
};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct EventSyncRouteConfig {
    data_dir: PathBuf,
    metrics: Arc<RouteMetrics>,
    rate_limits: Arc<Mutex<HashMap<String, RateBucket>>>,
}

#[derive(Debug, Clone, Copy)]
struct RateBucket {
    count: u32,
    reset_at: SystemTime,
}

impl EventSyncRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            metrics: Arc::new(RouteMetrics::default()),
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.record_fallback();
    }
}

pub fn event_sync_request_requires_body(request: &ParsedRequest) -> bool {
    request.method == "POST" && matches!(request.path(), "/api/events/ack" | "/api/events/compact")
}

pub fn route_event_sync_request(
    request: &ParsedRequest,
    peer_ip: &str,
    body: Option<&[u8]>,
    config: &EventSyncRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if !matches!(
        (request.method.as_str(), request.path()),
        ("GET", "/api/events/unified")
            | ("GET", "/api/events/acks")
            | ("GET", "/api/events/retention-plan")
            | ("GET", "/api/events/compaction-markers")
            | ("POST", "/api/events/ack")
            | ("POST", "/api/events/compact")
    ) {
        return Ok(None);
    }

    let authentication = authenticate_route_request(request, &config.data_dir)?;
    if authentication == RouteAuthentication::Pending {
        return Ok(None);
    }
    config.metrics.record_attempt();
    let device_id = match authentication {
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
        RouteAuthentication::Device(device_id) => device_id,
        RouteAuthentication::Pending => unreachable!(),
    };

    let database_path = config.data_dir.join("mobile-agent.sqlite");
    let rate_limit = if request.method == "POST" {
        let limit = if request.path() == "/api/events/ack" {
            240
        } else {
            20
        };
        let result = check_rate_limit(config, &format!("{}:{}", device_id, request.path()), limit)?;
        if !result.ok {
            audit_record(
                &config.data_dir,
                request,
                peer_ip,
                &device_id,
                "rate_limit",
                false,
                request.path(),
                "Event sync mutation rate limit exceeded.",
                &json!({ "limit": result.limit, "count": result.count }),
            )?;
            config.metrics.record_response();
            return Ok(Some(
                HttpRouteResponse::json(
                    429,
                    json!({
                        "error": "Rate limit exceeded.",
                        "retryAfterMs": result.retry_after_ms
                    }),
                )
                .with_headers(rate_limit_headers(&result)),
            ));
        }
        Some(result)
    } else {
        None
    };
    let mut store = EventStoreSidecar::open(&database_path, false)?;
    let response = match (request.method.as_str(), request.path()) {
        ("GET", "/api/events/unified") => {
            let options = json!({
                "taskId": query(request, "taskId"),
                "liveCallSessionId": query(request, "liveCallSessionId"),
                "toolRunId": query(request, "toolRunId"),
                "after": query_i64(request, "after", 0),
                "limit": query_i64(request, "limit", 200).clamp(1, 2000)
            });
            let mut window = store.handle("replayWindow", &[options])?;
            apply_item_fields(&mut window, request.query_parameter("fields").as_deref());
            HttpRouteResponse::json(200, window)
        }
        ("GET", "/api/events/acks") => {
            let items = store.handle(
                "listEventAcks",
                &[json!({ "deviceId": device_id, "streamId": query(request, "streamId") })],
            )?;
            HttpRouteResponse::json(200, json!({ "items": items }))
        }
        ("GET", "/api/events/retention-plan") => {
            let stream = query(request, "streamId");
            if !valid_stream_id(&stream) {
                HttpRouteResponse::error(400, "A valid streamId is required.")
            } else {
                HttpRouteResponse::json(
                    200,
                    store.handle(
                        "planRetention",
                        &[json!({
                            "streamId": stream,
                            "retentionDays": query_i64(request, "retentionDays", 30),
                            "keepLatest": query_i64(request, "keepLatest", 5000)
                        })],
                    )?,
                )
            }
        }
        ("GET", "/api/events/compaction-markers") => {
            let items = store.handle(
                "listCompactionMarkers",
                &[json!({
                    "streamId": query(request, "streamId"),
                    "afterCursor": query_i64(request, "after", 0),
                    "limit": query_i64(request, "limit", 100).clamp(1, 1000)
                })],
            )?;
            HttpRouteResponse::json(200, json!({ "items": items }))
        }
        ("POST", "/api/events/ack") => {
            let input = match parse_body(body) {
                Ok(input) => input,
                Err(_) => {
                    config.metrics.record_response();
                    return Ok(Some(HttpRouteResponse::error(
                        400,
                        "Event acknowledgement body must be valid JSON.",
                    )));
                }
            };
            let stream = input.get("streamId").and_then(Value::as_str).unwrap_or("");
            let cursor = input.get("cursor").and_then(Value::as_i64);
            if !valid_stream_id(stream) || cursor.is_none() || cursor.is_some_and(|value| value < 0)
            {
                HttpRouteResponse::error(400, "A valid streamId and cursor are required.")
            } else {
                let current = store.handle("getEventAck", &[json!(device_id), json!(stream)])?;
                let current_cursor = current.get("cursor").and_then(Value::as_i64).unwrap_or(0);
                if input
                    .get("expectedCursor")
                    .and_then(Value::as_i64)
                    .is_some_and(|expected| expected != current_cursor)
                {
                    HttpRouteResponse::json(
                        409,
                        json!({
                            "error": "Event acknowledgement changed on another client.",
                            "code": "EVENT_ACK_CONFLICT",
                            "current": current
                        }),
                    )
                } else {
                    let ack = store.handle(
                        "upsertEventAck",
                        &[
                            json!(device_id),
                            json!(stream),
                            json!(cursor.unwrap_or(0)),
                            json!({
                                "eventId": input.get("eventId").cloned().unwrap_or(Value::Null),
                                "metadata": input.get("metadata").cloned().unwrap_or_else(|| json!({}))
                            }),
                        ],
                    )?;
                    audit_success(
                        &config.data_dir,
                        request,
                        peer_ip,
                        &device_id,
                        "events.ack",
                        stream,
                        &json!({ "cursor": ack["cursor"] }),
                    )?;
                    HttpRouteResponse::json(200, json!({ "ok": true, "ack": ack }))
                }
            }
        }
        ("POST", "/api/events/compact") => {
            let input = match parse_body(body) {
                Ok(input) => input,
                Err(_) => {
                    config.metrics.record_response();
                    return Ok(Some(HttpRouteResponse::error(
                        400,
                        "Event compaction body must be valid JSON.",
                    )));
                }
            };
            let stream = input
                .get("streamId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !valid_stream_id(&stream) {
                HttpRouteResponse::error(400, "A valid streamId is required.")
            } else {
                let result = store.handle("compactEvents", &[input])?;
                audit_success(
                    &config.data_dir,
                    request,
                    peer_ip,
                    &device_id,
                    "events.compact",
                    &stream,
                    &json!({
                        "dryRun": result["dryRun"], "prunable": result["prunable"],
                        "deleted": result["deleted"], "quotaExceeded": result["quotaExceeded"]
                    }),
                )?;
                HttpRouteResponse::json(200, result)
            }
        }
        _ => unreachable!(),
    };
    config.metrics.record_response();
    Ok(Some(match rate_limit {
        Some(result) => response.with_headers(rate_limit_headers(&result)),
        None => response,
    }))
}

fn parse_body(body: Option<&[u8]>) -> Result<Value> {
    let body = body.context("Event sync mutation body is required")?;
    serde_json::from_slice(body).context("Event sync mutation body must be valid JSON")
}

fn valid_stream_id(value: &str) -> bool {
    let owner = ["task:", "live-call:", "tool-event:"]
        .iter()
        .find_map(|prefix| value.strip_prefix(prefix));
    owner.is_some_and(|owner| !owner.is_empty() && owner.chars().count() <= 160)
}

fn query(request: &ParsedRequest, name: &str) -> String {
    request.query_parameter(name).unwrap_or_default()
}

fn query_i64(request: &ParsedRequest, name: &str, fallback: i64) -> i64 {
    request
        .query_parameter(name)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(fallback)
}

fn apply_item_fields(window: &mut Value, fields: Option<&str>) {
    let Some(items) = window.get_mut("items").and_then(Value::as_array_mut) else {
        return;
    };
    for item in items {
        *item = apply_fields(item.clone(), fields);
    }
}

#[derive(Debug)]
struct RateLimitResult {
    ok: bool,
    count: u32,
    limit: u32,
    reset_at: SystemTime,
    retry_after_ms: u64,
}

fn check_rate_limit(
    config: &EventSyncRouteConfig,
    key: &str,
    limit: u32,
) -> Result<RateLimitResult> {
    let now = SystemTime::now();
    let mut buckets = config
        .rate_limits
        .lock()
        .map_err(|_| anyhow::anyhow!("Event sync rate limiter is unavailable"))?;
    let bucket = buckets.entry(key.to_string()).or_insert(RateBucket {
        count: 0,
        reset_at: now + Duration::from_secs(60),
    });
    if bucket.reset_at <= now {
        bucket.count = 0;
        bucket.reset_at = now + Duration::from_secs(60);
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
    let mut headers = vec![
        ("X-RateLimit-Limit".into(), result.limit.to_string()),
        (
            "X-RateLimit-Remaining".into(),
            result.limit.saturating_sub(result.count).to_string(),
        ),
        (
            "X-RateLimit-Reset".into(),
            result
                .reset_at
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .to_string(),
        ),
    ];
    if !result.ok {
        headers.push((
            "Retry-After".into(),
            result.retry_after_ms.div_ceil(1000).to_string(),
        ));
    }
    headers
}

fn audit_success(
    data_dir: &Path,
    request: &ParsedRequest,
    peer_ip: &str,
    device_id: &str,
    event_type: &str,
    target: &str,
    meta: &Value,
) -> Result<()> {
    audit_record(
        data_dir, request, peer_ip, device_id, event_type, true, target, "", meta,
    )
}

#[allow(clippy::too_many_arguments)]
fn audit_record(
    data_dir: &Path,
    request: &ParsedRequest,
    peer_ip: &str,
    device_id: &str,
    event_type: &str,
    success: bool,
    target: &str,
    reason: &str,
    meta: &Value,
) -> Result<()> {
    let database_path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let current: DateTime<Utc> = SystemTime::now().into();
    let current = current.to_rfc3339_opts(SecondsFormat::Millis, true);
    connection.execute(
        "INSERT INTO audit_log (
           event_type, event_at, device_id, ip, user_agent, method, path,
           success, reason, target, meta_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?2)",
        params![
            event_type,
            current,
            device_id,
            peer_ip,
            request.header("user-agent").unwrap_or(""),
            request.method,
            request.path(),
            i64::from(success),
            reason,
            target,
            meta.to_string()
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{route_event_sync_request, EventSyncRouteConfig};
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
            "vibelink-event-sync-http-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":["bridge.test"]}"#,
        )
        .unwrap();
        let db = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE devices (
               id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
               created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT,
               expires_at TEXT, rotated_at TEXT, meta_json TEXT
             );
             CREATE TABLE event_acks (
               device_id TEXT NOT NULL, stream_id TEXT NOT NULL, cursor INTEGER NOT NULL,
               event_id TEXT, acked_at TEXT NOT NULL, metadata_json TEXT,
               PRIMARY KEY(device_id, stream_id)
             );
             CREATE TABLE compaction_markers (
               marker_id TEXT PRIMARY KEY, stream_id TEXT NOT NULL,
               from_cursor INTEGER NOT NULL, to_cursor INTEGER NOT NULL,
               compacted_at TEXT NOT NULL, metadata_json TEXT
             );
             CREATE TABLE task_events (
               cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
               event_id TEXT NOT NULL, event_type TEXT, event_kind TEXT, turn_id TEXT,
               block_id TEXT, event_at TEXT NOT NULL, text TEXT,
               payload_json TEXT, event_json TEXT
             );
             CREATE TABLE tool_events (
               cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, tool_run_id TEXT NOT NULL,
               event_id TEXT NOT NULL, event_type TEXT, event_at TEXT NOT NULL, text TEXT,
               payload_json TEXT, event_json TEXT
             );
             CREATE TABLE live_call_events (
               cursor INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
               event_id TEXT NOT NULL, event_type TEXT, event_at TEXT NOT NULL, text TEXT,
               payload_json TEXT, event_json TEXT
             );
             CREATE TABLE audit_log (
               cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
               event_at TEXT NOT NULL, device_id TEXT, ip TEXT, user_agent TEXT,
               method TEXT, path TEXT, success INTEGER NOT NULL DEFAULT 0,
               reason TEXT, target TEXT, meta_json TEXT, created_at TEXT NOT NULL
             );",
        )
        .unwrap();
        db.execute(
            "INSERT INTO devices VALUES (?1, 'Current', ?2, '2026-07-01T00:00:00.000Z', NULL, NULL, '2099-01-01T00:00:00.000Z', NULL, '{}')",
            params!["device-current", hash_token("active-token")],
        )
        .unwrap();
        data_dir
    }

    #[test]
    fn binds_ack_to_authenticated_device_and_detects_conflicts() {
        let data_dir = ready_data_dir();
        let config = EventSyncRouteConfig::new(data_dir.clone());
        let request = parse_request(
            b"POST /api/events/ack HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\nContent-Length: 0\r\n\r\n",
        )
        .unwrap();
        let first = route_event_sync_request(
            &request,
            "127.0.0.1",
            Some(
                br#"{"deviceId":"spoofed","streamId":"task:task-1","cursor":4,"expectedCursor":0}"#,
            ),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(first.status, 200);
        assert_eq!(first.body["ack"]["deviceId"], "device-current");

        let conflict = route_event_sync_request(
            &request,
            "127.0.0.1",
            Some(br#"{"streamId":"task:task-1","cursor":8,"expectedCursor":0}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(conflict.status, 409);
        assert_eq!(conflict.body["code"], "EVENT_ACK_CONFLICT");
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn exposes_ack_and_compaction_marker_reads() {
        let data_dir = ready_data_dir();
        let db = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        db.execute(
            "INSERT INTO compaction_markers VALUES ('m1', 'task:task-1', 1, 2, '2026-07-20T00:00:00.000Z', '{}')",
            [],
        )
        .unwrap();
        drop(db);
        let config = EventSyncRouteConfig::new(data_dir.clone());
        let request = parse_request(
            b"GET /api/events/compaction-markers?streamId=task%3Atask-1 HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        let response = route_event_sync_request(&request, "127.0.0.1", None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(
            response.body,
            json!({ "items": [{
            "markerId": "m1", "streamId": "task:task-1", "fromCursor": 1,
            "toCursor": 2, "compactedAt": "2026-07-20T00:00:00.000Z", "metadata": {}
        }] })
        );
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn rate_limits_compaction_and_audits_the_denial() {
        let data_dir = ready_data_dir();
        let config = EventSyncRouteConfig::new(data_dir.clone());
        let request = parse_request(
            b"POST /api/events/compact HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\nContent-Length: 0\r\n\r\n",
        )
        .unwrap();
        let body = br#"{"streamId":"task:task-1","dryRun":true}"#;
        for _ in 0..20 {
            let response = route_event_sync_request(&request, "127.0.0.1", Some(body), &config)
                .unwrap()
                .unwrap();
            assert_eq!(response.status, 200);
        }
        let denied = route_event_sync_request(&request, "127.0.0.1", Some(body), &config)
            .unwrap()
            .unwrap();
        assert_eq!(denied.status, 429);
        assert!(denied.header("Retry-After").is_some());
        let db = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM audit_log WHERE event_type = 'rate_limit' AND success = 0",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        drop(db);
        fs::remove_dir_all(data_dir).unwrap();
    }
}
