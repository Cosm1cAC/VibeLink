use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
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
        fs::write(attachments.join(id), "name,note\nAda,hello\n").unwrap();

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
            "sha256:5c937efbaeb5ec886b1bf4164d1cdb477e65dba9678d82bb15bb78fcf0bcd78e"
        );
        let _ = fs::remove_dir_all(directory);
    }
}
