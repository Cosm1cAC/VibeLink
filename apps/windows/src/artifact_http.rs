use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::io::{Seek, SeekFrom, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct ArtifactRouteConfig {
    data_dir: PathBuf,
}

impl ArtifactRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }
}

pub fn route_artifact_request(
    request: &ParsedRequest,
    config: &ArtifactRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "GET" {
        return Ok(None);
    }
    let Some(id) = request.path().strip_prefix("/api/artifacts/") else {
        return Ok(None);
    };
    if id.is_empty() || id.contains('/') {
        return Ok(None);
    }
    let Some(relative_path) = artifact_path_for(id) else {
        return Ok(Some(HttpRouteResponse::error(400, "Invalid artifact.")));
    };
    let auth = authenticate_route_request(request, &config.data_dir)?;
    match auth {
        RouteAuthentication::Pending => return Ok(None),
        RouteAuthentication::HostDenied => {
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")));
        }
        RouteAuthentication::Unauthorized => {
            return Ok(Some(HttpRouteResponse::error(401, "Unauthorized")));
        }
        RouteAuthentication::Device(_) => {}
    }
    let path = config.data_dir.join("attachments").join(relative_path);
    let metadata = match artifact_metadata(&path, id) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Some(HttpRouteResponse::error(404, "Artifact not found.")));
        }
        Err(error) => return Err(error.into()),
    };
    Ok(Some(HttpRouteResponse::json(
        200,
        json!({ "artifact": metadata }),
    )))
}

pub fn route_artifact_preview_request(
    request: &ParsedRequest,
    config: &ArtifactRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if request.method != "GET" {
        return Ok(None);
    }
    let Some(id) = request.path().strip_prefix("/api/artifacts/").and_then(|path| path.strip_suffix("/preview")) else {
        return Ok(None);
    };
    let Some(relative_path) = artifact_path_for(id) else {
        return Ok(None);
    };
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => return Ok(None),
        RouteAuthentication::HostDenied => return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed."))),
        RouteAuthentication::Unauthorized => return Ok(Some(HttpRouteResponse::error(401, "Unauthorized"))),
        RouteAuthentication::Device(_) => {}
    }
    let path = config.data_dir.join("attachments").join(relative_path);
    let mime_type = mime_type_for(&path);
    if mime_type != "text/csv" && mime_type != "text/tab-separated-values" {
        return Ok(None);
    }
    let source = fs::read_to_string(path)?;
    if source.len() > 8 * 1024 * 1024 {
        return Ok(Some(HttpRouteResponse::error(413, "Artifact source exceeds the preview limit.")));
    }
    let delimiter = if mime_type == "text/csv" { ',' } else { '\t' };
    let mut rows = parse_delimited_preview(&source, delimiter).into_iter();
    let columns = rows.next().unwrap_or_default();
    let data = rows.take(200).collect::<Vec<_>>();
    let redaction_count = columns.iter().chain(data.iter().flatten()).filter(|value| value.contains("[REDACTED]")).count();
    let source_rows = source.lines().filter(|line| !line.is_empty()).count().saturating_sub(1);
    Ok(Some(HttpRouteResponse::json(200, json!({
        "preview": {
            "version": 1,
            "readonly": false,
            "mimeType": mime_type,
            "kind": "table",
            "document": { "type": "table", "columns": columns, "rows": data },
            "truncated": { "rows": source_rows > data.len(), "columns": columns.len() >= 100 },
            "redaction": { "applied": redaction_count > 0, "count": redaction_count },
            "limits": { "maxBytes": 8 * 1024 * 1024, "maxRows": 200, "maxColumns": 100 }
        }
    }))))
}

fn artifact_path_for(id: &str) -> Option<PathBuf> {
    let (uuid, extension) = id.split_once('.')?;
    if extension.is_empty()
        || extension.len() > 16
        || !extension.chars().all(|character| character.is_ascii_alphanumeric())
        || uuid::Uuid::parse_str(uuid).is_err()
    {
        return None;
    }
    Some(PathBuf::from(format!("{uuid}.{extension}")))
}

fn artifact_metadata(path: &Path, id: &str) -> std::io::Result<serde_json::Value> {
    let stat = fs::metadata(path)?;
    if !stat.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Artifact is not a file.",
        ));
    }
    let mime_type = mime_type_for(path);
    let kind = kind_for(mime_type);
    let modified_at = DateTime::<Utc>::from(stat.modified()?).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok(json!({
        "version": 1,
        "id": id,
        "name": id,
        "mimeType": mime_type,
        "kind": kind,
        "size": stat.len(),
        "modifiedAt": modified_at,
        "digest": format!("sha256:{}", sha256(path)?),
        "capabilities": {
            "rangeRead": true,
            "preview": kind != "binary",
            "mutation": kind == "table" || kind == "notebook"
        }
    }))
}

fn sha256(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn mime_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "ipynb" => "application/x-ipynb+json",
        "json" => "application/json",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

fn kind_for(mime_type: &str) -> &'static str {
    match mime_type {
        "application/pdf" => "pdf",
        "application/msword"
        | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "document",
        "application/vnd.ms-excel"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "workbook",
        "application/vnd.ms-powerpoint"
        | "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "presentation",
        "text/csv" | "text/tab-separated-values" => "table",
        "application/x-ipynb+json" => "notebook",
        "application/json" | "text/plain" | "text/markdown" => "text",
        _ => "binary",
    }
}

pub fn stream_artifact_content_request(
    request: &ParsedRequest,
    config: &ArtifactRouteConfig,
    client: &mut TcpStream,
) -> Result<Option<()>> {
    if request.method != "GET" {
        return Ok(None);
    }
    let Some(id) = request.path().strip_prefix("/api/artifacts/").and_then(|path| path.strip_suffix("/content")) else {
        return Ok(None);
    };
    let Some(relative_path) = artifact_path_for(id) else {
        return Ok(None);
    };
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => return Ok(None),
        RouteAuthentication::HostDenied => {
            return HttpRouteResponse::error(403, "Host is not allowed.").write_to(client).map(|_| Some(())).map_err(Into::into);
        }
        RouteAuthentication::Unauthorized => {
            return HttpRouteResponse::error(401, "Unauthorized").write_to(client).map(|_| Some(())).map_err(Into::into);
        }
        RouteAuthentication::Device(_) => {}
    }
    let path = config.data_dir.join("attachments").join(relative_path);
    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return HttpRouteResponse::error(404, "Artifact not found.").write_to(client).map(|_| Some(())).map_err(Into::into);
        }
        Err(error) => return Err(error.into()),
    };
    let size = file.metadata()?.len();
    let Some(range_header) = request.header("range") else {
        return HttpRouteResponse::error(416, "Artifact content requires a single byte range.")
            .with_headers(vec![("Accept-Ranges".to_string(), "bytes".to_string()), ("Content-Range".to_string(), format!("bytes */{size}"))])
            .write_to(client).map(|_| Some(())).map_err(Into::into);
    };
    let (start, end) = match parse_artifact_range(range_header, size) {
        Ok(range) => range,
        Err(message) => return HttpRouteResponse::error(416, message)
            .with_headers(vec![("Accept-Ranges".to_string(), "bytes".to_string()), ("Content-Range".to_string(), format!("bytes */{size}"))])
            .write_to(client).map(|_| Some(())).map_err(Into::into),
    };
    let length = end - start + 1;
    file.seek(SeekFrom::Start(start))?;
    let mut data = vec![0_u8; length as usize];
    file.read_exact(&mut data)?;
    write!(client, "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Length: {length}\r\nContent-Range: bytes {start}-{end}/{size}\r\nAccept-Ranges: bytes\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nX-VibeLink-Control-Plane: rust\r\n\r\n")?;
    client.write_all(&data)?;
    Ok(Some(()))
}

fn parse_delimited_preview(source: &str, delimiter: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut characters = source.chars().peekable();
    while let Some(character) = characters.next() {
        if quoted {
            if character == '"' && characters.peek() == Some(&'"') {
                field.push('"');
                characters.next();
            } else if character == '"' {
                quoted = false;
            } else {
                field.push(character);
            }
            continue;
        }
        match character {
            '"' if field.is_empty() => quoted = true,
            value if value == delimiter => {
                if row.len() < 100 {
                    row.push(redact_preview_field(&field));
                }
                field.clear();
            }
            '\n' | '\r' => {
                if character == '\r' && characters.peek() == Some(&'\n') {
                    characters.next();
                }
                if row.len() < 100 {
                    row.push(redact_preview_field(&field));
                }
                if row.iter().any(|value| !value.is_empty()) && rows.len() < 201 {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
                field.clear();
            }
            value => field.push(value),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        if row.len() < 100 {
            row.push(redact_preview_field(&field));
        }
        if row.iter().any(|value| !value.is_empty()) && rows.len() < 201 {
            rows.push(row);
        }
    }
    rows
}

fn redact_preview_field(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    for marker in ["token=", "secret=", "api_key=", "password="] {
        if let Some(index) = lower.find(marker) {
            return format!("{}[REDACTED]", &value[..index + marker.len()]);
        }
    }
    value.to_string()
}

fn parse_artifact_range(value: &str, size: u64) -> Result<(u64, u64), &'static str> {
    const MAX_RANGE_BYTES: u64 = 1024 * 1024;
    let Some(spec) = value.strip_prefix("bytes=") else {
        return Err("Artifact content requires a single byte range.");
    };
    if size == 0 || spec.contains(',') {
        return Err("Artifact byte range is invalid.");
    }
    let Some((start, end)) = spec.split_once('-') else {
        return Err("Artifact byte range is invalid.");
    };
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| "Artifact byte range is invalid.")?;
        if suffix == 0 {
            return Err("Artifact byte range is invalid.");
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = start.parse::<u64>().map_err(|_| "Artifact byte range is invalid.")?;
        let end = if end.is_empty() {
            start.saturating_add(MAX_RANGE_BYTES - 1).min(size - 1)
        } else {
            end.parse::<u64>().map_err(|_| "Artifact byte range is invalid.")?
        };
        (start, end.min(size - 1))
    };
    if start >= size || end < start || end - start + 1 > MAX_RANGE_BYTES {
        return Err("Artifact byte range is unsatisfiable.");
    }
    Ok((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use std::fs;

    #[test]
    fn accepts_only_uuid_artifact_ids_with_safe_extensions() {
        assert!(artifact_path_for("a0b1c2d3-e4f5-6789-abcd-ef0123456789.csv").is_some());
        assert!(artifact_path_for("../settings.json").is_none());
    }

    #[test]
    fn bounds_a_single_artifact_byte_range() {
        assert_eq!(parse_artifact_range("bytes=2-5", 10).unwrap(), (2, 5));
        assert_eq!(parse_artifact_range("bytes=-3", 10).unwrap(), (7, 9));
        assert!(parse_artifact_range("bytes=0-1048576", 2_000_000).is_err());
        assert!(parse_artifact_range("bytes=1-2,4-5", 10).is_err());
    }

    #[test]
    fn serves_authenticated_csv_metadata_from_the_native_attachment_store() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-artifact-http-{}", uuid::Uuid::new_v4()));
        let attachments = directory.join("attachments");
        fs::create_dir_all(&attachments).unwrap();
        fs::write(
            directory.join("settings.json"),
            r#"{"pairingToken":"pair","hostAllowlist":[]}"#,
        )
        .unwrap();
        let connection = Connection::open(directory.join("mobile-agent.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE devices(id TEXT PRIMARY KEY,label TEXT,token_hash TEXT UNIQUE,created_at TEXT,last_seen_at TEXT,revoked_at TEXT,expires_at TEXT,rotated_at TEXT,meta_json TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO devices VALUES ('d','Device',?1,'now',NULL,NULL,NULL,NULL,NULL)",
                params![hash_token("token")],
            )
            .unwrap();
        let id = "a0b1c2d3-e4f5-6789-abcd-ef0123456789.csv";
        fs::write(
            attachments.join(id),
            "name,note\nAda,\"token=private-value, still private\"\n",
        )
        .unwrap();

        let request = parse_request(format!(
            "GET /api/artifacts/{id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n"
        ).as_bytes()).unwrap();
        let response = route_artifact_request(&request, &ArtifactRouteConfig::new(directory.clone()))
            .unwrap()
            .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body["artifact"]["mimeType"], "text/csv");
        assert_eq!(response.body["artifact"]["kind"], "table");
        assert_eq!(response.body["artifact"]["capabilities"]["mutation"], true);
        assert_eq!(
            response.body["artifact"]["digest"],
            "sha256:1b8be7eacc53952e8b9c643081598eaa10e0493bac9627394a3936349cd8d9b0"
        );
        let preview_request = parse_request(format!(
            "GET /api/artifacts/{id}/preview HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\n\r\n"
        ).as_bytes()).unwrap();
        let preview = route_artifact_preview_request(
            &preview_request,
            &ArtifactRouteConfig::new(directory.clone()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(preview.body["preview"]["document"]["rows"][0].as_array().unwrap().len(), 2);
        assert_eq!(preview.body["preview"]["document"]["rows"][0][1], "token=[REDACTED]");
        assert_eq!(preview.body["preview"]["redaction"]["applied"], true);
        let _ = fs::remove_dir_all(directory);
    }
}
