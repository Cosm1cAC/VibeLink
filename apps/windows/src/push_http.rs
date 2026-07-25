use crate::settings_contract::load_settings;
use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[allow(dead_code, reason = "consumed by the runtime route registry extractor")]
pub const PUSH_RUNTIME_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/push/public-key"),
    ("GET", "/api/push/subscriptions"),
    ("POST", "/api/push/subscriptions"),
    ("DELETE", "/api/push/subscriptions/:id"),
    ("POST", "/api/push/native-token"),
];

#[derive(Clone)]
pub struct PushRouteConfig {
    data_dir: PathBuf,
    root: PathBuf,
}

impl PushRouteConfig {
    pub fn new(data_dir: PathBuf, root: PathBuf) -> Self {
        Self { data_dir, root }
    }
}

pub fn push_request_requires_body(request: &ParsedRequest) -> bool {
    request.method == "POST"
        && matches!(
            request.path(),
            "/api/push/subscriptions" | "/api/push/native-token"
        )
}

pub fn route_push_request(
    request: &ParsedRequest,
    peer_ip: &str,
    body: Option<&[u8]>,
    config: &PushRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if !is_push_route(request) {
        return Ok(None);
    }
    let device_id = match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => return Ok(None),
        RouteAuthentication::HostDenied => {
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")))
        }
        RouteAuthentication::Unauthorized => {
            return Ok(Some(HttpRouteResponse::error(401, "Unauthorized")))
        }
        RouteAuthentication::Device(device_id) => device_id,
    };
    if request.method == "GET" && request.path() == "/api/push/public-key" {
        let settings = load_settings(&config.data_dir, &config.root)?;
        return Ok(Some(HttpRouteResponse::json(
            200,
            json!({ "publicKey": settings.pointer("/webPush/publicKey").and_then(Value::as_str).unwrap_or("") }),
        )));
    }
    if request.method == "GET" && request.path() == "/api/push/subscriptions" {
        let kind = request.query_parameter("kind").unwrap_or_default();
        return Ok(Some(HttpRouteResponse::json(
            200,
            json!({ "items": list_subscriptions(&config.data_dir, &kind)? }),
        )));
    }
    if request.method == "POST" && request.path() == "/api/push/subscriptions" {
        let body = parse_json_body(body.unwrap_or_default());
        let subscription = body.get("subscription").unwrap_or(&body);
        let record = upsert_push_subscription(&config.data_dir, &device_id, subscription)?;
        audit_push(
            &config.data_dir,
            request,
            peer_ip,
            &device_id,
            "push.subscribe",
            true,
            "",
            record["id"].as_str().unwrap_or(""),
            &json!({}),
        )?;
        return Ok(Some(HttpRouteResponse::json(
            201,
            json!({ "ok": true, "subscription": record }),
        )));
    }
    if request.method == "POST" && request.path() == "/api/push/native-token" {
        let body = parse_json_body(body.unwrap_or_default());
        let record = match upsert_native_push_token(&config.data_dir, &device_id, &body) {
            Ok(record) => record,
            Err(error) => return Ok(Some(HttpRouteResponse::error(400, &error.to_string()))),
        };
        audit_push(
            &config.data_dir,
            request,
            peer_ip,
            &device_id,
            "push.native.subscribe",
            true,
            "",
            record["id"].as_str().unwrap_or(""),
            &json!({
                "provider": record["provider"].as_str().unwrap_or(""),
                "platform": record["platform"].as_str().unwrap_or("")
            }),
        )?;
        return Ok(Some(HttpRouteResponse::json(
            201,
            json!({ "ok": true, "subscription": record }),
        )));
    }
    if request.method == "DELETE" {
        let Some(id) = request.path().strip_prefix("/api/push/subscriptions/") else {
            return Ok(None);
        };
        if id.is_empty() || id.contains('/') {
            return Ok(None);
        }
        let id = urlencoding::decode(id)
            .map(|value| value.into_owned())
            .unwrap_or_else(|_| id.to_string());
        let ok = revoke_push_subscription(&config.data_dir, &id)?;
        audit_push(
            &config.data_dir,
            request,
            peer_ip,
            &device_id,
            "push.unsubscribe",
            ok,
            "",
            &id,
            &json!({}),
        )?;
        return Ok(Some(HttpRouteResponse::json(200, json!({ "ok": ok }))));
    }
    Ok(None)
}

fn is_push_route(request: &ParsedRequest) -> bool {
    PUSH_RUNTIME_ROUTES
        .iter()
        .any(|(method, route)| request.method == *method && route_matches(route, request.path()))
}

fn route_matches(pattern: &str, path: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix("/:id") {
        return path.strip_prefix(prefix).is_some_and(|suffix| {
            suffix.starts_with('/') && suffix.len() > 1 && !suffix[1..].contains('/')
        });
    }
    pattern == path
}

fn parse_json_body(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap_or_else(|_| json!({}))
}

fn open_push_database(data_dir: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        data_dir.join("mobile-agent.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    ensure_push_table(&connection)?;
    Ok(connection)
}

fn ensure_push_table(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS push_subscriptions (
          id TEXT PRIMARY KEY, device_id TEXT, endpoint TEXT UNIQUE NOT NULL,
          subscription_json TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, revoked_at TEXT
        );",
    )?;
    Ok(())
}

fn upsert_push_subscription(
    data_dir: &Path,
    device_id: &str,
    subscription: &Value,
) -> Result<Value> {
    let endpoint = subscription
        .get("endpoint")
        .and_then(Value::as_str)
        .map(clean_endpoint)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Push subscription endpoint is required."))?;
    let current = now_iso();
    let id = subscription_id(&endpoint);
    let mut next_subscription = subscription.as_object().cloned().unwrap_or_default();
    next_subscription
        .entry("kind".to_string())
        .or_insert_with(|| {
            json!(if endpoint.starts_with("native:") {
                "native"
            } else {
                "web"
            })
        });
    next_subscription.insert("endpoint".to_string(), json!(endpoint));
    let subscription_value = Value::Object(next_subscription);
    let connection = open_push_database(data_dir)?;
    connection.execute(
        "INSERT INTO push_subscriptions (id, device_id, endpoint, subscription_json, created_at, updated_at, revoked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, NULL)
         ON CONFLICT(endpoint) DO UPDATE SET
           device_id = excluded.device_id,
           subscription_json = excluded.subscription_json,
           updated_at = excluded.updated_at,
           revoked_at = NULL",
        params![id, clean_string(device_id, 160), endpoint, subscription_value.to_string(), current],
    )?;
    Ok(public_subscription(
        &id,
        device_id,
        &endpoint,
        &subscription_value,
        &current,
        &current,
    ))
}

fn upsert_native_push_token(data_dir: &Path, device_id: &str, body: &Value) -> Result<Value> {
    let token = body
        .get("token")
        .and_then(Value::as_str)
        .map(|value| clean_string(value, 4096))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Native push token is required."))?;
    let provider = body
        .get("provider")
        .and_then(Value::as_str)
        .map(|value| clean_string(value, 80).to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "android".to_string());
    let platform = body
        .get("platform")
        .and_then(Value::as_str)
        .map(|value| clean_string(value, 80).to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "android".to_string());
    let app_id = body
        .get("appId")
        .and_then(Value::as_str)
        .map(|value| clean_string(value, 200))
        .unwrap_or_default();
    let installation_id = body
        .get("installationId")
        .and_then(Value::as_str)
        .map(|value| clean_string(value, 200))
        .unwrap_or_default();
    let endpoint = format!("native:{provider}:{}", digest_hex(token.as_bytes(), 40));
    let subscription = json!({
        "kind": "native",
        "endpoint": endpoint,
        "provider": provider,
        "token": token,
        "platform": platform,
        "appId": app_id,
        "installationId": installation_id
    });
    let mut record = upsert_push_subscription(data_dir, device_id, &subscription)?;
    if let Some(object) = record.as_object_mut() {
        object.insert("provider".to_string(), json!(provider));
        object.insert("platform".to_string(), json!(platform));
        object.insert("appId".to_string(), json!(app_id));
        object.insert("installationId".to_string(), json!(installation_id));
    }
    Ok(record)
}

fn revoke_push_subscription(data_dir: &Path, id_or_endpoint: &str) -> Result<bool> {
    let current = now_iso();
    let connection = open_push_database(data_dir)?;
    let result = connection.execute(
        "UPDATE push_subscriptions SET revoked_at = ?1 WHERE revoked_at IS NULL AND (id = ?2 OR endpoint = ?2)",
        params![current, id_or_endpoint],
    )?;
    Ok(result > 0)
}

fn public_subscription(
    id: &str,
    device_id: &str,
    endpoint: &str,
    subscription: &Value,
    created_at: &str,
    updated_at: &str,
) -> Value {
    let kind = subscription
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if endpoint.starts_with("native:") {
                "native"
            } else {
                "web"
            }
        });
    let token = subscription
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("");
    json!({
        "id": id,
        "deviceId": device_id,
        "endpoint": endpoint,
        "kind": kind,
        "provider": subscription.get("provider").and_then(Value::as_str).unwrap_or(""),
        "platform": subscription.get("platform").and_then(Value::as_str).unwrap_or(""),
        "appId": subscription.get("appId").and_then(Value::as_str).unwrap_or(""),
        "installationId": subscription.get("installationId").and_then(Value::as_str).unwrap_or(""),
        "tokenPreview": if token.is_empty() { "" } else { &token[..token.len().min(8)] },
        "createdAt": created_at,
        "updatedAt": updated_at
    })
}

fn now_iso() -> String {
    let current: DateTime<Utc> = SystemTime::now().into();
    current.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn subscription_id(endpoint: &str) -> String {
    digest_hex(endpoint.as_bytes(), 24)
}

fn digest_hex(bytes: &[u8], take: usize) -> String {
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .chars()
        .take(take)
        .collect()
}

fn clean_endpoint(value: &str) -> String {
    clean_string(value, 4096)
}

#[allow(clippy::too_many_arguments)]
fn audit_push(
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
    let database_path = data_dir.join("mobile-agent.sqlite");
    let mut connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", database_path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("Cannot configure push audit database timeout")?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin push audit transaction")?;
    let current = now_iso();
    transaction
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
        .context("Cannot write push audit record")?;
    transaction
        .commit()
        .context("Cannot commit push audit transaction")
}

fn clean_string(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn list_subscriptions(data_dir: &Path, kind: &str) -> Result<Vec<Value>> {
    let connection = open_push_database(data_dir)?;
    let mut statement = connection.prepare(
        "SELECT id,device_id,endpoint,subscription_json,created_at,updated_at
         FROM push_subscriptions WHERE revoked_at IS NULL ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        let subscription: Value =
            serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_else(|_| json!({}));
        let endpoint = row.get::<_, String>(2)?;
        Ok(public_subscription(
            &row.get::<_, String>(0)?,
            &row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            &endpoint,
            &subscription,
            &row.get::<_, String>(4)?,
            &row.get::<_, String>(5)?,
        ))
    })?;
    let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(items
        .into_iter()
        .filter(|item| kind.is_empty() || item_kind(item) == kind)
        .collect())
}

fn item_kind(item: &Value) -> &str {
    item["kind"].as_str().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::{route_push_request, PushRouteConfig};
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn ready_data_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data_dir =
            std::env::temp_dir().join(format!("vibelink-push-http-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":["127.0.0.1"],"webPush":{"publicKey":"push-key"}}"#,
        )
        .unwrap();
        let connection = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE devices (
                    id TEXT, label TEXT, token_hash TEXT, created_at TEXT, last_seen_at TEXT,
                    revoked_at TEXT, expires_at TEXT, rotated_at TEXT, meta_json TEXT
                 );
                 CREATE TABLE audit_log (
                    cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, event_at TEXT,
                    device_id TEXT, ip TEXT, user_agent TEXT, method TEXT, path TEXT,
                    success INTEGER, reason TEXT, target TEXT, meta_json TEXT, created_at TEXT
                 );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO devices VALUES (?1,'Device',?2,'','',NULL,'2099-01-01T00:00:00.000Z',NULL,'{}')",
                params!["device", hash_token("device-token")],
            )
            .unwrap();
        data_dir
    }

    fn request(method: &str, path: &str) -> crate::status_http::ParsedRequest {
        parse_request(
            format!(
                "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer device-token\r\nUser-Agent: rust-test\r\n\r\n"
            )
            .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn registers_lists_and_revokes_web_push_subscription() {
        let data_dir = ready_data_dir();
        let config = PushRouteConfig::new(data_dir.clone(), data_dir.clone());
        let body =
            br#"{"subscription":{"endpoint":"https://push.example/sub","keys":{"p256dh":"key"}}}"#;

        let response = route_push_request(
            &request("POST", "/api/push/subscriptions"),
            "127.0.0.1",
            Some(body),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 201);
        let id = response.body["subscription"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(response.body["subscription"]["kind"], "web");

        let response = route_push_request(
            &request("GET", "/api/push/subscriptions"),
            "127.0.0.1",
            None,
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.body["items"].as_array().unwrap().len(), 1);

        let response = route_push_request(
            &request("DELETE", &format!("/api/push/subscriptions/{id}")),
            "127.0.0.1",
            None,
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.body["ok"], true);

        let response = route_push_request(
            &request("GET", "/api/push/subscriptions"),
            "127.0.0.1",
            None,
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.body["items"].as_array().unwrap().len(), 0);

        let connection = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let audit_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE event_type IN ('push.subscribe','push.unsubscribe')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 2);
    }

    #[test]
    fn registers_native_token_and_filters_by_kind() {
        let data_dir = ready_data_dir();
        let config = PushRouteConfig::new(data_dir.clone(), data_dir.clone());
        let body = br#"{"provider":"fcm","token":"native-token-123","platform":"android","appId":"app","installationId":"install"}"#;

        let response = route_push_request(
            &request("POST", "/api/push/native-token"),
            "127.0.0.1",
            Some(body),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 201);
        assert_eq!(response.body["subscription"]["kind"], "native");
        assert_eq!(response.body["subscription"]["provider"], "fcm");
        assert_eq!(response.body["subscription"]["tokenPreview"], "native-t");

        let native_path = format!("{}{}", "/api/push/subscriptions", "?kind=native");
        let response =
            route_push_request(&request("GET", &native_path), "127.0.0.1", None, &config)
                .unwrap()
                .unwrap();
        let items = response.body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["platform"], "android");

        let web_path = format!("{}{}", "/api/push/subscriptions", "?kind=web");
        let response = route_push_request(&request("GET", &web_path), "127.0.0.1", None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.body["items"].as_array().unwrap().len(), 0);

        let connection = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let meta: String = connection
            .query_row(
                "SELECT meta_json FROM audit_log WHERE event_type = 'push.native.subscribe'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let meta: Value = serde_json::from_str(&meta).unwrap();
        assert_eq!(meta["provider"], "fcm");
    }
}
