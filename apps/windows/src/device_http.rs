use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication, RouteMetrics,
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone)]
pub struct DeviceRouteConfig {
    data_dir: PathBuf,
    metrics: Arc<RouteMetrics>,
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
    Ok(Some(HttpRouteResponse {
        status: 200,
        body: json!({
            "items": items,
            "currentDeviceId": current_device_id,
            "controlPlaneRuntime": { "devicesHttp": config.metrics.value() }
        }),
    }))
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

fn apply_fields(value: Value, fields: Option<&str>) -> Value {
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
    use super::{route_device_request, DeviceRouteConfig};
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
        assert_eq!(response.body["items"].as_array().unwrap().len(), 2);
        assert_eq!(response.body["items"][0]["id"], "device-current");
        assert_eq!(response.body["items"][0]["label"], "Android phone");
        assert_eq!(response.body["items"][0]["expired"], false);
        assert_eq!(response.body["items"][0]["meta"]["platform"], "android");
        assert_eq!(response.body["items"][1]["id"], "device-old");
        assert_eq!(
            response.body["items"][1]["revokedAt"],
            "2026-06-02T00:00:00.000Z"
        );
        assert_eq!(response.body["items"][1]["expired"], true);

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
    fn waits_for_node_initialization_before_owning_device_lists() {
        let data_dir = temporary_data_dir();
        let config = DeviceRouteConfig::new(data_dir.clone());
        let request =
            parse_request(b"GET /api/devices HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();

        assert!(route_device_request(&request, &config).unwrap().is_none());
        fs::remove_dir_all(data_dir).unwrap();
    }
}
