use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[allow(dead_code, reason = "consumed by the runtime route registry extractor")]
pub const REVIEW_RUNTIME_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/reviews"),
    ("POST", "/api/reviews"),
    ("GET", "/api/reviews/:id"),
    ("PATCH", "/api/reviews/:id"),
    ("POST", "/api/reviews/:id/comments"),
    ("PATCH", "/api/reviews/:id/comments/:commentId"),
    ("POST", "/api/reviews/:id/sync"),
    ("POST", "/api/reviews/:id/submit"),
];

#[derive(Clone)]
pub struct ReviewRouteConfig {
    data_dir: PathBuf,
}

impl ReviewRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }
}

pub fn review_request_requires_body(request: &ParsedRequest) -> bool {
    let path = request.path();
    path.starts_with("/api/reviews") && matches!(request.method.as_str(), "POST" | "PATCH")
}

pub fn route_review_request(
    request: &ParsedRequest,
    config: &ReviewRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if !request.path().starts_with("/api/reviews") || review_request_requires_body(request) {
        return Ok(None);
    }
    if let Some(response) = authenticate(request, config)? {
        return Ok(Some(response));
    }
    let segments = review_segments(request.path());
    match (request.method.as_str(), segments.as_slice()) {
        ("GET", []) => {
            let mut items = load_reviews(&config.data_dir)?;
            items.sort_by(|left, right| {
                string_at(right, "updatedAt").cmp(&string_at(left, "updatedAt"))
            });
            Ok(Some(HttpRouteResponse::json(
                200,
                json!({ "items": items }),
            )))
        }
        ("GET", [id]) => Ok(Some(match find_review(&config.data_dir, id)? {
            Some(review) => HttpRouteResponse::json(200, review),
            None => HttpRouteResponse::error(404, "Review not found"),
        })),
        _ => Ok(None),
    }
}

pub fn route_review_request_with_body(
    request: &ParsedRequest,
    body: &[u8],
    config: &ReviewRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if !review_request_requires_body(request) {
        return Ok(None);
    }
    if let Some(response) = authenticate(request, config)? {
        return Ok(Some(response));
    }
    let payload: Value = match serde_json::from_slice(body) {
        Ok(Value::Object(value)) => Value::Object(value),
        _ => return Ok(Some(HttpRouteResponse::error(400, "Invalid JSON body."))),
    };
    let segments = review_segments(request.path());
    let response = match (request.method.as_str(), segments.as_slice()) {
        ("POST", []) => create_review(&config.data_dir, &payload)?,
        ("PATCH", [id]) => update_review(&config.data_dir, id, &payload)?,
        ("POST", [id, "comments"]) => add_comment(&config.data_dir, id, &payload)?,
        ("PATCH", [id, "comments", comment_id]) => {
            update_comment(&config.data_dir, id, comment_id, &payload)?
        }
        ("POST", [id, "sync"]) => sync_review(&config.data_dir, id, &payload)?,
        ("POST", [id, "submit"]) => submit_review(&config.data_dir, id, &payload)?,
        _ => return Ok(None),
    };
    Ok(Some(response))
}

fn authenticate(
    request: &ParsedRequest,
    config: &ReviewRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    Ok(
        match authenticate_route_request(request, &config.data_dir)? {
            RouteAuthentication::Pending => return Ok(None),
            RouteAuthentication::HostDenied => {
                Some(HttpRouteResponse::error(403, "Host is not allowed."))
            }
            RouteAuthentication::Unauthorized => {
                Some(HttpRouteResponse::error(401, "Unauthorized"))
            }
            RouteAuthentication::Device(_) => None,
        },
    )
}

fn review_segments(path: &str) -> Vec<&str> {
    path.trim_start_matches("/api/reviews")
        .trim_matches('/')
        .split('/')
        .filter(|value| !value.is_empty())
        .collect()
}

fn reviews_path(data_dir: &Path) -> PathBuf {
    data_dir.join("reviews.json")
}

fn load_reviews(data_dir: &Path) -> Result<Vec<Value>> {
    let path = reviews_path(data_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let parsed: Value = serde_json::from_slice(&fs::read(&path)?)
        .with_context(|| format!("Cannot parse {}", path.display()))?;
    Ok(parsed.as_array().cloned().unwrap_or_default())
}

fn save_reviews(data_dir: &Path, items: &[Value]) -> Result<()> {
    fs::create_dir_all(data_dir)?;
    let path = reviews_path(data_dir);
    let temporary = data_dir.join(format!("reviews-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, serde_json::to_vec_pretty(items)?)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

fn now_iso() -> String {
    let now: DateTime<Utc> = SystemTime::now().into();
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn clean_text(value: &Value, max: usize) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(max)
        .collect()
}

fn string_at(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn find_review(data_dir: &Path, id: &str) -> Result<Option<Value>> {
    Ok(load_reviews(data_dir)?
        .into_iter()
        .find(|item| item["id"] == id))
}

fn create_review(data_dir: &Path, payload: &Value) -> Result<HttpRouteResponse> {
    let now = now_iso();
    let source = match payload["source"].as_str() {
        Some("github") => "github",
        Some("gitlab") => "gitlab",
        _ => "local",
    };
    let title = clean_text(&payload["title"], 200);
    let mut review = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "workspaceId": payload["workspaceId"].as_str().unwrap_or_default(),
        "branch": payload["branch"].as_str().unwrap_or_default(),
        "title": if title.is_empty() { "PR Review" } else { title.as_str() },
        "status": "open",
        "source": source,
        "files": payload["files"].as_array().cloned().unwrap_or_default(),
        "diff": payload["diff"].as_str().unwrap_or_default(),
        "threads": payload["threads"].as_array().cloned().unwrap_or_default(),
        "comments": [],
        "createdAt": now,
        "updatedAt": now,
    });
    if !payload["remote"].is_null() {
        review["remote"] = payload["remote"].clone();
    }
    let mut items = load_reviews(data_dir)?;
    items.push(review.clone());
    save_reviews(data_dir, &items)?;
    Ok(HttpRouteResponse::json(201, review))
}

fn update_review(data_dir: &Path, id: &str, patch: &Value) -> Result<HttpRouteResponse> {
    let mut items = load_reviews(data_dir)?;
    let Some(index) = items.iter().position(|item| item["id"] == id) else {
        return Ok(HttpRouteResponse::error(404, "Review not found"));
    };
    let created_at = items[index]["createdAt"].clone();
    let comments = items[index]["comments"].clone();
    if let (Some(current), Some(patch)) = (items[index].as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            if !matches!(key.as_str(), "id" | "createdAt") {
                current.insert(key.clone(), value.clone());
            }
        }
        current.insert("id".to_string(), json!(id));
        current.insert("createdAt".to_string(), created_at);
        current.insert("updatedAt".to_string(), json!(now_iso()));
        let valid = matches!(
            current.get("status").and_then(Value::as_str),
            Some("open" | "resolved" | "submitted")
        );
        if !valid {
            current.insert("status".to_string(), json!("open"));
        }
        if !current.get("comments").is_some_and(Value::is_array) {
            current.insert("comments".to_string(), comments);
        }
    }
    let review = items[index].clone();
    save_reviews(data_dir, &items)?;
    Ok(HttpRouteResponse::json(200, review))
}

fn normalized_comment(payload: &Value, previous: Option<&Value>) -> Value {
    let now = now_iso();
    let get = |key: &str| {
        payload
            .get(key)
            .filter(|value| !value.is_null())
            .or_else(|| previous.and_then(|value| value.get(key)))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let mut comment = Map::new();
    comment.insert(
        "id".to_string(),
        previous.and_then(|value| value["id"].as_str()).map_or_else(
            || json!(uuid::Uuid::new_v4().to_string()),
            |value| json!(value),
        ),
    );
    comment.insert("file".to_string(), json!(clean_text(&get("file"), 1000)));
    comment.insert("line".to_string(), get("line"));
    comment.insert("startLine".to_string(), get("startLine"));
    comment.insert(
        "side".to_string(),
        json!(clean_text(&get("side"), 20).to_uppercase()),
    );
    comment.insert("body".to_string(), json!(clean_text(&get("body"), 4000)));
    comment.insert(
        "severity".to_string(),
        json!(clean_text(&get("severity"), 40)),
    );
    let status = clean_text(&get("status"), 40).to_lowercase();
    comment.insert(
        "status".to_string(),
        json!(if status.is_empty() {
            "open"
        } else {
            status.as_str()
        }),
    );
    comment.insert(
        "createdAt".to_string(),
        previous
            .map(|value| value["createdAt"].clone())
            .unwrap_or_else(|| json!(now)),
    );
    comment.insert("updatedAt".to_string(), json!(now));
    Value::Object(comment)
}

fn add_comment(data_dir: &Path, id: &str, payload: &Value) -> Result<HttpRouteResponse> {
    let Some(mut review) = find_review(data_dir, id)? else {
        return Ok(HttpRouteResponse::error(404, "Review not found"));
    };
    let comment = normalized_comment(payload, None);
    if clean_text(&comment["file"], 1000).is_empty()
        || comment["line"].as_i64().unwrap_or(0) < 1
        || clean_text(&comment["body"], 4000).is_empty()
    {
        return Ok(HttpRouteResponse::error(
            400,
            "Review comments require file, line, and body.",
        ));
    }
    review["comments"]
        .as_array_mut()
        .expect("review comments array")
        .push(comment);
    update_review(data_dir, id, &json!({ "comments": review["comments"] })).map(|mut response| {
        response.status = 201;
        response
    })
}

fn update_comment(
    data_dir: &Path,
    id: &str,
    comment_id: &str,
    payload: &Value,
) -> Result<HttpRouteResponse> {
    let Some(mut review) = find_review(data_dir, id)? else {
        return Ok(HttpRouteResponse::error(404, "Review not found"));
    };
    let comments = review["comments"]
        .as_array_mut()
        .expect("review comments array");
    let Some(index) = comments.iter().position(|item| item["id"] == comment_id) else {
        return Ok(HttpRouteResponse::error(404, "Review comment not found."));
    };
    comments[index] = normalized_comment(payload, Some(&comments[index]));
    update_review(data_dir, id, &json!({ "comments": comments }))
}

fn sync_review(data_dir: &Path, id: &str, payload: &Value) -> Result<HttpRouteResponse> {
    let mut patch = Map::new();
    patch.insert("status".to_string(), json!("open"));
    patch.insert("source".to_string(), json!("remote"));
    patch.insert("remote".to_string(), payload.clone());
    update_review(data_dir, id, &Value::Object(patch))
}

fn submit_review(data_dir: &Path, id: &str, payload: &Value) -> Result<HttpRouteResponse> {
    let mut patch = Map::new();
    patch.insert("status".to_string(), json!("submitted"));
    patch.insert(
        "submittedDecision".to_string(),
        json!(payload["decision"].as_str().unwrap_or("comment")),
    );
    patch.insert("submittedAt".to_string(), json!(now_iso()));
    update_review(data_dir, id, &Value::Object(patch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_http::parse_request;
    use serde_json::json;
    use std::fs;

    #[test]
    fn creates_lists_updates_and_comments_on_reviews_in_rust() {
        let data_dir =
            std::env::temp_dir().join(format!("vibelink-review-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"pairingToken":"token","hostAllowlist":[]}"#,
        )
        .unwrap();
        let config = ReviewRouteConfig::new(data_dir.clone());

        let create = parse_request(b"POST /api/reviews HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let created = route_review_request_with_body(
            &create,
            br#"{"workspaceId":"w1","branch":"feature/review","title":"Review"}"#,
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(created.status, 201);
        let id = created.body["id"].as_str().unwrap();

        let comment = parse_request(format!("POST /api/reviews/{id}/comments HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer token\r\n\r\n").as_bytes()).unwrap();
        let commented = route_review_request_with_body(
            &comment,
            br#"{"file":"src/main.rs","line":10,"body":"Add coverage","severity":"high"}"#,
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(commented.status, 201);
        assert_eq!(commented.body["comments"][0]["severity"], "high");

        let update = parse_request(format!("PATCH /api/reviews/{id} HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer token\r\n\r\n").as_bytes()).unwrap();
        let body = json!({"status":"resolved"}).to_string();
        let updated = route_review_request_with_body(&update, body.as_bytes(), &config)
            .unwrap()
            .unwrap();
        assert_eq!(updated.body["status"], "resolved");

        let list = parse_request(b"GET /api/reviews HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer token\r\n\r\n").unwrap();
        let listed = route_review_request(&list, &config).unwrap().unwrap();
        assert_eq!(listed.body["items"].as_array().unwrap().len(), 1);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn review_runtime_registry_covers_the_openapi_family() {
        assert!(REVIEW_RUNTIME_ROUTES.contains(&("GET", "/api/reviews")));
        assert!(REVIEW_RUNTIME_ROUTES.contains(&("POST", "/api/reviews/:id/comments")));
        assert!(REVIEW_RUNTIME_ROUTES.contains(&("PATCH", "/api/reviews/:id/comments/:commentId")));
        assert!(REVIEW_RUNTIME_ROUTES.contains(&("POST", "/api/reviews/:id/sync")));
        assert!(REVIEW_RUNTIME_ROUTES.contains(&("POST", "/api/reviews/:id/submit")));
    }
}
