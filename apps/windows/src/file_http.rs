use crate::status_http::{authenticate_route_request, ParsedRequest, RouteAuthentication};
use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};

pub const FILE_RUNTIME_ROUTES: &[(&str, &str)] = &[("GET", "/api/files")];

#[derive(Clone)]
pub struct FileRouteConfig {
    data_dir: PathBuf,
}

impl FileRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }
}

pub fn stream_file_request(
    request: &ParsedRequest,
    config: &FileRouteConfig,
    client: &mut TcpStream,
) -> Result<Option<()>> {
    if request.method != "GET" || request.path() != "/api/files" {
        return Ok(None);
    }
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => return Ok(None),
        RouteAuthentication::HostDenied => return write_error(client, 403, "Host is not allowed."),
        RouteAuthentication::Unauthorized => return write_error(client, 401, "Unauthorized"),
        RouteAuthentication::Device(_) => {}
    }

    let requested_parameter = request
        .query_parameter("path")
        .unwrap_or_default();
    let requested = requested_parameter
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>');
    let path = allowed_file_path(requested, &config.data_dir)?;
    let extension = normalized_extension(&path);
    if !is_servable_extension(&extension) {
        return write_error(client, 400, "Unsupported file");
    }
    let metadata = fs::metadata(&path).with_context(|| format!("Cannot stat {}", path.display()))?;
    if !metadata.is_file() {
        return write_error(client, 404, "File not found");
    }
    if !is_image_extension(&extension) && metadata.len() > 25 * 1024 * 1024 {
        return write_error(client, 413, "File is too large to serve through the bridge.");
    }
    let bytes = fs::read(&path).with_context(|| format!("Cannot read {}", path.display()))?;
    let disposition = if is_image_extension(&extension) || extension == "pdf" {
        "inline"
    } else {
        "attachment"
    };
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download")
        .replace('"', "_");
    write!(
        client,
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Disposition: {}; filename=\"{}\"\r\nX-Content-Type-Options: nosniff\r\nCache-Control: private, max-age=60\r\nContent-Length: {}\r\nConnection: close\r\nX-VibeLink-Control-Plane: rust\r\n\r\n",
        content_type(&extension),
        disposition,
        file_name,
        bytes.len()
    )?;
    client.write_all(&bytes)?;
    Ok(Some(()))
}

fn write_error(client: &mut TcpStream, status: u16, message: &str) -> Result<Option<()>> {
    let body = format!("{{\"error\":\"{}\"}}", message.replace('"', "\\\""));
    let reason = match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    write!(
        client,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nX-VibeLink-Control-Plane: rust\r\n\r\n{}",
        body.len(),
        body
    )?;
    Ok(Some(()))
}

fn allowed_file_path(value: &str, data_dir: &Path) -> Result<PathBuf> {
    if value.is_empty() {
        bail!("Unsupported file");
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        bail!("Unsupported file");
    }
    let resolved = path.canonicalize().unwrap_or(path);
    if !allowed_roots(data_dir)?.iter().any(|root| is_inside_root(&resolved, root)) {
        bail!("Path is outside allowed roots.");
    }
    Ok(resolved)
}

fn is_inside_root(path: &Path, root: &Path) -> bool {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    path == root || path.starts_with(root)
}

fn allowed_roots(data_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut roots = Vec::new();
    let settings_path = data_dir.join("settings.json");
    if let Ok(text) = fs::read_to_string(settings_path) {
        if let Ok(settings) = serde_json::from_str::<Value>(&text) {
            if let Some(default_cwd) = settings.get("defaultCwd").and_then(Value::as_str) {
                if !default_cwd.trim().is_empty() {
                    roots.push(PathBuf::from(default_cwd));
                }
            }
            if let Some(items) = settings.get("allowedRoots").and_then(Value::as_array) {
                for item in items.iter().filter_map(Value::as_str) {
                    if !item.trim().is_empty() {
                        roots.push(PathBuf::from(item));
                    }
                }
            }
        }
    }
    let database_path = data_dir.join("mobile-agent.sqlite");
    if database_path.is_file() {
        let connection = Connection::open_with_flags(
            database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        if table_exists(&connection, "workspaces")? {
            let mut statement = connection.prepare("SELECT path, allowed_root FROM workspaces")?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                ))
            })?;
            for row in rows {
                let (path, allowed_root) = row?;
                for value in [allowed_root, path] {
                    if !value.trim().is_empty() {
                        roots.push(PathBuf::from(value));
                    }
                }
            }
        }
    }
    roots.sort();
    roots.dedup();
    Ok(roots)
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get::<_, i64>(0),
    )? == 1)
}

fn normalized_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_image_extension(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif")
}

fn is_servable_extension(extension: &str) -> bool {
    matches!(
        extension,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "pdf" | "txt" | "md"
            | "csv" | "json" | "jsonl" | "yaml" | "yml" | "toml" | "doc" | "docx"
            | "xls" | "xlsx" | "ppt" | "pptx" | "zip"
    )
}

fn content_type(extension: &str) -> &'static str {
    match extension {
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "json" | "jsonl" => "application/json; charset=utf-8",
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use std::io::Read;
    use std::net::TcpListener;

    fn auth_dir() -> PathBuf {
        let directory = std::env::temp_dir().join(format!("vibelink-files-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":["bridge.test"],"allowedRoots":[]}"#,
        )
        .unwrap();
        let database = Connection::open(directory.join("mobile-agent.sqlite")).unwrap();
        database.execute_batch("CREATE TABLE devices (id TEXT, label TEXT, token_hash TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT, expires_at TEXT, rotated_at TEXT, meta_json TEXT); CREATE TABLE workspaces (id TEXT, title TEXT, path TEXT, allowed_root TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, meta_json TEXT);").unwrap();
        database.execute("INSERT INTO devices VALUES ('device', 'Device', ?1, '', '', NULL, '2099-01-01T00:00:00.000Z', NULL, '{}')", params![hash_token("token")]).unwrap();
        database.execute("INSERT INTO workspaces VALUES ('workspace', 'Workspace', ?1, ?1, '', '', NULL, '{}')", params![directory.to_string_lossy()]).unwrap();
        drop(database);
        directory
    }

    fn capture_response(request: &ParsedRequest, config: &FileRouteConfig) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut client = std::net::TcpStream::connect(address).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        stream_file_request(request, config, &mut server).unwrap().unwrap();
        drop(server);
        let mut output = String::new();
        client.read_to_string(&mut output).unwrap();
        output
    }

    #[test]
    fn streams_authenticated_servable_file_with_rust_owner_header() {
        let directory = auth_dir();
        let file = directory.join("hello.txt");
        fs::write(&file, "hello").unwrap();
        let request = parse_request(
            format!(
                "GET /api/files?path={} HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer token\r\n\r\n",
                file.to_string_lossy().replace('\\', "%5C")
            )
            .as_bytes(),
        )
        .unwrap();
        let response = capture_response(&request, &FileRouteConfig::new(directory.clone()));
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(response.contains("X-VibeLink-Control-Plane: rust"));
        assert!(response.ends_with("hello"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_unsupported_extensions_before_streaming() {
        let directory = auth_dir();
        let file = directory.join("secret.exe");
        fs::write(&file, "nope").unwrap();
        let request = parse_request(
            format!(
                "GET /api/files?path={} HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer token\r\n\r\n",
                file.to_string_lossy().replace('\\', "%5C")
            )
            .as_bytes(),
        )
        .unwrap();
        let response = capture_response(&request, &FileRouteConfig::new(directory.clone()));
        assert!(response.starts_with("HTTP/1.1 400 Bad Request"));
        assert!(FILE_RUNTIME_ROUTES.contains(&("GET", "/api/files")));
        fs::remove_dir_all(directory).unwrap();
    }
}
