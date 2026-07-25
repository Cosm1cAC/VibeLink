use crate::settings_contract::load_settings;
use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::Result;
use serde_json::{json, Value};
use std::path::PathBuf;

#[allow(dead_code, reason = "consumed by the runtime route registry extractor")]
pub const CLOUDFLARE_RUNTIME_ROUTES: &[(&str, &str)] = &[("GET", "/api/cloudflare/guide")];

#[derive(Clone)]
pub struct CloudflareRouteConfig {
    data_dir: PathBuf,
    root: PathBuf,
}

impl CloudflareRouteConfig {
    pub fn new(data_dir: PathBuf, root: PathBuf) -> Self {
        Self { data_dir, root }
    }
}

pub fn route_cloudflare_request(
    request: &ParsedRequest,
    config: &CloudflareRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "GET" || request.path() != "/api/cloudflare/guide" {
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
    let settings = load_settings(&config.data_dir, &config.root)?;
    let host = clean_host(request.header("host").unwrap_or(""));
    let allowlist = settings
        .get("hostAllowlist")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(clean_host)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let public_host = !host.is_empty() && !is_local_host(&host) && !is_private_ipv4(&host);
    let registered = !public_host || allowlist.iter().any(|item| host_matches(item, &host));
    let listening_on_all_interfaces =
        settings.get("host").and_then(Value::as_str) == Some("0.0.0.0");
    let mut warnings = Vec::new();
    if host.ends_with(".trycloudflare.com") {
        warnings.push(if registered {
            "Public Cloudflare Tunnel host is registered. Keep device tokens and allowed roots narrow."
        } else {
            "Public Cloudflare Tunnel host is not registered in Host allowlist."
        });
    }
    if listening_on_all_interfaces {
        warnings.push("Server listens on all interfaces.");
    }
    if public_host && !registered {
        warnings.push("Public host is blocked until it is explicitly added to Host allowlist.");
    }
    Ok(Some(HttpRouteResponse::json(
        200,
        json!({
            "host": host,
            "publicHost": public_host,
            "tunnelDetected": host.ends_with(".trycloudflare.com"),
            "registered": registered,
            "listeningOnAllInterfaces": listening_on_all_interfaces,
            "allowlist": allowlist,
            "accessRecommended": public_host,
            "warnings": warnings,
            "steps": [
                "Create or choose a fixed Cloudflare Tunnel hostname.",
                "Add that exact hostname to Host allowlist before exposing the bridge.",
                "Optionally protect the hostname with Cloudflare Access.",
                "Pair each device through a short-lived pairing session and revoke old devices.",
                "Keep allowed roots narrow and review audit logs after remote access."
            ]
        }),
    )))
}

fn clean_host(value: &str) -> String {
    let value = value
        .trim()
        .trim_end_matches('.')
        .strip_prefix("http://")
        .or_else(|| value.trim().strip_prefix("https://"))
        .unwrap_or(value.trim())
        .split('/')
        .next()
        .unwrap_or("");
    if let Some(host) = value
        .strip_prefix('[')
        .and_then(|value| value.split(']').next())
    {
        return host.to_ascii_lowercase();
    }
    value
        .rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|character| character.is_ascii_digit()))
        .map(|(host, _)| host)
        .unwrap_or(value)
        .to_ascii_lowercase()
}

fn host_matches(configured: &str, host: &str) -> bool {
    configured == host
        || configured
            .strip_prefix("*.")
            .is_some_and(|suffix| host.ends_with(&format!(".{suffix}")))
}

fn is_local_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn is_private_ipv4(host: &str) -> bool {
    let parts = host
        .split('.')
        .map(str::parse::<u8>)
        .collect::<std::result::Result<Vec<_>, _>>();
    let Ok(parts) = parts else {
        return false;
    };
    parts.len() == 4
        && (parts[0] == 10
            || parts[0] == 127
            || parts[0] == 192 && parts[1] == 168
            || parts[0] == 172 && (16..=31).contains(&parts[1]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use std::fs;

    #[test]
    fn serves_authenticated_cloudflare_guide_from_rust() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-cloudflare-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":["127.0.0.1"]}"#,
        )
        .unwrap();
        let database = Connection::open(directory.join("mobile-agent.sqlite")).unwrap();
        database.execute_batch("CREATE TABLE devices (id TEXT, label TEXT, token_hash TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT, expires_at TEXT, rotated_at TEXT, meta_json TEXT);").unwrap();
        database.execute("INSERT INTO devices VALUES ('device', 'Device', ?1, '', '', NULL, '2099-01-01T00:00:00.000Z', NULL, '{}')", params![hash_token("token")]).unwrap();
        let request = parse_request(
            b"GET /api/cloudflare/guide HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nAuthorization: Bearer token\r\n\r\n",
        )
        .unwrap();
        let response = route_cloudflare_request(
            &request,
            &CloudflareRouteConfig::new(directory.clone(), directory.clone()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["host"], "127.0.0.1");
        assert_eq!(response.body["publicHost"], false);
        assert!(CLOUDFLARE_RUNTIME_ROUTES.contains(&("GET", "/api/cloudflare/guide")));
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn preserves_wildcard_matching_and_public_warning_contract() {
        assert!(host_matches(
            "*.trycloudflare.com",
            "demo.trycloudflare.com"
        ));
        assert!(!host_matches("*.trycloudflare.com", "trycloudflare.com"));
        assert_eq!(clean_host("https://Demo.Example:443/path"), "demo.example");
        assert_eq!(clean_host("[::1]:8787"), "::1");
    }
}
