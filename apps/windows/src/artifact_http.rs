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
use zip::ZipArchive;
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
    let source = if mime_type.contains("openxmlformats") || mime_type == "application/pdf" {
        String::new()
    } else {
        fs::read_to_string(&path)?
    };
    if source.len() > 8 * 1024 * 1024 {
        return Ok(Some(HttpRouteResponse::error(413, "Artifact source exceeds the preview limit.")));
    }
    if mime_type == "application/x-ipynb+json" {
        let notebook: serde_json::Value = match serde_json::from_str(&source) {
            Ok(notebook) => notebook,
            Err(_) => return Ok(Some(HttpRouteResponse::error(422, "Notebook JSON is invalid."))),
        };
        let Some(cells) = notebook["cells"].as_array() else {
            return Ok(Some(HttpRouteResponse::error(422, "Notebook cells are missing.")));
        };
        let cells = cells.iter().take(200).enumerate().map(|(index, cell)| {
            let source = json_text(&cell["source"]);
            json!({
                "index": index,
                "type": cell["cell_type"].as_str().unwrap_or("raw"),
                "executionCount": cell["execution_count"],
                "source": redact_preview_field(&source),
                "outputs": []
            })
        }).collect::<Vec<_>>();
        return Ok(Some(HttpRouteResponse::json(200, json!({ "preview": {
            "version": 1, "readonly": false, "mimeType": mime_type, "kind": "notebook",
            "document": { "type": "notebook", "nbformat": notebook["nbformat"], "cells": cells },
            "truncated": { "cells": notebook["cells"].as_array().is_some_and(|source| source.len() > 200) },
            "redaction": { "applied": source.to_ascii_lowercase().contains("token="), "count": 0 },
            "limits": { "maxBytes": 8 * 1024 * 1024, "maxTextChars": 256 * 1024 }
        } }))));
    }
    if matches!(mime_type, "application/json" | "text/plain" | "text/markdown") {
        let clipped = source.chars().take(256 * 1024).collect::<String>();
        let redacted = redact_preview_field(&clipped);
        return Ok(Some(HttpRouteResponse::json(200, json!({ "preview": {
            "version": 1, "readonly": true, "mimeType": mime_type, "kind": "text",
            "document": { "type": "text", "text": redacted },
            "truncated": { "text": source.len() > 256 * 1024 },
            "redaction": { "applied": redacted.contains("[REDACTED]"), "count": usize::from(redacted.contains("[REDACTED]")) },
            "limits": { "maxBytes": 8 * 1024 * 1024, "maxTextChars": 256 * 1024 }
        } }))));
    }
    if mime_type.contains("openxmlformats") {
        let document = ooxml_preview(&path, mime_type)?;
        return Ok(Some(HttpRouteResponse::json(200, json!({ "preview": {
            "version": 1, "readonly": true, "mimeType": mime_type, "kind": kind_for(mime_type),
            "document": document, "truncated": {}, "redaction": { "applied": false, "count": 0 },
            "limits": { "maxBytes": 8 * 1024 * 1024, "archiveEntries": 2048, "archiveEntryBytes": 4 * 1024 * 1024 }
        } }))));
    }
    if mime_type == "application/pdf" {
        let bytes = fs::read(&path)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Ok(Some(HttpRouteResponse::error(413, "Artifact source exceeds the preview limit.")));
        }
        let source = String::from_utf8_lossy(&bytes);
        let page_count = source.matches("/Type /Page").count().max(1).min(200);
        return Ok(Some(HttpRouteResponse::json(200, json!({ "preview": {
            "version": 1, "readonly": true, "mimeType": mime_type, "kind": "pdf",
            "document": { "type": "pdf", "pageCount": page_count, "text": "", "extraction": "best-effort" },
            "truncated": { "pages": false, "text": false }, "redaction": { "applied": false, "count": 0 },
            "limits": { "maxBytes": 8 * 1024 * 1024, "maxTextChars": 256 * 1024 }
        } }))));
    }
    if mime_type != "text/csv" && mime_type != "text/tab-separated-values" {
        return Ok(None);
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

pub fn artifact_request_requires_body(request: &ParsedRequest) -> bool {
    request.method == "PATCH"
        && request.path().starts_with("/api/artifacts/")
        && !request.path()["/api/artifacts/".len()..].contains('/')
}

pub fn attachment_upload_requires_body(request: &ParsedRequest) -> bool {
    request.method == "POST" && request.path() == "/api/attachments"
}

pub fn route_attachment_upload_request(
    request: &ParsedRequest,
    body: &[u8],
    config: &ArtifactRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if !attachment_upload_requires_body(request) {
        return Ok(None);
    }
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => return Ok(None),
        RouteAuthentication::HostDenied => return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed."))),
        RouteAuthentication::Unauthorized => return Ok(Some(HttpRouteResponse::error(401, "Unauthorized"))),
        RouteAuthentication::Device(_) => {}
    }
    if body.is_empty() {
        return Ok(Some(HttpRouteResponse::error(400, "Empty upload.")));
    }
    let name = safe_upload_name(request.header("x-file-name").unwrap_or("attachment"));
    let mime_type = request.header("content-type").unwrap_or("application/octet-stream").split(';').next().unwrap_or("application/octet-stream");
    let extension = upload_extension(mime_type, &name);
    let id = format!("{}{}", uuid::Uuid::new_v4(), extension);
    let attachments = config.data_dir.join("attachments");
    fs::create_dir_all(&attachments)?;
    let path = attachments.join(&id);
    fs::write(&path, body)?;
    let detected_mime = mime_type_for(&path);
    let artifact = (kind_for(detected_mime) != "binary").then(|| json!({
        "metadataUrl": format!("/api/artifacts/{id}"),
        "previewUrl": format!("/api/artifacts/{id}/preview"),
        "contentUrl": format!("/api/artifacts/{id}/content")
    }));
    Ok(Some(HttpRouteResponse::json(201, json!({
        "ok": true, "id": id, "name": name, "relativePath": request.header("x-relative-path").unwrap_or(""),
        "path": path, "url": format!("/api/attachments/{id}"), "kind": "file",
        "markdown": format!("[{name}]({})", path.display()), "mimeType": detected_mime,
        "size": body.len(), "preview": "", "artifact": artifact
    }))))
}

pub fn stream_attachment_request(
    request: &ParsedRequest,
    config: &ArtifactRouteConfig,
    client: &mut TcpStream,
) -> Result<Option<()>> {
    if request.method != "GET" {
        return Ok(None);
    }
    let Some(id) = request.path().strip_prefix("/api/attachments/") else {
        return Ok(None);
    };
    let Some(relative) = artifact_path_for(id) else {
        return Ok(None);
    };
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => return Ok(None),
        RouteAuthentication::HostDenied => return HttpRouteResponse::error(403, "Host is not allowed.").write_to(client).map(|_| Some(())).map_err(Into::into),
        RouteAuthentication::Unauthorized => return HttpRouteResponse::error(401, "Unauthorized").write_to(client).map(|_| Some(())).map_err(Into::into),
        RouteAuthentication::Device(_) => {}
    }
    let path = config.data_dir.join("attachments").join(relative);
    let data = match fs::read(&path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return HttpRouteResponse::error(404, "Attachment not found.").write_to(client).map(|_| Some(())).map_err(Into::into),
        Err(error) => return Err(error.into()),
    };
    write!(client, "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Disposition: inline; filename=\"{}\"\r\nCache-Control: private, max-age=300\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nX-VibeLink-Control-Plane: rust\r\n\r\n", mime_type_for(&path), id.replace('"', ""), data.len())?;
    client.write_all(&data)?;
    Ok(Some(()))
}

pub fn route_artifact_mutation_request(
    request: &ParsedRequest,
    body: &[u8],
    config: &ArtifactRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if !artifact_request_requires_body(request) {
        return Ok(None);
    }
    let id = request.path().trim_start_matches("/api/artifacts/");
    let Some(relative_path) = artifact_path_for(id) else {
        return Ok(Some(HttpRouteResponse::error(400, "Invalid artifact.")));
    };
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => return Ok(None),
        RouteAuthentication::HostDenied => return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed."))),
        RouteAuthentication::Unauthorized => return Ok(Some(HttpRouteResponse::error(401, "Unauthorized"))),
        RouteAuthentication::Device(_) => {}
    }
    let path = config.data_dir.join("attachments").join(relative_path);
    let mime_type = mime_type_for(&path);
    if !matches!(mime_type, "text/csv" | "text/tab-separated-values" | "application/x-ipynb+json") {
        return Ok(Some(HttpRouteResponse::error(405, "Artifact type is read-only.")));
    }
    let payload: serde_json::Value = match serde_json::from_slice(body) {
        Ok(payload) => payload,
        Err(_) => return Ok(Some(HttpRouteResponse::error(400, "Invalid JSON body."))),
    };
    let current = artifact_metadata(&path, id)?;
    if payload["expectedDigest"].as_str() != current["digest"].as_str() {
        return Ok(Some(HttpRouteResponse::error(409, "Artifact changed since it was loaded.")));
    }
    if mime_type == "application/x-ipynb+json" {
        let mut notebook: serde_json::Value = match serde_json::from_str(&fs::read_to_string(&path)?) {
            Ok(notebook) => notebook,
            Err(_) => return Ok(Some(HttpRouteResponse::error(422, "Notebook JSON is invalid."))),
        };
        let Some(cells) = notebook["cells"].as_array_mut() else {
            return Ok(Some(HttpRouteResponse::error(422, "Notebook cells are missing.")));
        };
        let Some(patches) = payload["cellPatches"].as_array() else {
            return Ok(Some(HttpRouteResponse::error(422, "Notebook cell patches are invalid.")));
        };
        if patches.is_empty() || patches.len() > 1_000 {
            return Ok(Some(HttpRouteResponse::error(422, "Notebook cell patches are invalid.")));
        }
        let mut seen = std::collections::HashSet::new();
        for patch in patches {
            let Some(index) = patch["index"].as_u64().map(|value| value as usize) else {
                return Ok(Some(HttpRouteResponse::error(422, "Notebook cell patch is invalid.")));
            };
            let Some(source) = patch["source"].as_str() else {
                return Ok(Some(HttpRouteResponse::error(422, "Notebook cell patch is invalid.")));
            };
            if index >= cells.len() || !seen.insert(index) || source.len() > 1024 * 1024 {
                return Ok(Some(HttpRouteResponse::error(422, "Notebook cell patch is invalid.")));
            }
            cells[index]["source"] = json!([source]);
        }
        let output = serde_json::to_string_pretty(&notebook)? + "\n";
        replace_artifact_file(&path, output.as_bytes())?;
        return Ok(Some(HttpRouteResponse::json(200, json!({ "metadata": artifact_metadata(&path, id)? }))));
    }
    let document = &payload["document"];
    let Some(columns) = document["columns"].as_array() else {
        return Ok(Some(HttpRouteResponse::error(422, "Table document is invalid.")));
    };
    let Some(rows) = document["rows"].as_array() else {
        return Ok(Some(HttpRouteResponse::error(422, "Table document is invalid.")));
    };
    if document["type"] != "table" || columns.len() > 500 || rows.len() > 10_000 {
        return Ok(Some(HttpRouteResponse::error(413, "Table mutation exceeds the supported limits.")));
    }
    let delimiter = if mime_type_for(&path) == "text/csv" { ',' } else { '\t' };
    let mut output = String::new();
    output.push_str(&serialize_delimited_row(columns, delimiter)?);
    output.push('\n');
    for row in rows {
        let Some(row) = row.as_array() else {
            return Ok(Some(HttpRouteResponse::error(422, "Table rows must match the column count.")));
        };
        if row.len() != columns.len() {
            return Ok(Some(HttpRouteResponse::error(422, "Table rows must match the column count.")));
        }
        output.push_str(&serialize_delimited_row(row, delimiter)?);
        output.push('\n');
    }
    if output.len() > 8 * 1024 * 1024 {
        return Ok(Some(HttpRouteResponse::error(413, "Table mutation is too large.")));
    }
    replace_artifact_file(&path, output.as_bytes())?;
    let metadata = artifact_metadata(&path, id)?;
    Ok(Some(HttpRouteResponse::json(200, json!({ "metadata": metadata }))))
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

fn safe_upload_name(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or("attachment");
    let filtered = name.chars().map(|character| {
        if character.is_control() || "<>:\"/\\|?*".contains(character) { '_' } else { character }
    }).take(160).collect::<String>();
    if filtered.is_empty() { "attachment".to_string() } else { filtered }
}

fn upload_extension(mime_type: &str, name: &str) -> String {
    let known = match mime_type {
        "text/csv" => Some(".csv"),
        "text/tab-separated-values" => Some(".tsv"),
        "application/pdf" => Some(".pdf"),
        "application/x-ipynb+json" => Some(".ipynb"),
        "image/png" => Some(".png"),
        "image/jpeg" => Some(".jpg"),
        _ => None,
    };
    if let Some(extension) = known {
        return extension.to_string();
    }
    let extension = Path::new(name).extension().and_then(|value| value.to_str()).unwrap_or("");
    if !extension.is_empty() && extension.len() <= 16 && extension.chars().all(|character| character.is_ascii_alphanumeric()) {
        format!(".{}", extension.to_ascii_lowercase())
    } else {
        ".bin".to_string()
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

fn json_text(value: &serde_json::Value) -> String {
    if let Some(values) = value.as_array() {
        return values.iter().filter_map(serde_json::Value::as_str).collect::<String>();
    }
    value.as_str().unwrap_or_default().to_string()
}

fn ooxml_preview(path: &Path, mime_type: &str) -> Result<serde_json::Value> {
    let file = fs::File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    if archive.len() > 2048 {
        anyhow::bail!("Artifact archive exceeds preview limits.");
    }
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.enclosed_name().is_none() || entry.size() > 4 * 1024 * 1024 {
            anyhow::bail!("Artifact archive entry exceeds preview limits.");
        }
        let name = entry.name().replace('\\', "/");
        let selected = match mime_type {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => name == "word/document.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"),
            "application/vnd.openxmlformats-officedocument.presentationml.presentation" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
            _ => false,
        };
        if selected {
            let mut xml = String::new();
            entry.read_to_string(&mut xml)?;
            entries.push(xml_text(&xml));
        }
    }
    Ok(match mime_type {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => json!({ "type": "document", "paragraphs": entries.into_iter().take(1000).collect::<Vec<_>>() }),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => json!({ "type": "workbook", "sheets": entries.into_iter().take(24).enumerate().map(|(index, text)| json!({ "name": format!("Sheet {}", index + 1), "rows": [[text]], "truncated": false })).collect::<Vec<_>>() }),
        _ => json!({ "type": "presentation", "slides": entries.into_iter().take(200).enumerate().map(|(index, text)| json!({ "index": index + 1, "paragraphs": [text] })).collect::<Vec<_>>() }),
    })
}

fn xml_text(source: &str) -> String {
    let mut text = String::new();
    let mut inside_tag = false;
    for character in source.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => {
                inside_tag = false;
                if !text.ends_with(' ') { text.push(' '); }
            }
            value if !inside_tag => text.push(value),
            _ => {}
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn serialize_delimited_row(values: &[serde_json::Value], delimiter: char) -> Result<String> {
    let cells = values.iter().map(|value| {
        let value = value.as_str().unwrap_or_else(|| value.as_str().unwrap_or(""));
        if value.contains(delimiter) || value.contains('"') || value.contains('\r') || value.contains('\n') {
            format!("\"{}\"", value.replace('"', "\"\""))
        } else {
            value.to_string()
        }
    }).collect::<Vec<_>>();
    Ok(cells.join(&delimiter.to_string()))
}

fn replace_artifact_file(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, content)?;
    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(error)
        }
    }
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
        let mutation_body = json!({
            "expectedDigest": response.body["artifact"]["digest"],
            "document": { "type": "table", "columns": ["name", "note"], "rows": [["Ada", "edited,value"]] }
        });
        let mutation_request = parse_request(format!(
            "PATCH /api/artifacts/{id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 1\r\n\r\n"
        ).as_bytes()).unwrap();
        let mutation = route_artifact_mutation_request(
            &mutation_request,
            mutation_body.to_string().as_bytes(),
            &ArtifactRouteConfig::new(directory.clone()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(mutation.status, 200);
        assert_ne!(mutation.body["metadata"]["digest"], response.body["artifact"]["digest"]);
        assert_eq!(fs::read_to_string(attachments.join(id)).unwrap(), "name,note\nAda,\"edited,value\"\n");

        let notebook_id = "b0b1c2d3-e4f5-6789-abcd-ef0123456789.ipynb";
        fs::write(
            attachments.join(notebook_id),
            r#"{"nbformat":4,"cells":[{"cell_type":"code","source":["token=private"],"outputs":[]}]}"#,
        )
        .unwrap();
        let notebook_metadata = artifact_metadata(&attachments.join(notebook_id), notebook_id).unwrap();
        let notebook_request = parse_request(format!(
            "PATCH /api/artifacts/{notebook_id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: 1\r\n\r\n"
        ).as_bytes()).unwrap();
        let notebook_mutation = json!({
            "expectedDigest": notebook_metadata["digest"],
            "cellPatches": [{ "index": 0, "source": "print('edited')" }]
        });
        let notebook_response = route_artifact_mutation_request(
            &notebook_request,
            notebook_mutation.to_string().as_bytes(),
            &ArtifactRouteConfig::new(directory.clone()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(notebook_response.status, 200);
        let saved: serde_json::Value = serde_json::from_str(&fs::read_to_string(attachments.join(notebook_id)).unwrap()).unwrap();
        assert_eq!(saved["cells"][0]["source"][0], "print('edited')");

        let upload_request = parse_request(
            b"POST /api/attachments HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Type: text/csv\r\nX-File-Name: uploaded.csv\r\nContent-Length: 4\r\n\r\n",
        )
        .unwrap();
        let upload = route_attachment_upload_request(
            &upload_request,
            b"a,b\n",
            &ArtifactRouteConfig::new(directory.clone()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(upload.status, 201);
        assert_eq!(upload.body["mimeType"], "text/csv");
        assert!(attachments.join(upload.body["id"].as_str().unwrap()).is_file());
        let _ = fs::remove_dir_all(directory);
    }
}
