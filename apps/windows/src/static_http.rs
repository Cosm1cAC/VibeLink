use crate::status_http::ParsedRequest;
use anyhow::{bail, Context, Result};
use std::fs;
use std::io::Write;
use std::net::TcpStream;
use std::path::{Component, Path, PathBuf};

#[derive(Clone)]
pub struct StaticRouteConfig {
    root: PathBuf,
}

impl StaticRouteConfig {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
}

pub fn stream_static_request(
    request: &ParsedRequest,
    config: &StaticRouteConfig,
    client: &mut TcpStream,
) -> Result<Option<()>> {
    if request.method != "GET" && request.method != "HEAD" {
        return Ok(None);
    }
    let Some((path, content_type, cache_control)) = resolve_static_path(request.path(), config)? else {
        return Ok(None);
    };
    let bytes = fs::read(&path).with_context(|| format!("Cannot read {}", path.display()))?;
    write!(
        client,
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nCache-Control: {cache_control}\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nX-VibeLink-Control-Plane: rust\r\n\r\n",
        bytes.len()
    )?;
    if request.method != "HEAD" {
        client.write_all(&bytes)?;
    }
    Ok(Some(()))
}

fn resolve_static_path(
    request_path: &str,
    config: &StaticRouteConfig,
) -> Result<Option<(PathBuf, &'static str, &'static str)>> {
    if request_path == "/api/openapi.json" {
        let path = config.root.join("docs").join("openapi.json");
        return path
            .is_file()
            .then(|| (path, "application/json; charset=utf-8", "no-store"))
            .map(Ok)
            .transpose();
    }
    let relative = match request_path {
        "/" | "/index.html" => PathBuf::from("index.html"),
        path if path.starts_with("/assets/") || path.starts_with("/icons/") => PathBuf::from(&path[1..]),
        "/app.js" | "/styles.css" | "/manifest.webmanifest" | "/sw.js" => {
            PathBuf::from(&request_path[1..])
        }
        _ => return Ok(None),
    };
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        bail!("Static asset path is outside the public root.");
    }
    let path = config.root.join("public").join(relative);
    if !path.is_file() {
        return Ok(None);
    }
    let content_type = content_type(&path);
    let cache_control = if request_path.starts_with("/assets/") || request_path.starts_with("/icons/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Ok(Some((path, content_type, cache_control)))
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_http::parse_request;

    #[test]
    fn resolves_openapi_and_public_assets_without_traversal() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
        let config = StaticRouteConfig::new(root);
        let openapi = parse_request(b"GET /api/openapi.json HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let (_, type_, cache) = resolve_static_path(openapi.path(), &config).unwrap().unwrap();
        assert_eq!(type_, "application/json; charset=utf-8");
        assert_eq!(cache, "no-store");
        let asset = parse_request(b"GET /styles.css HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        assert!(resolve_static_path(asset.path(), &config).unwrap().is_some());
        assert!(resolve_static_path("/assets/../../settings.json", &config).is_err());
    }
}
