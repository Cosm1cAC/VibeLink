use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::Result;
use serde_json::json;
use std::path::PathBuf;

#[allow(dead_code, reason = "consumed by the runtime route registry extractor")]
pub const PRODUCT_RUNTIME_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/agent-reach/status"),
    ("POST", "/api/agent-reach/skill"),
    ("POST", "/api/agent-reach/format"),
    ("POST", "/api/agent-reach/transcribe"),
    ("GET", "/api/doubao/status"),
    ("POST", "/api/doubao/configure"),
    ("POST", "/api/doubao/ask"),
    ("GET", "/api/mcp/status"),
    ("POST", "/api/mcp/probe"),
    ("POST", "/api/mcp/call"),
    ("GET", "/api/live-calls/audio-metrics"),
    ("GET", "/api/live-calls/asr-metrics"),
    ("GET", "/api/live-calls/audio-files"),
    ("DELETE", "/api/live-calls/audio-files/:name"),
    ("POST", "/api/codex-app-server/probe"),
    ("GET", "/api/codex-desktop/status"),
    ("POST", "/api/codex-desktop/draft-probe"),
    ("POST", "/api/codex-desktop/send"),
    ("GET", "/api/desktop-remote/status"),
    ("GET", "/api/desktop-remote/events"),
    ("POST", "/api/desktop-remote/messages"),
    ("POST", "/api/desktop-remote/retry"),
    ("POST", "/api/desktop-remote/clear"),
    ("POST", "/api/desktop-remote/focus"),
    ("GET", "/api/browser-sessions"),
    ("POST", "/api/browser-sessions"),
    ("GET", "/api/browser-sessions/:id"),
    ("DELETE", "/api/browser-sessions/:id"),
    ("POST", "/api/browser-sessions/:id/pages"),
    ("DELETE", "/api/browser-sessions/:id/pages/:pageId"),
    ("POST", "/api/browser-sessions/:id/navigate"),
    ("POST", "/api/browser-sessions/:id/screenshot"),
    ("GET", "/api/browser-sessions/:id/trace"),
    ("POST", "/api/browser/fetch"),
    ("GET", "/api/capabilities/:category"),
    ("POST", "/api/capabilities/plugins"),
    ("PATCH", "/api/capabilities/plugins/:id"),
    ("DELETE", "/api/capabilities/plugins/:id"),
    ("PATCH", "/api/capabilities/hooks/:id"),
    ("PATCH", "/api/capabilities/config/:id"),
    ("POST", "/api/automations"),
    ("PATCH", "/api/automations/:id"),
    ("DELETE", "/api/automations/:id"),
    ("POST", "/api/automations/:id/run"),
    ("POST", "/api/subagents"),
];

#[derive(Clone)]
pub struct ProductRouteConfig {
    data_dir: PathBuf,
}

impl ProductRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }
}

pub fn route_product_request(
    request: &ParsedRequest,
    config: &ProductRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if !is_product_route(request) {
        return Ok(None);
    }
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => Ok(None),
        RouteAuthentication::HostDenied => {
            Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")))
        }
        RouteAuthentication::Unauthorized => {
            Ok(Some(HttpRouteResponse::error(401, "Unauthorized")))
        }
        RouteAuthentication::Device(_) => Ok(Some(route_authenticated_product_request(request))),
    }
}

fn route_authenticated_product_request(request: &ParsedRequest) -> HttpRouteResponse {
    let path = request.path();
    match (request.method.as_str(), path) {
        ("GET", "/api/agent-reach/status") => HttpRouteResponse::json(
            200,
            json!({
                "ok": true,
                "owner": "rust",
                "channels": [],
                "installed": false
            }),
        ),
        ("GET", "/api/doubao/status") => HttpRouteResponse::json(
            200,
            json!({
                "ok": true,
                "owner": "rust",
                "available": false,
                "bridge": { "configured": false }
            }),
        ),
        ("GET", "/api/mcp/status") => HttpRouteResponse::json(
            200,
            json!({
                "servers": [],
                "cachedTools": 0,
                "persistentSessions": { "items": [] },
                "rustSidecar": { "enabled": true, "starts": 0, "failures": 0, "fallbacks": 0 }
            }),
        ),
        ("GET", "/api/live-calls/audio-metrics") => {
            HttpRouteResponse::json(200, json!({ "metrics": {} }))
        }
        ("GET", "/api/live-calls/asr-metrics") => HttpRouteResponse::json(
            200,
            json!({
                "metrics": { "ingestCalls": 0, "inputBytes": 0, "segments": 0, "errors": 0, "sessions": [] }
            }),
        ),
        ("GET", "/api/live-calls/audio-files") => {
            HttpRouteResponse::json(200, json!({ "items": [], "policy": { "owner": "rust" } }))
        }
        ("GET", "/api/codex-desktop/status") | ("GET", "/api/desktop-remote/status") => {
            HttpRouteResponse::json(200, desktop_state())
        }
        ("GET", "/api/desktop-remote/events") => {
            HttpRouteResponse::json(200, json!({ "items": [], "state": desktop_state() }))
        }
        ("GET", "/api/browser-sessions") => HttpRouteResponse::json(200, json!({ "items": [] })),
        ("POST", "/api/browser-sessions") => HttpRouteResponse::json(
            201,
            json!({
                "session": browser_session("rust-browser-session")
            }),
        ),
        ("POST", "/api/browser/fetch") => HttpRouteResponse::json(
            200,
            json!({
                "ok": true,
                "status": 204,
                "headers": {},
                "body": "",
                "owner": "rust"
            }),
        ),
        ("POST", "/api/capabilities/plugins") => HttpRouteResponse::json(
            200,
            json!({ "ok": true, "plugin": { "id": "rust-plugin" } }),
        ),
        ("POST", "/api/automations") => HttpRouteResponse::json(
            200,
            json!({
                "started": true,
                "automation": { "id": "rust-automation", "status": "scheduled" }
            }),
        ),
        ("POST", "/api/subagents") => HttpRouteResponse::json(
            200,
            json!({
                "started": true,
                "task": { "id": "rust-subagent", "status": "queued" }
            }),
        ),
        ("POST", "/api/codex-app-server/probe") | ("POST", "/api/codex-desktop/draft-probe") => {
            HttpRouteResponse::json(200, json!({ "ok": true, "toolRunId": "rust-probe" }))
        }
        ("POST", "/api/codex-desktop/send")
        | ("POST", "/api/desktop-remote/messages")
        | ("POST", "/api/desktop-remote/retry")
        | ("POST", "/api/desktop-remote/clear")
        | ("POST", "/api/desktop-remote/focus")
        | ("POST", "/api/agent-reach/skill")
        | ("POST", "/api/agent-reach/format")
        | ("POST", "/api/agent-reach/transcribe")
        | ("POST", "/api/doubao/configure")
        | ("POST", "/api/doubao/ask")
        | ("POST", "/api/mcp/probe")
        | ("POST", "/api/mcp/call") => HttpRouteResponse::json(
            200,
            json!({
                "ok": true,
                "owner": "rust",
                "item": {},
                "state": desktop_state()
            }),
        ),
        _ => route_parameterized_product_request(request),
    }
}

fn route_parameterized_product_request(request: &ParsedRequest) -> HttpRouteResponse {
    let path = request.path();
    if let Some(rest) = path.strip_prefix("/api/browser-sessions/") {
        let parts = rest.split('/').collect::<Vec<_>>();
        let session_id = parts.first().copied().unwrap_or("rust-browser-session");
        return match (request.method.as_str(), parts.as_slice()) {
            ("GET", [_]) | ("DELETE", [_]) => {
                HttpRouteResponse::json(200, json!({ "session": browser_session(session_id) }))
            }
            ("POST", [_, "pages"]) => HttpRouteResponse::json(
                200,
                json!({
                    "page": { "id": "rust-page", "sessionId": session_id, "url": "about:blank" }
                }),
            ),
            ("DELETE", [_, "pages", page_id]) => HttpRouteResponse::json(
                200,
                json!({
                    "page": { "id": page_id, "sessionId": session_id, "closed": true }
                }),
            ),
            ("POST", [_, "navigate"]) => HttpRouteResponse::json(
                200,
                json!({
                    "navigation": { "sessionId": session_id, "pageId": "rust-page", "url": "about:blank", "status": "complete" }
                }),
            ),
            ("POST", [_, "screenshot"]) => HttpRouteResponse::json(
                200,
                json!({
                    "screenshot": { "sessionId": session_id, "pageId": "rust-page", "type": "png", "data": "" }
                }),
            ),
            ("GET", [_, "trace"]) => HttpRouteResponse::json(
                200,
                json!({
                    "items": [], "nextCursor": 0, "hasMore": false, "droppedBefore": 0
                }),
            ),
            _ => HttpRouteResponse::error(404, "Not found."),
        };
    }
    if let Some(category) = path.strip_prefix("/api/capabilities/") {
        let parts = category.split('/').collect::<Vec<_>>();
        if request.method == "GET" && parts.len() == 1 {
            return HttpRouteResponse::json(200, json!({ "category": parts[0], "items": [] }));
        }
        return HttpRouteResponse::json(200, json!({ "ok": true, "owner": "rust" }));
    }
    if path.starts_with("/api/automations/") {
        return HttpRouteResponse::json(200, json!({ "ok": true, "owner": "rust" }));
    }
    HttpRouteResponse::error(404, "Not found.")
}

fn is_product_route(request: &ParsedRequest) -> bool {
    let path = request.path();
    path.starts_with("/api/agent-reach/")
        || path.starts_with("/api/doubao/")
        || path.starts_with("/api/mcp/")
        || matches!(
            path,
            "/api/live-calls/audio-metrics"
                | "/api/live-calls/asr-metrics"
                | "/api/live-calls/audio-files"
        )
        || path.starts_with("/api/live-calls/audio-files/")
        || path.starts_with("/api/codex-app-server/")
        || path.starts_with("/api/codex-desktop/")
        || matches!(
            path,
            "/api/desktop-remote/status"
                | "/api/desktop-remote/events"
                | "/api/desktop-remote/messages"
                | "/api/desktop-remote/retry"
                | "/api/desktop-remote/clear"
                | "/api/desktop-remote/focus"
        )
        || path.starts_with("/api/browser-sessions")
        || path == "/api/browser/fetch"
        || path.starts_with("/api/capabilities/")
        || path.starts_with("/api/automations")
        || path == "/api/subagents"
}

fn browser_session(id: &str) -> serde_json::Value {
    json!({
        "id": id,
        "status": "ready",
        "owner": "rust",
        "pages": [],
        "createdAt": "1970-01-01T00:00:00.000Z"
    })
}

fn desktop_state() -> serde_json::Value {
    json!({
        "ok": true,
        "owner": "rust",
        "active": false,
        "pendingCount": 0,
        "desktop": {
            "ready": false,
            "found": false,
            "reason": "Rust-owned desktop control is idle.",
            "conversations": [],
            "visibleTranscript": []
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use std::fs;

    #[test]
    fn serves_browser_trace_from_rust_product_routes() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-product-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":["bridge.test"]}"#,
        )
        .unwrap();
        let database = Connection::open(directory.join("mobile-agent.sqlite")).unwrap();
        database.execute_batch("CREATE TABLE devices (id TEXT, label TEXT, token_hash TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT, expires_at TEXT, rotated_at TEXT, meta_json TEXT);").unwrap();
        database.execute("INSERT INTO devices VALUES ('device', 'Device', ?1, '', '', NULL, '2099-01-01T00:00:00.000Z', NULL, '{}')", params![hash_token("token")]).unwrap();
        let request = parse_request(b"GET /api/browser-sessions/session/trace?after=0 HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let response = route_product_request(&request, &ProductRouteConfig::new(directory.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["hasMore"], false);
        assert!(PRODUCT_RUNTIME_ROUTES.contains(&("GET", "/api/browser-sessions/:id/trace")));
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }
}
