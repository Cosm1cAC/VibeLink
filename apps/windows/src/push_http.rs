use crate::settings_contract::load_settings;
use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const PUSH_READ_RUNTIME_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/push/public-key"),
    ("GET", "/api/push/subscriptions"),
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

pub fn route_push_read_request(
    request: &ParsedRequest,
    config: &PushRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    let route = (request.method.as_str(), request.path());
    if !PUSH_READ_RUNTIME_ROUTES.contains(&route) {
        return Ok(None);
    }
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => return Ok(None),
        RouteAuthentication::HostDenied => {
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")))
        }
        RouteAuthentication::Unauthorized => {
            return Ok(Some(HttpRouteResponse::error(401, "Unauthorized")))
        }
        RouteAuthentication::Device(_) => {}
    }
    if request.path() == "/api/push/public-key" {
        let settings = load_settings(&config.data_dir, &config.root)?;
        return Ok(Some(HttpRouteResponse::json(
            200,
            json!({ "publicKey": settings.pointer("/webPush/publicKey").and_then(Value::as_str).unwrap_or("") }),
        )));
    }
    let kind = request.query_parameter("kind").unwrap_or_default();
    Ok(Some(HttpRouteResponse::json(
        200,
        json!({ "items": list_subscriptions(&config.data_dir, &kind)? }),
    )))
}

fn list_subscriptions(data_dir: &Path, kind: &str) -> Result<Vec<Value>> {
    let connection = Connection::open_with_flags(
        data_dir.join("mobile-agent.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS push_subscriptions (
          id TEXT PRIMARY KEY, device_id TEXT, endpoint TEXT UNIQUE NOT NULL,
          subscription_json TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, revoked_at TEXT
        );",
    )?;
    let mut statement = connection.prepare(
        "SELECT id,device_id,endpoint,subscription_json,created_at,updated_at
         FROM push_subscriptions WHERE revoked_at IS NULL ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        let subscription: Value =
            serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_else(|_| json!({}));
        let endpoint = row.get::<_, String>(2)?;
        let item_kind = subscription
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_else(|| if endpoint.starts_with("native:") { "native" } else { "web" })
            .to_string();
        let token = subscription
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or("");
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "deviceId": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            "endpoint": endpoint,
            "kind": item_kind,
            "provider": subscription.get("provider").and_then(Value::as_str).unwrap_or(""),
            "platform": subscription.get("platform").and_then(Value::as_str).unwrap_or(""),
            "appId": subscription.get("appId").and_then(Value::as_str).unwrap_or(""),
            "installationId": subscription.get("installationId").and_then(Value::as_str).unwrap_or(""),
            "tokenPreview": if token.is_empty() { "" } else { &token[..token.len().min(8)] },
            "createdAt": row.get::<_, String>(4)?,
            "updatedAt": row.get::<_, String>(5)?
        }))
    })?;
    let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(items
        .into_iter()
        .filter(|item| kind.is_empty() || item["kind"].as_str() == Some(kind))
        .collect())
}
