use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication, RouteMetrics,
};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct DoctorRouteConfig {
    data_dir: PathBuf,
    upstream: SocketAddr,
    internal_token: String,
    metrics: Arc<RouteMetrics>,
}

impl DoctorRouteConfig {
    pub fn new(data_dir: PathBuf, upstream: SocketAddr, internal_token: String) -> Self {
        Self {
            data_dir,
            upstream,
            internal_token,
            metrics: Arc::new(RouteMetrics::default()),
        }
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.record_fallback();
    }
}

pub fn route_doctor_request(
    request: &ParsedRequest,
    config: &DoctorRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "GET" || request.path() != "/api/doctor" {
        return Ok(None);
    }

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
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(401, "Unauthorized")));
        }
        RouteAuthentication::Device(device_id) => device_id,
        RouteAuthentication::Pending => unreachable!(),
    };

    let mut body = fetch_doctor_report(request, &device_id, config)?;
    let object = body
        .as_object_mut()
        .context("Internal Doctor report must be an object")?;
    object
        .get("checks")
        .and_then(Value::as_array)
        .context("Internal Doctor report must contain checks")?;
    object
        .get("toolRunId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .context("Internal Doctor report must contain toolRunId")?;
    let runtime = object
        .entry("controlPlaneRuntime")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("Doctor controlPlaneRuntime must be an object")?;
    config.metrics.record_response();
    runtime.insert("doctorHttp".to_string(), config.metrics.value());
    Ok(Some(HttpRouteResponse { status: 200, body }))
}

fn fetch_doctor_report(
    request: &ParsedRequest,
    device_id: &str,
    config: &DoctorRouteConfig,
) -> Result<Value> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(15))
        .timeout_write(Duration::from_secs(2))
        .build();
    let url = format!("http://{}/internal/doctor-report", config.upstream);
    let mut internal = agent
        .get(&url)
        .set("X-VibeLink-Internal-Token", &config.internal_token)
        .set("X-VibeLink-Device-Id", device_id);
    for (source, target) in [
        ("host", "X-VibeLink-Original-Host"),
        ("user-agent", "X-VibeLink-Original-User-Agent"),
        ("x-forwarded-for", "X-VibeLink-Original-Forwarded-For"),
    ] {
        if let Some(value) = request.header(source).filter(|value| !value.is_empty()) {
            internal = internal.set(target, value);
        }
    }
    internal
        .call()
        .context("Internal Doctor report request failed")?
        .into_json::<Value>()
        .context("Internal Doctor report is not valid JSON")
}

#[cfg(test)]
mod tests {
    use super::{route_doctor_request, DoctorRouteConfig};
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_data_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "vibelink-doctor-http-{}-{nonce}",
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
                    token_hash TEXT NOT NULL UNIQUE,
                    last_seen_at TEXT,
                    revoked_at TEXT,
                    expires_at TEXT
                );",
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO devices (id, token_hash, last_seen_at, revoked_at, expires_at)
                 VALUES (?1, ?2, '', NULL, '')",
                params!["device-doctor", hash_token("doctor-token")],
            )
            .unwrap();
        data_dir
    }

    #[test]
    fn routes_authenticated_doctor_through_the_internal_tool_boundary() {
        let data_dir = ready_data_dir();
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let report = json!({
            "ok": true,
            "checks": [{ "id": "node", "ok": true }],
            "failures": [],
            "warnings": [],
            "toolRunId": "tool-doctor"
        });
        let report_body = serde_json::to_vec(&report).unwrap();
        let upstream_thread = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let mut request = [0_u8; 4096];
            let size = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(request.starts_with("GET /internal/doctor-report HTTP/1.1\r\n"));
            assert!(request.contains("X-VibeLink-Internal-Token: internal-secret\r\n"));
            assert!(request.contains("X-VibeLink-Device-Id: device-doctor\r\n"));
            assert!(request.contains("X-VibeLink-Original-Host: bridge.test\r\n"));
            assert!(request.contains("X-VibeLink-Original-User-Agent: doctor-test\r\n"));
            assert!(request.contains("X-VibeLink-Original-Forwarded-For: 203.0.113.7\r\n"));
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                report_body.len()
            )
            .unwrap();
            stream.write_all(&report_body).unwrap();
        });
        let config = DoctorRouteConfig::new(
            data_dir.clone(),
            upstream_addr,
            "internal-secret".to_string(),
        );

        let other =
            parse_request(b"GET /api/status HTTP/1.1\r\nHost: bridge.test\r\n\r\n").unwrap();
        assert!(route_doctor_request(&other, &config).unwrap().is_none());

        let blocked = parse_request(
            b"GET /api/doctor HTTP/1.1\r\nHost: attacker.test\r\nAuthorization: Bearer doctor-token\r\n\r\n",
        )
        .unwrap();
        assert_eq!(
            route_doctor_request(&blocked, &config)
                .unwrap()
                .unwrap()
                .status,
            403
        );

        let anonymous =
            parse_request(b"GET /api/doctor HTTP/1.1\r\nHost: bridge.test\r\n\r\n").unwrap();
        assert_eq!(
            route_doctor_request(&anonymous, &config)
                .unwrap()
                .unwrap()
                .status,
            401
        );

        let authenticated = parse_request(
            b"GET /api/doctor HTTP/1.1\r\nHost: bridge.test\r\nUser-Agent: doctor-test\r\nX-Forwarded-For: 203.0.113.7\r\nAuthorization: Bearer doctor-token\r\n\r\n",
        )
        .unwrap();
        let response = route_doctor_request(&authenticated, &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["checks"], report["checks"]);
        assert_eq!(response.body["toolRunId"], "tool-doctor");
        assert_eq!(
            response.body["controlPlaneRuntime"]["doctorHttp"],
            json!({
                "implementation": "rust",
                "attempts": 3,
                "responses": 3,
                "fallbacks": 0,
                "failures": 0,
                "hostDenied": 1,
                "unauthorized": 1,
                "pending": 0
            })
        );
        upstream_thread.join().unwrap();
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn waits_for_node_initialization_before_owning_doctor() {
        let data_dir = temporary_data_dir();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":[]}"#,
        )
        .unwrap();
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let config = DoctorRouteConfig::new(
            data_dir.clone(),
            upstream.local_addr().unwrap(),
            "internal-secret".to_string(),
        );
        let request =
            parse_request(b"GET /api/doctor HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();

        assert!(route_doctor_request(&request, &config).unwrap().is_none());
        assert!(!data_dir.join("mobile-agent.sqlite").exists());
        fs::remove_dir_all(data_dir).unwrap();
    }
}
