use crate::status_http::{authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication};
use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DESKTOP_REMOTE_RUNTIME_ROUTES: &[(&str, &str)] =
    &[("GET", "/api/desktop-remote/observations")];

#[derive(Clone)]
pub struct DesktopRemoteRouteConfig {
    data_dir: PathBuf,
}

impl DesktopRemoteRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }
}

pub fn route_desktop_remote_request(
    request: &ParsedRequest,
    config: &DesktopRemoteRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "GET" || request.path() != "/api/desktop-remote/observations" {
        return Ok(None);
    }
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => Ok(None),
        RouteAuthentication::HostDenied => Ok(Some(HttpRouteResponse::error(403, "Host is not allowed."))),
        RouteAuthentication::Unauthorized => Ok(Some(HttpRouteResponse::error(401, "Unauthorized"))),
        RouteAuthentication::Device(_) => {
            let after = request
                .query_parameter("after")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0)
                .max(0);
            let limit = request
                .query_parameter("limit")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(100)
                .clamp(1, 1000);
            Ok(Some(HttpRouteResponse::json(
                200,
                json!({ "items": list_observations(&config.data_dir, after, limit)? }),
            )))
        }
    }
}

fn list_observations(data_dir: &Path, after: i64, limit: i64) -> Result<Vec<Value>> {
    let database = Connection::open_with_flags(
        data_dir.join("mobile-agent.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("Cannot open desktop observation database")?;
    database.busy_timeout(Duration::from_secs(5))?;
    let mut statement = database.prepare(
        "SELECT cursor, observed_at, hash, event_type, observation_json, event_json
         FROM desktop_observations WHERE cursor > ?1 ORDER BY cursor ASC LIMIT ?2",
    )?;
    let rows = statement.query_map([after, limit], |row| {
        let observation: Value = serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_else(|_| json!({}));
        let event: Value = serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or(Value::Null);
        let event_object = event.as_object();
        Ok(json!({
            "type": event_object.and_then(|value| value.get("type")).cloned().unwrap_or_else(|| json!(row.get::<_, String>(3).unwrap_or_else(|_| "desktop.snapshot".to_string()))),
            "cursor": row.get::<_, i64>(0)?,
            "observedAt": event_object.and_then(|value| value.get("observedAt")).cloned().unwrap_or_else(|| json!(row.get::<_, String>(1).unwrap_or_default())),
            "hash": row.get::<_, String>(2)?,
            "desktop": event_object.and_then(|value| value.get("desktop")).cloned().unwrap_or(observation),
        }))
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>().context("Cannot read desktop observations")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use std::fs;

    #[test]
    fn reads_authenticated_desktop_observations_in_cursor_order() {
        let directory = std::env::temp_dir().join(format!("vibelink-desktop-remote-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":["bridge.test"]}"#,
        )
        .unwrap();
        let database = Connection::open(directory.join("mobile-agent.sqlite")).unwrap();
        database.execute_batch("CREATE TABLE devices (id TEXT, label TEXT, token_hash TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT, expires_at TEXT, rotated_at TEXT, meta_json TEXT); CREATE TABLE desktop_observations (cursor INTEGER PRIMARY KEY, observed_at TEXT, hash TEXT, event_type TEXT, observation_json TEXT, event_json TEXT);").unwrap();
        database.execute("INSERT INTO devices VALUES ('device', 'Device', ?1, '', '', NULL, '2099-01-01T00:00:00.000Z', NULL, '{}')", params![hash_token("token")]).unwrap();
        database.execute("INSERT INTO desktop_observations VALUES (1, '2026-07-01T00:00:00.000Z', 'hash', 'desktop.snapshot', '{\"ready\":true}', 'null')", []).unwrap();
        let request = parse_request(b"GET /api/desktop-remote/observations?after=0&limit=1 HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let response = route_desktop_remote_request(&request, &DesktopRemoteRouteConfig::new(directory.clone())).unwrap().unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["items"][0]["cursor"], 1);
        assert_eq!(response.body["items"][0]["desktop"]["ready"], true);
        assert!(DESKTOP_REMOTE_RUNTIME_ROUTES.contains(&("GET", "/api/desktop-remote/observations")));
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }
}
