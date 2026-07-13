use anyhow::{bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::str;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

pub const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_INTERNAL_JSON_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADERS: usize = 64;

#[derive(Debug)]
pub struct ParsedRequest {
    pub method: String,
    target: String,
    headers: Vec<(String, String)>,
}

impl ParsedRequest {
    pub fn path(&self) -> &str {
        self.target
            .split_once('?')
            .map_or(&self.target, |(path, _)| path)
    }

    pub fn host(&self) -> &str {
        self.header("host").unwrap_or("")
    }

    pub fn token(&self) -> String {
        if let Some(authorization) = self.header("authorization") {
            if authorization
                .get(..7)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("Bearer "))
            {
                return authorization[7..].trim().to_string();
            }
        }
        self.query_parameter("token").unwrap_or_default()
    }

    pub(crate) fn query_parameter(&self, name: &str) -> Option<String> {
        self.target
            .split_once('?')
            .map(|(_, query)| query)
            .unwrap_or("")
            .split('&')
            .filter_map(|part| {
                let (key, value) = part.split_once('=').unwrap_or((part, ""));
                let key = decode_query_component(key)?;
                (key == name)
                    .then(|| decode_query_component(value))
                    .flatten()
            })
            .next()
    }

    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

fn decode_query_component(value: &str) -> Option<String> {
    let form_value = value.replace('+', " ");
    urlencoding::decode(&form_value)
        .ok()
        .map(|value| value.into_owned())
}

pub fn parse_request(bytes: &[u8]) -> Result<ParsedRequest, String> {
    if bytes.len() > MAX_HEADER_BYTES {
        return Err("request headers exceed limit".to_string());
    }
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut request = httparse::Request::new(&mut headers);
    match request.parse(bytes).map_err(|error| error.to_string())? {
        httparse::Status::Complete(_) => {}
        httparse::Status::Partial => return Err("request headers are incomplete".to_string()),
    }
    let method = request
        .method
        .ok_or_else(|| "request method is missing".to_string())?
        .to_string();
    let target = request
        .path
        .ok_or_else(|| "request target is missing".to_string())?
        .to_string();
    let mut parsed_headers = Vec::with_capacity(request.headers.len());
    for header in request.headers {
        let value = str::from_utf8(header.value)
            .map_err(|_| "request header is not UTF-8".to_string())?
            .trim()
            .to_string();
        if parsed_headers
            .iter()
            .any(|(name, _): &(String, String)| name.eq_ignore_ascii_case(header.name))
        {
            return Err(format!("duplicate request header: {}", header.name));
        }
        parsed_headers.push((header.name.to_string(), value));
    }
    Ok(ParsedRequest {
        method,
        target,
        headers: parsed_headers,
    })
}

pub(crate) fn clean_host(value: &str) -> String {
    let mut host = value.trim().to_ascii_lowercase();
    if let Some(value) = host
        .strip_prefix("http://")
        .or_else(|| host.strip_prefix("https://"))
    {
        host = value.to_string();
    }
    if let Some((value, _)) = host.split_once('/') {
        host = value.to_string();
    }
    if host.starts_with('[') {
        if let Some(end) = host.find(']') {
            return host[..=end].to_string();
        }
    }
    if let Some((name, port)) = host.rsplit_once(':') {
        if port.chars().all(|character| character.is_ascii_digit()) {
            return name.to_string();
        }
    }
    host
}

pub fn is_host_allowed(value: &str, configured: &[String]) -> bool {
    let host = clean_host(value);
    if host.is_empty() {
        return true;
    }
    if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]" {
        return true;
    }
    if host.starts_with("10.") || host.starts_with("192.168.") {
        return true;
    }
    if let Some(second) = host
        .strip_prefix("172.")
        .and_then(|rest| rest.split('.').next())
        .and_then(|value| value.parse::<u8>().ok())
    {
        if (16..=31).contains(&second) {
            return true;
        }
    }
    configured.iter().any(|entry| {
        let allowed = clean_host(entry);
        if let Some(suffix) = allowed.strip_prefix("*.") {
            host.strip_suffix(suffix)
                .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1)
        } else {
            host == allowed
        }
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthResult {
    Open,
    Device(String),
    Unauthorized,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusHttpSettings {
    #[serde(default)]
    pairing_token: String,
    #[serde(default)]
    host_allowlist: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RouteAuthentication {
    Pending,
    HostDenied,
    Unauthorized,
    Device(String),
}

pub(crate) enum RoutePreparation {
    Pending,
    HostDenied,
    Ready(Connection),
}

#[derive(Debug, Clone)]
pub struct StatusRouteConfig {
    data_dir: PathBuf,
    upstream: SocketAddr,
    internal_token: String,
    metrics: Arc<RouteMetrics>,
}

#[derive(Debug, Default)]
pub(crate) struct RouteMetrics {
    attempts: AtomicU64,
    responses: AtomicU64,
    fallbacks: AtomicU64,
    failures: AtomicU64,
    host_denied: AtomicU64,
    unauthorized: AtomicU64,
}

impl RouteMetrics {
    pub(crate) fn record_attempt(&self) {
        self.attempts.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn record_response(&self) {
        self.responses.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn record_fallback(&self) {
        self.fallbacks.fetch_add(1, Ordering::SeqCst);
        self.failures.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn record_failure(&self) {
        self.failures.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn record_host_denied(&self) {
        self.host_denied.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn record_unauthorized(&self) {
        self.unauthorized.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn value(&self) -> Value {
        json!({
            "implementation": "rust",
            "attempts": self.attempts.load(Ordering::SeqCst),
            "responses": self.responses.load(Ordering::SeqCst),
            "fallbacks": self.fallbacks.load(Ordering::SeqCst),
            "failures": self.failures.load(Ordering::SeqCst),
            "hostDenied": self.host_denied.load(Ordering::SeqCst),
            "unauthorized": self.unauthorized.load(Ordering::SeqCst),
            "pending": 0
        })
    }
}

impl StatusRouteConfig {
    pub fn new(data_dir: PathBuf, upstream: SocketAddr, internal_token: String) -> Self {
        Self {
            data_dir,
            upstream,
            internal_token,
            metrics: Arc::new(RouteMetrics::default()),
        }
    }

    fn record_response(&self) {
        self.metrics.record_response();
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.record_fallback();
    }

    fn metrics_value(&self) -> Value {
        self.metrics.value()
    }
}

#[derive(Debug)]
pub struct HttpRouteResponse {
    pub status: u16,
    pub body: Value,
    headers: Vec<(String, String)>,
}

impl HttpRouteResponse {
    pub(crate) fn error(status: u16, message: &str) -> Self {
        Self {
            status,
            body: json!({ "error": message }),
            headers: Vec::new(),
        }
    }

    pub(crate) fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            headers: Vec::new(),
        }
    }

    pub(crate) fn with_headers(mut self, headers: Vec<(String, String)>) -> Self {
        self.headers = headers;
        self
    }

    #[cfg(test)]
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn write_to(&self, writer: &mut impl Write) -> io::Result<()> {
        let body = serde_json::to_vec(&self.body)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let reason = match self.status {
            200 => "OK",
            201 => "Created",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            409 => "Conflict",
            410 => "Gone",
            413 => "Content Too Large",
            428 => "Precondition Required",
            429 => "Too Many Requests",
            503 => "Service Unavailable",
            _ => "Internal Server Error",
        };
        write!(
            writer,
            "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nX-VibeLink-Control-Plane: rust\r\n",
            self.status,
            reason,
            body.len()
        )?;
        for (name, value) in &self.headers {
            write!(writer, "{name}: {value}\r\n")?;
        }
        write!(writer, "\r\n")?;
        writer.write_all(&body)?;
        writer.flush()
    }
}

pub fn route_status_request(
    request: &ParsedRequest,
    config: &StatusRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "GET" || request.path() != "/api/status" {
        return Ok(None);
    }

    let authentication = authenticate_route_request(request, &config.data_dir)?;
    if authentication == RouteAuthentication::Pending {
        return Ok(None);
    }
    config.metrics.record_attempt();
    match authentication {
        RouteAuthentication::HostDenied => {
            config.metrics.record_host_denied();
            config.record_response();
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")));
        }
        RouteAuthentication::Unauthorized => {
            config.metrics.record_unauthorized();
            config.record_response();
            return Ok(Some(HttpRouteResponse::error(401, "Unauthorized")));
        }
        RouteAuthentication::Device(_) => {}
        RouteAuthentication::Pending => unreachable!(),
    }

    let snapshot = fetch_status_snapshot(request.host(), config)?;
    let mut body = crate::status_sidecar::render_status_snapshot(snapshot)
        .context("Invalid internal Status snapshot")?;
    let object = body
        .as_object_mut()
        .context("Rendered Status response must be an object")?;
    let runtime = object
        .entry("controlPlaneRuntime")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("Rendered Status controlPlaneRuntime must be an object")?;
    config.record_response();
    runtime.insert("statusHttp".to_string(), config.metrics_value());
    Ok(Some(HttpRouteResponse::json(200, body)))
}

pub(crate) fn authenticate_route_request(
    request: &ParsedRequest,
    data_dir: &Path,
) -> Result<RouteAuthentication> {
    let connection = match prepare_route_request(request, data_dir)? {
        RoutePreparation::Pending => return Ok(RouteAuthentication::Pending),
        RoutePreparation::HostDenied => return Ok(RouteAuthentication::HostDenied),
        RoutePreparation::Ready(connection) => connection,
    };
    let now: DateTime<Utc> = SystemTime::now().into();
    let now = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    match authenticate_device(&connection, true, &request.token(), &now)
        .context("Cannot authenticate control-plane request")?
    {
        AuthResult::Device(id) => Ok(RouteAuthentication::Device(id)),
        AuthResult::Open => Ok(RouteAuthentication::Unauthorized),
        AuthResult::Unauthorized => Ok(RouteAuthentication::Unauthorized),
    }
}

pub(crate) fn prepare_route_request(
    request: &ParsedRequest,
    data_dir: &Path,
) -> Result<RoutePreparation> {
    let settings_path = data_dir.join("settings.json");
    let settings_source = match fs::read_to_string(&settings_path) {
        Ok(source) => source,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(RoutePreparation::Pending)
        }
        Err(error) => {
            return Err(error).with_context(|| format!("Cannot read {}", settings_path.display()))
        }
    };
    let settings: StatusHttpSettings = serde_json::from_str(&settings_source)
        .with_context(|| format!("Cannot parse {}", settings_path.display()))?;
    if settings.pairing_token.is_empty() {
        return Ok(RoutePreparation::Pending);
    }

    let database_path = data_dir.join("mobile-agent.sqlite");
    if !database_path.exists() {
        return Ok(RoutePreparation::Pending);
    }
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {}", database_path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("Cannot configure control-plane authentication database timeout")?;
    let devices_ready = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'devices'",
            [],
            |_| Ok(()),
        )
        .optional()
        .context("Cannot inspect control-plane authentication schema")?
        .is_some();
    if !devices_ready {
        return Ok(RoutePreparation::Pending);
    }
    if !is_host_allowed(request.host(), &settings.host_allowlist) {
        return Ok(RoutePreparation::HostDenied);
    }
    Ok(RoutePreparation::Ready(connection))
}

fn fetch_status_snapshot(host: &str, config: &StatusRouteConfig) -> Result<Value> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(5))
        .timeout_write(Duration::from_secs(2))
        .build();
    let url = format!("http://{}/internal/status-snapshot", config.upstream);
    let mut request = agent
        .get(&url)
        .set("X-VibeLink-Internal-Token", &config.internal_token);
    if !host.is_empty() {
        request = request.set("X-VibeLink-Original-Host", host);
    }
    let response = request
        .call()
        .context("Internal Status snapshot request failed")?;
    read_internal_json(response, "Status snapshot")
}

pub(crate) fn read_internal_json(response: ureq::Response, label: &str) -> Result<Value> {
    if response
        .header("Content-Length")
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_INTERNAL_JSON_BYTES)
    {
        bail!("Internal {label} exceeds {MAX_INTERNAL_JSON_BYTES} bytes");
    }
    read_json_bounded(response.into_reader(), MAX_INTERNAL_JSON_BYTES)
        .with_context(|| format!("Internal {label} is not valid bounded JSON"))
}

fn read_json_bounded(mut reader: impl Read, max_bytes: usize) -> Result<Value> {
    let mut body = Vec::new();
    reader
        .by_ref()
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut body)
        .context("Cannot read internal JSON response")?;
    if body.len() > max_bytes {
        bail!("Internal JSON response exceeds {max_bytes} bytes");
    }
    serde_json::from_slice(&body).context("Internal response is not valid JSON")
}

pub fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub fn authenticate_device(
    connection: &Connection,
    pairing_configured: bool,
    token: &str,
    now: &str,
) -> rusqlite::Result<AuthResult> {
    if !pairing_configured {
        return Ok(AuthResult::Open);
    }
    if token.is_empty() {
        return Ok(AuthResult::Unauthorized);
    }
    let device_id = connection
        .query_row(
            "SELECT id FROM devices
             WHERE token_hash = ?1
               AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at = '' OR expires_at > ?2)",
            rusqlite::params![hash_token(token), now],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(device_id) = device_id else {
        return Ok(AuthResult::Unauthorized);
    };
    connection.execute(
        "UPDATE devices SET last_seen_at = ?1 WHERE id = ?2",
        rusqlite::params![now, device_id],
    )?;
    Ok(AuthResult::Device(device_id))
}

#[cfg(test)]
mod tests {
    use super::{
        authenticate_device, hash_token, is_host_allowed, parse_request, read_json_bounded,
        route_status_request, AuthResult, StatusRouteConfig, MAX_HEADER_BYTES,
    };
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::fs;
    use std::io::{Cursor, Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn device_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
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
        connection
    }

    fn temporary_data_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "vibelink-status-http-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn parses_bounded_status_request_and_prefers_bearer_token() {
        let request = parse_request(
            b"GET /api/status?token=query%2Dtoken HTTP/1.1\r\nHost: bridge.vibelink.cloud\r\nAuthorization: Bearer header-token\r\n\r\n",
        )
        .unwrap();

        assert_eq!(request.method, "GET");
        assert_eq!(request.path(), "/api/status");
        assert_eq!(request.host(), "bridge.vibelink.cloud");
        assert_eq!(request.token(), "header-token");

        let query_only = parse_request(
            b"GET /api/status?token=query%2Dtoken&fields=id%2Clabel&note=last+seen HTTP/1.1\r\nHost: 127.0.0.1:8787\r\n\r\n",
        )
        .unwrap();
        assert_eq!(query_only.token(), "query-token");
        assert_eq!(
            query_only.query_parameter("fields").as_deref(),
            Some("id,label")
        );
        assert_eq!(
            query_only.query_parameter("note").as_deref(),
            Some("last seen")
        );

        let unicode_authorization = parse_request(
            "GET /api/status?token=query-token HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: 令牌值\r\n\r\n"
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(unicode_authorization.token(), "query-token");

        let oversized = vec![b'a'; MAX_HEADER_BYTES + 1];
        assert!(parse_request(&oversized).is_err());
        assert!(parse_request(b"GET /api/status HTTP/1.1\r\nHost").is_err());
    }

    #[test]
    fn bounds_internal_json_before_deserialization() {
        let parsed = read_json_bounded(Cursor::new(br#"{"ok":true}"#), 64).unwrap();
        assert_eq!(parsed, json!({ "ok": true }));

        let error = read_json_bounded(Cursor::new(vec![b' '; 65]), 64).unwrap_err();
        assert!(error.to_string().contains("exceeds 64 bytes"));
    }

    #[test]
    fn host_allowlist_matches_local_private_exact_and_wildcard_hosts() {
        let allowlist = vec![
            "bridge.vibelink.cloud".to_string(),
            "*.trusted.example".to_string(),
        ];

        assert!(is_host_allowed("127.0.0.1:8787", &allowlist));
        assert!(is_host_allowed("", &allowlist));
        assert!(is_host_allowed("192.168.1.5:8787", &allowlist));
        assert!(is_host_allowed("bridge.vibelink.cloud", &allowlist));
        assert!(is_host_allowed("mobile.trusted.example", &allowlist));
        assert!(!is_host_allowed("trusted.example", &allowlist));
        assert!(!is_host_allowed(
            "eviltrusted.example",
            &["*trusted.example".to_string()]
        ));
        assert!(!is_host_allowed("attacker.example", &allowlist));
    }

    #[test]
    fn device_authentication_matches_node_revocation_expiry_and_last_seen_semantics() {
        let connection = device_database();
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        connection
            .execute(
                "INSERT INTO devices (id, token_hash, last_seen_at, revoked_at, expires_at)
                 VALUES (?1, ?2, '', NULL, ?3)",
                params![
                    "device-active",
                    hash_token("active-token"),
                    "2026-08-01T00:00:00.000Z"
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO devices (id, token_hash, last_seen_at, revoked_at, expires_at)
                 VALUES (?1, ?2, '', ?3, ?4)",
                params![
                    "device-revoked",
                    hash_token("revoked-token"),
                    "2026-07-01T00:00:00.000Z",
                    "2026-08-01T00:00:00.000Z"
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO devices (id, token_hash, last_seen_at, revoked_at, expires_at)
                 VALUES (?1, ?2, '', NULL, ?3)",
                params![
                    "device-expired",
                    hash_token("expired-token"),
                    "2026-07-01T00:00:00.000Z"
                ],
            )
            .unwrap();

        assert_eq!(
            authenticate_device(&connection, false, "", "2026-07-13T00:00:00.000Z").unwrap(),
            AuthResult::Open
        );
        assert_eq!(
            authenticate_device(
                &connection,
                true,
                "active-token",
                "2026-07-13T00:00:00.000Z"
            )
            .unwrap(),
            AuthResult::Device("device-active".to_string())
        );
        assert_eq!(
            authenticate_device(
                &connection,
                true,
                "revoked-token",
                "2026-07-13T00:00:00.000Z"
            )
            .unwrap(),
            AuthResult::Unauthorized
        );
        assert_eq!(
            authenticate_device(
                &connection,
                true,
                "expired-token",
                "2026-07-13T00:00:00.000Z"
            )
            .unwrap(),
            AuthResult::Unauthorized
        );
        assert_eq!(
            authenticate_device(&connection, true, "", "2026-07-13T00:00:00.000Z").unwrap(),
            AuthResult::Unauthorized
        );

        let last_seen: String = connection
            .query_row(
                "SELECT last_seen_at FROM devices WHERE id = 'device-active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(last_seen, "2026-07-13T00:00:00.000Z");
    }

    #[test]
    fn routes_only_authenticated_status_requests_through_the_internal_snapshot() {
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
                params!["device-active", hash_token("active-token")],
            )
            .unwrap();
        drop(database);

        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let snapshot = json!({
            "ok": true,
            "settings": {},
            "providerRegistry": {},
            "storage": { "sqlite": "mobile-agent.sqlite" },
            "security": {},
            "notifications": {},
            "workspaces": [],
            "workspaceRuntime": {},
            "controlPlaneRuntime": {},
            "network": [],
            "tasks": []
        });
        let snapshot_body = serde_json::to_vec(&snapshot).unwrap();
        let upstream_thread = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let mut request = [0_u8; 2048];
            let size = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(request.starts_with("GET /internal/status-snapshot HTTP/1.1\r\n"));
            assert!(request.contains("X-VibeLink-Internal-Token: internal-secret\r\n"));
            assert!(request.contains("X-VibeLink-Original-Host: bridge.test\r\n"));
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                snapshot_body.len()
            )
            .unwrap();
            stream.write_all(&snapshot_body).unwrap();
        });

        let config = StatusRouteConfig::new(
            data_dir.clone(),
            upstream_addr,
            "internal-secret".to_string(),
        );
        let other =
            parse_request(b"GET /api/doctor HTTP/1.1\r\nHost: bridge.test\r\n\r\n").unwrap();
        assert!(route_status_request(&other, &config).unwrap().is_none());

        let blocked = parse_request(
            b"GET /api/status HTTP/1.1\r\nHost: attacker.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        assert_eq!(
            route_status_request(&blocked, &config)
                .unwrap()
                .unwrap()
                .status,
            403
        );

        let anonymous =
            parse_request(b"GET /api/status HTTP/1.1\r\nHost: bridge.test\r\n\r\n").unwrap();
        let anonymous_response = route_status_request(&anonymous, &config).unwrap().unwrap();
        assert_eq!(anonymous_response.status, 401);
        let mut anonymous_wire = Vec::new();
        anonymous_response.write_to(&mut anonymous_wire).unwrap();
        assert!(String::from_utf8(anonymous_wire)
            .unwrap()
            .contains("\r\nX-VibeLink-Control-Plane: rust\r\n"));

        let authenticated = parse_request(
            b"GET /api/status HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\n\r\n",
        )
        .unwrap();
        let response = route_status_request(&authenticated, &config)
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], snapshot["ok"]);
        assert_eq!(
            response.body["controlPlaneRuntime"]["statusHttp"],
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
    fn waits_for_the_node_database_before_owning_authenticated_status() {
        let data_dir = temporary_data_dir();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":[]}"#,
        )
        .unwrap();
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let config = StatusRouteConfig::new(
            data_dir.clone(),
            upstream.local_addr().unwrap(),
            "internal-secret".to_string(),
        );
        let request =
            parse_request(b"GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();

        assert!(route_status_request(&request, &config).unwrap().is_none());
        assert!(!data_dir.join("mobile-agent.sqlite").exists());
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn waits_for_node_to_generate_the_pairing_token_before_owning_status() {
        let data_dir = temporary_data_dir();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"pairingToken":"","hostAllowlist":[]}"#,
        )
        .unwrap();
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let config = StatusRouteConfig::new(
            data_dir.clone(),
            upstream.local_addr().unwrap(),
            "internal-secret".to_string(),
        );
        let request =
            parse_request(b"GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();

        assert!(route_status_request(&request, &config).unwrap().is_none());
        fs::remove_dir_all(data_dir).unwrap();
    }
}
