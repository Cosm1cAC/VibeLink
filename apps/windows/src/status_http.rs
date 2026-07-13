use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::str;

pub const MAX_HEADER_BYTES: usize = 64 * 1024;
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
        self.target
            .split_once('?')
            .map(|(_, query)| query)
            .unwrap_or("")
            .split('&')
            .filter_map(|part| part.split_once('='))
            .find(|(key, _)| *key == "token")
            .and_then(|(_, value)| urlencoding::decode(value).ok())
            .map(|value| value.into_owned())
            .unwrap_or_default()
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
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

fn clean_host(value: &str) -> String {
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
        if let Some(suffix) = allowed.strip_prefix('*') {
            !suffix.is_empty() && host.ends_with(suffix) && host.len() > suffix.len()
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
        authenticate_device, hash_token, is_host_allowed, parse_request, AuthResult,
        MAX_HEADER_BYTES,
    };
    use rusqlite::{params, Connection};

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
            b"GET /api/status?token=query%2Dtoken HTTP/1.1\r\nHost: 127.0.0.1:8787\r\n\r\n",
        )
        .unwrap();
        assert_eq!(query_only.token(), "query-token");

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
}
