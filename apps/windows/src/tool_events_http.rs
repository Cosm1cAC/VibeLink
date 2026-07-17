use crate::audit_http::audit_route_rejection;
use crate::device_http::apply_fields;
use crate::status_http::{
    authenticate_route_request, clean_host, HttpRouteResponse, ParsedRequest, RouteAuthentication,
    RouteMetrics,
};
use crate::tool_events_store::{list_tool_events, ToolEventListOptions};
use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ToolEventsRouteConfig {
    data_dir: PathBuf,
    metrics: Arc<RouteMetrics>,
}

impl ToolEventsRouteConfig {
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

pub fn route_tool_events_request(
    request: &ParsedRequest,
    peer_ip: &str,
    config: &ToolEventsRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "GET"
        || request.path() != "/api/tool-events"
        || request.query_parameter("stream").as_deref() == Some("1")
    {
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

    let options = list_options(request);
    let fields = request.query_parameter("fields");
    let items = query_tool_events(&config.data_dir, &options)?
        .into_iter()
        .map(|item| apply_fields(item, fields.as_deref()))
        .collect::<Vec<_>>();
    config.metrics.record_response();
    Ok(Some(HttpRouteResponse::json(
        200,
        json!({ "items": items }),
    )))
}

/// Serve the long-lived tool-event stream. A bounded lifetime keeps reconnects
/// explicit and preserves the Node path as an immediate rollback option.
pub fn stream_tool_events_request(
    request: &ParsedRequest,
    peer_ip: &str,
    config: &ToolEventsRouteConfig,
    client: &mut TcpStream,
) -> Result<Option<()>> {
    if request.method != "GET"
        || request.path() != "/api/tool-events"
        || request.query_parameter("stream").as_deref() != Some("1")
    {
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
            HttpRouteResponse::error(403, "Host is not allowed.").write_to(client)?;
            config.metrics.record_response();
            return Ok(Some(()));
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
            HttpRouteResponse::error(401, "Unauthorized").write_to(client)?;
            config.metrics.record_response();
            return Ok(Some(()));
        }
        RouteAuthentication::Device(_) => {}
        RouteAuthentication::Pending => unreachable!(),
    }

    let mut after = request
        .query_parameter("after")
        .or_else(|| request.header("last-event-id").map(str::to_string))
        .map(|value| javascript_number(&value))
        .unwrap_or(0.0);
    let started = Instant::now();
    client.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache, no-transform\r\nConnection: keep-alive\r\nX-VibeLink-Control-Plane: rust\r\n\r\n")?;
    client.flush()?;
    let mut heartbeat = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        let options = ToolEventListOptions {
            tool_run_id: request.query_parameter("toolRunId"),
            workspace_id: request.query_parameter("workspaceId"),
            task_id: request.query_parameter("taskId"),
            after: Some(after),
            limit: Some(500),
        };
        let events = query_tool_events(&config.data_dir, &options)?;
        for event in events {
            let cursor = event.get("cursor").and_then(Value::as_i64).unwrap_or(0);
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("tool.event");
            let data = serde_json::to_string(&event).context("Cannot encode tool event")?;
            write!(
                client,
                "id: {cursor}\nevent: {event_type}\ndata: {data}\n\n"
            )?;
            after = cursor as f64;
            heartbeat = Instant::now();
        }
        if heartbeat.elapsed() >= Duration::from_secs(25) {
            client.write_all(b": ping\n\n")?;
            heartbeat = Instant::now();
        }
        client.flush()?;
        thread::sleep(Duration::from_millis(250));
    }
    config.metrics.record_response();
    Ok(Some(()))
}

fn list_options(request: &ParsedRequest) -> ToolEventListOptions {
    let after = request
        .query_parameter("after")
        .filter(|value| !value.is_empty())
        .or_else(|| request.header("last-event-id").map(str::to_string))
        .map(|value| javascript_number(&value))
        .unwrap_or(0.0);
    let limit = request
        .query_parameter("limit")
        .map(|value| javascript_number(&value))
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.floor().clamp(1.0, 5_000.0) as i64);
    ToolEventListOptions {
        tool_run_id: request.query_parameter("toolRunId"),
        workspace_id: request.query_parameter("workspaceId"),
        task_id: request.query_parameter("taskId"),
        after: Some(after),
        limit,
    }
}

fn javascript_number(value: &str) -> f64 {
    let value = value.trim();
    if value.is_empty() {
        return 0.0;
    }
    match value {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => value.parse::<f64>().unwrap_or(f64::NAN),
    }
}

fn query_tool_events(data_dir: &Path, options: &ToolEventListOptions) -> Result<Vec<Value>> {
    let database_path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", database_path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("Cannot configure tool-events database timeout")?;
    list_tool_events(&connection, options)
}

#[cfg(test)]
mod tests {
    use super::{list_options, route_tool_events_request, ToolEventsRouteConfig};
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
            "vibelink-tool-events-http-{}-{nonce}",
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
                CREATE TABLE tool_events (
                    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                    tool_run_id TEXT NOT NULL,
                    task_id TEXT,
                    workspace_id TEXT,
                    event_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    event_at TEXT NOT NULL,
                    text TEXT,
                    payload_json TEXT,
                    event_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(tool_run_id, event_id)
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
                    "Tool events admin",
                    hash_token("active-token"),
                    "2026-07-01T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z"
                ],
            )
            .unwrap();
        for (tool_run_id, task_id, workspace_id, event_id, event_json) in [
            (
                "tool-1",
                "task-1",
                "workspace-1",
                "event-1",
                r#"{"id":"event-1","type":"tool.stdout","payload":{"value":1}}"#,
            ),
            (
                "tool-1",
                "task-1",
                "workspace-1",
                "event-2",
                r#"{"id":"event-2","type":"tool.completed","payload":{"value":2}}"#,
            ),
            (
                "tool-2",
                "task-2",
                "workspace-2",
                "event-3",
                r#"{"id":"event-3","type":"tool.stdout","payload":{"value":3}}"#,
            ),
        ] {
            database
                .execute(
                    "INSERT INTO tool_events (
                        tool_run_id, task_id, workspace_id, event_id, event_type,
                        event_at, text, payload_json, event_json, created_at
                     ) VALUES (?1, ?2, ?3, ?4, 'tool.event',
                        '2026-07-01T00:00:00.000Z', '', 'null', ?5,
                        '2026-07-01T00:00:00.000Z')",
                    params![tool_run_id, task_id, workspace_id, event_id, event_json],
                )
                .unwrap();
        }
        data_dir
    }

    #[test]
    fn normalizes_replay_numbers_like_node() {
        for (raw, expected) in [
            ("0.5", Some(1)),
            ("3.9", Some(3)),
            ("9000", Some(5_000)),
            ("0", None),
            ("invalid", None),
        ] {
            let request = parse_request(
                format!("GET /api/tool-events?limit={raw} HTTP/1.1\r\nHost: bridge.test\r\n\r\n")
                    .as_bytes(),
            )
            .unwrap();
            assert_eq!(list_options(&request).limit, expected, "limit={raw}");
        }

        let invalid_after = parse_request(
            b"GET /api/tool-events?after=invalid HTTP/1.1\r\nHost: bridge.test\r\n\r\n",
        )
        .unwrap();
        assert!(list_options(&invalid_after).after.unwrap().is_nan());
    }

    #[test]
    fn lists_filtered_events_in_cursor_order_with_nested_fields() {
        let data_dir = ready_data_dir();
        let config = ToolEventsRouteConfig::new(data_dir.clone());
        let request = parse_request(
            b"GET /api/tool-events?after=1&limit=1&toolRunId=tool-1&workspaceId=workspace-1&taskId=task-1&fields=cursor%2Cid%2Cpayload.value HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        let response = route_tool_events_request(&request, "127.0.0.1", &config)
            .unwrap()
            .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(
            response.body,
            json!({
                "items": [{
                    "cursor": 2,
                    "id": "event-2",
                    "payload": { "value": 2 }
                }]
            })
        );

        let invalid_after = parse_request(
            b"GET /api/tool-events?after=invalid HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        let invalid_after = route_tool_events_request(&invalid_after, "127.0.0.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(invalid_after.body, json!({ "items": [] }));
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn uses_last_event_id_and_enforces_authentication() {
        let data_dir = ready_data_dir();
        let config = ToolEventsRouteConfig::new(data_dir.clone());
        let request = parse_request(
            b"GET /api/tool-events?limit=1 HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\nLast-Event-ID: 1\r\n\r\n",
        )
        .unwrap();
        let response = route_tool_events_request(&request, "127.0.0.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.body["items"][0]["cursor"], 2);

        let anonymous =
            parse_request(b"GET /api/tool-events HTTP/1.1\r\nHost: bridge.test\r\n\r\n").unwrap();
        assert_eq!(
            route_tool_events_request(&anonymous, "127.0.0.1", &config)
                .unwrap()
                .unwrap()
                .status,
            401
        );
        let blocked = parse_request(
            b"GET /api/tool-events HTTP/1.1\r\nHost: attacker.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        assert_eq!(
            route_tool_events_request(&blocked, "127.0.0.1", &config)
                .unwrap()
                .unwrap()
                .status,
            403
        );

        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let rows = database
            .prepare(
                "SELECT event_type, reason, target, path
                 FROM audit_log ORDER BY cursor",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (
                    "auth.failed".to_string(),
                    "missing_token".to_string(),
                    "".to_string(),
                    "/api/tool-events".to_string(),
                ),
                (
                    "host.blocked".to_string(),
                    "Host is not allowed.".to_string(),
                    "attacker.test".to_string(),
                    "/api/tool-events".to_string(),
                ),
            ]
        );
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn leaves_streaming_unmatched_and_unready_requests_for_node() {
        let data_dir = ready_data_dir();
        let config = ToolEventsRouteConfig::new(data_dir.clone());
        for raw in [
            b"GET /api/tool-events?stream=1 HTTP/1.1\r\nHost: bridge.test\r\n\r\n".as_slice(),
            b"POST /api/tool-events HTTP/1.1\r\nHost: bridge.test\r\n\r\n".as_slice(),
            b"GET /api/tasks HTTP/1.1\r\nHost: bridge.test\r\n\r\n".as_slice(),
        ] {
            let request = parse_request(raw).unwrap();
            assert!(route_tool_events_request(&request, "127.0.0.1", &config)
                .unwrap()
                .is_none());
        }

        let unready_dir = data_dir.join("missing");
        let unready = ToolEventsRouteConfig::new(unready_dir);
        let request =
            parse_request(b"GET /api/tool-events HTTP/1.1\r\nHost: bridge.test\r\n\r\n").unwrap();
        assert!(route_tool_events_request(&request, "127.0.0.1", &unready)
            .unwrap()
            .is_none());
        fs::remove_dir_all(data_dir).unwrap();
    }
}
