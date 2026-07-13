use crate::device_http::apply_fields;
use crate::status_http::{
    authenticate_route_request, prepare_route_request, read_internal_json, HttpRouteResponse,
    ParsedRequest, RouteAuthentication, RouteMetrics, RoutePreparation,
};
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use qrcode::{render::svg, QrCode};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STATUS_LIMIT: u32 = 60;
const STATUS_WINDOW: Duration = Duration::from_secs(60);
const CREATE_LIMIT: u32 = 6;
const CREATE_WINDOW: Duration = Duration::from_secs(10 * 60);
const CLAIM_LIMIT: u32 = 12;
const CLAIM_WINDOW: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone)]
pub struct PairingRouteConfig {
    data_dir: PathBuf,
    rate_limits: Arc<Mutex<HashMap<String, RateBucket>>>,
    decision_lock: Arc<Mutex<()>>,
    internal_settings: Option<InternalSettingsConfig>,
    metrics: Arc<RouteMetrics>,
}

#[derive(Debug, Clone)]
struct InternalSettingsConfig {
    upstream: SocketAddr,
    token: String,
}

#[derive(Debug, Clone, Copy)]
struct RateBucket {
    count: u32,
    reset_at: SystemTime,
}

#[derive(Debug)]
struct RateLimitResult {
    ok: bool,
    count: u32,
    limit: u32,
    reset_at: SystemTime,
    retry_after_ms: u64,
}

#[derive(Debug)]
enum PairingRequest {
    Create,
    Claim(String),
    PublicStatus(String),
    AdminList,
    Approve(String),
    Deny(String),
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingBody {
    #[serde(default)]
    device_label: String,
    #[serde(default)]
    trust_local_launcher: bool,
    #[serde(default)]
    code: String,
}

#[derive(Debug)]
struct PairingRow {
    id: String,
    code_hash: String,
    label: String,
    ip: String,
    user_agent: String,
    status: String,
    created_at: String,
    expires_at: String,
    approved_at: String,
    approved_by_device_id: String,
    claimed_at: String,
    device_id: String,
}

impl PairingRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            decision_lock: Arc::new(Mutex::new(())),
            internal_settings: None,
            metrics: Arc::new(RouteMetrics::default()),
        }
    }

    pub fn with_internal_settings(mut self, upstream: SocketAddr, token: String) -> Self {
        self.internal_settings = Some(InternalSettingsConfig { upstream, token });
        self
    }

    pub(crate) fn record_fallback(&self) {
        self.metrics.record_fallback();
    }
}

pub fn route_pairing_request(
    request: &ParsedRequest,
    peer_ip: &str,
    config: &PairingRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    route_pairing_request_with_body(request, peer_ip, None, config)
}

pub fn route_pairing_request_with_body(
    request: &ParsedRequest,
    peer_ip: &str,
    body: Option<&[u8]>,
    config: &PairingRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    let Some(route) = match_pairing_request(request) else {
        return Ok(None);
    };
    let request_ip = request
        .header("x-forwarded-for")
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(peer_ip);
    match &route {
        PairingRequest::Create => {
            let Some(body) = body else {
                return Ok(None);
            };
            return route_create_pairing(request, request_ip, body, config);
        }
        PairingRequest::Claim(session_id) => {
            let Some(body) = body else {
                return Ok(None);
            };
            return route_claim_pairing(request, request_ip, body, config, session_id);
        }
        PairingRequest::PublicStatus(session_id) => {
            return route_public_status(request, request_ip, config, session_id);
        }
        PairingRequest::AdminList | PairingRequest::Approve(_) | PairingRequest::Deny(_) => {}
    }

    let _decision_guard = matches!(route, PairingRequest::Approve(_) | PairingRequest::Deny(_))
        .then(|| {
            config
                .decision_lock
                .lock()
                .map_err(|_| anyhow::anyhow!("Pairing decision serializer is unavailable"))
        })
        .transpose()?;
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
            let reason = if request.token().is_empty() {
                "missing_token"
            } else {
                "invalid_or_expired_token"
            };
            let response = audit_only(
                &config.data_dir,
                request,
                request_ip,
                "",
                "auth.failed",
                false,
                reason,
                "",
                &json!({}),
            )
            .map(|()| HttpRouteResponse::error(401, "Unauthorized"));
            return Ok(Some(claimed_result(config, response)));
        }
        RouteAuthentication::Device(device_id) => device_id,
        RouteAuthentication::Pending => unreachable!(),
    };

    match route {
        PairingRequest::AdminList => {
            let status = request
                .query_parameter("status")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "pending".to_string());
            let fields = request.query_parameter("fields");
            let items = list_pairing_sessions(&config.data_dir, &status)?
                .into_iter()
                .map(|session| apply_fields(session, fields.as_deref()))
                .collect::<Vec<_>>();
            config.metrics.record_response();
            Ok(Some(HttpRouteResponse::json(
                200,
                json!({ "items": items }),
            )))
        }
        PairingRequest::Approve(session_id) => Ok(Some(claimed_result(
            config,
            decide_pairing(
                &config.data_dir,
                request,
                request_ip,
                &device_id,
                &session_id,
                true,
            ),
        ))),
        PairingRequest::Deny(session_id) => Ok(Some(claimed_result(
            config,
            decide_pairing(
                &config.data_dir,
                request,
                request_ip,
                &device_id,
                &session_id,
                false,
            ),
        ))),
        PairingRequest::Create | PairingRequest::Claim(_) | PairingRequest::PublicStatus(_) => {
            unreachable!()
        }
    }
}

pub fn pairing_request_requires_body(request: &ParsedRequest) -> bool {
    matches!(
        match_pairing_request(request),
        Some(PairingRequest::Create | PairingRequest::Claim(_))
    )
}

fn route_create_pairing(
    request: &ParsedRequest,
    request_ip: &str,
    body: &[u8],
    config: &PairingRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    match prepare_route_request(request, &config.data_dir)? {
        RoutePreparation::Pending => return Ok(None),
        RoutePreparation::HostDenied => {
            config.metrics.record_attempt();
            config.metrics.record_host_denied();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")));
        }
        RoutePreparation::Ready(_) => {}
    }
    let _guard = config
        .decision_lock
        .lock()
        .map_err(|_| anyhow::anyhow!("Pairing mutation serializer is unavailable"))?;
    config.metrics.record_attempt();
    let rate_limit = check_rate_limit(
        config,
        &format!("pairing.create:{request_ip}:"),
        CREATE_LIMIT,
        CREATE_WINDOW,
    )?;
    let headers = rate_limit_headers(&rate_limit);
    if !rate_limit.ok {
        let response = audit_rate_limit(
            &config.data_dir,
            request,
            request_ip,
            "pairing.create",
            &rate_limit,
        )
        .map(|()| {
            HttpRouteResponse::json(
                429,
                json!({
                    "error": "Rate limit exceeded.",
                    "retryAfterMs": rate_limit.retry_after_ms
                }),
            )
        });
        return Ok(Some(claimed_result(config, response).with_headers(headers)));
    }
    let body = parse_pairing_body(body);
    let response = create_pairing_session(&config.data_dir, request, request_ip, &body);
    Ok(Some(claimed_result(config, response).with_headers(headers)))
}

fn route_claim_pairing(
    request: &ParsedRequest,
    request_ip: &str,
    body: &[u8],
    config: &PairingRouteConfig,
    session_id: &str,
) -> Result<Option<HttpRouteResponse>> {
    let Some(internal_settings) = config.internal_settings.as_ref() else {
        return Ok(None);
    };
    match prepare_route_request(request, &config.data_dir)? {
        RoutePreparation::Pending => return Ok(None),
        RoutePreparation::HostDenied => {
            config.metrics.record_attempt();
            config.metrics.record_host_denied();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")));
        }
        RoutePreparation::Ready(_) => {}
    }
    let _guard = config
        .decision_lock
        .lock()
        .map_err(|_| anyhow::anyhow!("Pairing mutation serializer is unavailable"))?;
    config.metrics.record_attempt();
    let rate_limit = check_rate_limit(
        config,
        &format!("pairing.claim:{request_ip}:{session_id}"),
        CLAIM_LIMIT,
        CLAIM_WINDOW,
    )?;
    let headers = rate_limit_headers(&rate_limit);
    if !rate_limit.ok {
        let response = audit_rate_limit(
            &config.data_dir,
            request,
            request_ip,
            "pairing.claim",
            &rate_limit,
        )
        .map(|()| {
            HttpRouteResponse::json(
                429,
                json!({
                    "error": "Rate limit exceeded.",
                    "retryAfterMs": rate_limit.retry_after_ms
                }),
            )
        });
        return Ok(Some(claimed_result(config, response).with_headers(headers)));
    }
    let body = parse_pairing_body(body);
    let code = if body.code.is_empty() {
        request.query_parameter("code").unwrap_or_default()
    } else {
        body.code.clone()
    };
    let initial = {
        let connection = open_database(&config.data_dir, true)?;
        read_pairing(&connection, session_id)?
    };
    if let Some((status, message)) = claim_validation_error(initial.as_ref(), session_id, &code) {
        let response = audit_only(
            &config.data_dir,
            request,
            request_ip,
            "",
            "pairing.claim",
            false,
            &message,
            session_id,
            &json!({}),
        )
        .map(|()| HttpRouteResponse::error(status, &message));
        return Ok(Some(claimed_result(config, response).with_headers(headers)));
    }
    let public_settings = fetch_public_settings(internal_settings)?;
    let label = if !body.device_label.is_empty() {
        body.device_label
    } else {
        request
            .header("user-agent")
            .filter(|value| !value.is_empty())
            .unwrap_or("Browser")
            .to_string()
    };
    let response = claim_pairing_session(
        &config.data_dir,
        request,
        request_ip,
        session_id,
        &code,
        &label,
        public_settings,
    );
    Ok(Some(claimed_result(config, response).with_headers(headers)))
}

fn parse_pairing_body(body: &[u8]) -> PairingBody {
    if body.is_empty() {
        return PairingBody::default();
    }
    serde_json::from_slice::<Value>(body)
        .ok()
        .filter(Value::is_object)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn create_pairing_session(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    body: &PairingBody,
) -> Result<HttpRouteResponse> {
    let id = random_uuid()?;
    let code = random_hex(3)?.to_ascii_uppercase();
    let current_time: DateTime<Utc> = SystemTime::now().into();
    let current = current_time.to_rfc3339_opts(SecondsFormat::Millis, true);
    let expires_at =
        (current_time + chrono::Duration::minutes(5)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let user_agent = clean_string(request.header("user-agent").unwrap_or(""), 500);
    let label = clean_string(
        if !body.device_label.is_empty() {
            &body.device_label
        } else if !user_agent.is_empty() {
            &user_agent
        } else {
            "New device"
        },
        160,
    );
    let local_launcher_trusted = body.trust_local_launcher && is_loopback_ip(request_ip);
    let host = crate::status_http::clean_host(request.host());
    let pairing_url = pairing_url(request, &id, &code);
    let qr_code = QrCode::new(pairing_url.as_bytes()).context("Cannot encode pairing QR")?;
    let qr_svg = qr_code
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .build();
    let code_hash = crate::status_http::hash_token(&format!("{id}:{}", code.trim()));
    let mut connection = open_database(data_dir, false)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin pairing creation transaction")?;
    transaction
        .execute(
            "INSERT INTO pairing_sessions (
                id, code_hash, label, ip, user_agent, status, created_at, expires_at,
                approved_at, approved_by_device_id, claimed_at, device_id, meta_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, ?11)",
            params![
                id,
                code_hash,
                label,
                clean_string(request_ip, 120),
                user_agent,
                if local_launcher_trusted {
                    "approved"
                } else {
                    "pending"
                },
                current,
                expires_at,
                if local_launcher_trusted {
                    current.as_str()
                } else {
                    ""
                },
                if local_launcher_trusted {
                    "local-windows-launcher"
                } else {
                    ""
                },
                json!({ "host": host }).to_string()
            ],
        )
        .context("Cannot create pairing session")?;
    record_audit(
        &transaction,
        request,
        request_ip,
        "",
        "pairing.create",
        true,
        "",
        &id,
        &json!({ "label": label, "localLauncherTrusted": local_launcher_trusted }),
    )?;
    let row = read_pairing(&transaction, &id)?.context("Created pairing session disappeared")?;
    transaction
        .commit()
        .context("Cannot commit pairing creation transaction")?;
    let mut session = public_pairing_session(row);
    session
        .as_object_mut()
        .context("Pairing session must be an object")?
        .insert("code".to_string(), Value::String(code));
    Ok(HttpRouteResponse::json(
        201,
        json!({
            "ok": true,
            "session": session,
            "pairingUrl": pairing_url,
            "qrSvg": qr_svg
        }),
    ))
}

#[allow(clippy::too_many_arguments)]
fn claim_pairing_session(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    session_id: &str,
    code: &str,
    label: &str,
    public_settings: Value,
) -> Result<HttpRouteResponse> {
    let mut connection = open_database(data_dir, false)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin pairing claim transaction")?;
    let row = read_pairing(&transaction, session_id)?;
    if let Some((status, message)) = claim_validation_error(row.as_ref(), session_id, code) {
        record_audit(
            &transaction,
            request,
            request_ip,
            "",
            "pairing.claim",
            false,
            &message,
            session_id,
            &json!({}),
        )?;
        transaction
            .commit()
            .context("Cannot commit rejected pairing claim audit")?;
        return Ok(HttpRouteResponse::error(status, &message));
    }
    let row = row.expect("validated pairing row");
    let device_id = random_uuid()?;
    let token = random_hex(32)?;
    let current_time: DateTime<Utc> = SystemTime::now().into();
    let current = current_time.to_rfc3339_opts(SecondsFormat::Millis, true);
    let expires_at =
        (current_time + chrono::Duration::days(90)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let label = clean_string(
        if label.is_empty() {
            if row.label.is_empty() {
                "Browser"
            } else {
                &row.label
            }
        } else {
            label
        },
        120,
    );
    let meta = json!({
        "claimedIp": clean_string(request_ip, 120),
        "userAgent": clean_string(request.header("user-agent").unwrap_or(""), 500),
        "pairingSessionId": session_id,
        "pairedIp": row.ip,
        "approvedByDeviceId": row.approved_by_device_id
    });
    transaction
        .execute(
            "INSERT INTO devices (
                id, label, token_hash, created_at, last_seen_at, revoked_at,
                expires_at, rotated_at, meta_json
             ) VALUES (?1, ?2, ?3, ?4, ?4, NULL, ?5, NULL, ?6)",
            params![
                device_id,
                label,
                crate::status_http::hash_token(&token),
                current,
                expires_at,
                meta.to_string()
            ],
        )
        .context("Cannot create paired device")?;
    transaction
        .execute(
            "UPDATE pairing_sessions
             SET status = 'claimed', claimed_at = ?1, device_id = ?2 WHERE id = ?3",
            params![current, device_id, session_id],
        )
        .context("Cannot mark pairing session claimed")?;
    record_audit(
        &transaction,
        request,
        request_ip,
        &device_id,
        "pairing.claim",
        true,
        "",
        session_id,
        &json!({}),
    )?;
    let session = read_pairing(&transaction, session_id)?
        .map(public_pairing_session)
        .context("Claimed pairing session disappeared")?;
    transaction
        .commit()
        .context("Cannot commit pairing claim transaction")?;
    Ok(HttpRouteResponse::json(
        200,
        json!({
            "ok": true,
            "token": token,
            "device": { "id": device_id, "label": label },
            "session": session,
            "settings": public_settings
        }),
    ))
}

fn claim_validation_error(
    row: Option<&PairingRow>,
    session_id: &str,
    code: &str,
) -> Option<(u16, String)> {
    let Some(row) = row else {
        return Some((404, "Pairing session not found.".to_string()));
    };
    let now: DateTime<Utc> = SystemTime::now().into();
    if DateTime::parse_from_rfc3339(&row.expires_at)
        .map(|value| value.with_timezone(&Utc) <= now)
        .unwrap_or(false)
    {
        return Some((410, "Pairing session expired.".to_string()));
    }
    if row.status != "approved" {
        let message = if row.status == "pending" {
            "Pairing session is waiting for confirmation.".to_string()
        } else {
            format!("Pairing session is {}.", row.status)
        };
        return Some((409, message));
    }
    let supplied_hash = crate::status_http::hash_token(&format!(
        "{session_id}:{}",
        code.trim().to_ascii_uppercase()
    ));
    if supplied_hash != row.code_hash {
        return Some((401, "Pairing code mismatch.".to_string()));
    }
    None
}

fn fetch_public_settings(config: &InternalSettingsConfig) -> Result<Value> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(5))
        .timeout_write(Duration::from_secs(2))
        .build();
    let response = agent
        .get(&format!(
            "http://{}/internal/public-settings",
            config.upstream
        ))
        .set("X-VibeLink-Internal-Token", &config.token)
        .call()
        .context("Internal public settings request failed")?;
    read_internal_json(response, "public settings")
}

fn pairing_url(request: &ParsedRequest, id: &str, code: &str) -> String {
    let host = if request.host().is_empty() {
        "localhost"
    } else {
        request.host()
    };
    let protocol = request.header("x-forwarded-proto").unwrap_or_else(|| {
        if crate::status_http::clean_host(host).ends_with(".trycloudflare.com") {
            "https"
        } else {
            "http"
        }
    });
    format!("{protocol}://{host}/?pair={id}&code={code}")
}

fn is_loopback_ip(value: &str) -> bool {
    matches!(
        value.strip_prefix("::ffff:").unwrap_or(value),
        "127.0.0.1" | "::1" | "localhost"
    )
}

fn random_hex(bytes: usize) -> Result<String> {
    let mut value = vec![0_u8; bytes];
    getrandom::getrandom(&mut value)
        .map_err(|error| anyhow::anyhow!("Cannot generate pairing secret: {error}"))?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn random_uuid() -> Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| anyhow::anyhow!("Cannot generate pairing identifier: {error}"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
}

fn route_public_status(
    request: &ParsedRequest,
    request_ip: &str,
    config: &PairingRouteConfig,
    session_id: &str,
) -> Result<Option<HttpRouteResponse>> {
    match prepare_route_request(request, &config.data_dir)? {
        RoutePreparation::Pending => return Ok(None),
        RoutePreparation::HostDenied => {
            config.metrics.record_attempt();
            config.metrics.record_host_denied();
            config.metrics.record_response();
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")));
        }
        RoutePreparation::Ready(_) => {}
    }
    config.metrics.record_attempt();
    let rate_limit = check_rate_limit(
        config,
        &format!("pairing.status:{request_ip}:{session_id}"),
        STATUS_LIMIT,
        STATUS_WINDOW,
    )?;
    let headers = rate_limit_headers(&rate_limit);
    if !rate_limit.ok {
        let response = audit_rate_limit(
            &config.data_dir,
            request,
            request_ip,
            "pairing.status",
            &rate_limit,
        )
        .map(|()| {
            HttpRouteResponse::json(
                429,
                json!({
                    "error": "Rate limit exceeded.",
                    "retryAfterMs": rate_limit.retry_after_ms
                }),
            )
        });
        return Ok(Some(claimed_result(config, response).with_headers(headers)));
    }
    let session = get_pairing_session(&config.data_dir, session_id)?;
    config.metrics.record_response();
    Ok(Some(
        match session {
            Some(session) => {
                HttpRouteResponse::json(200, json!({ "ok": true, "session": session }))
            }
            None => HttpRouteResponse::error(404, "Pairing session not found."),
        }
        .with_headers(headers),
    ))
}

fn match_pairing_request(request: &ParsedRequest) -> Option<PairingRequest> {
    let path = request.path();
    if path == "/api/pairing-sessions" {
        return match request.method.as_str() {
            "GET" => Some(PairingRequest::AdminList),
            "POST" => Some(PairingRequest::Create),
            _ => None,
        };
    }
    let tail = path.strip_prefix("/api/pairing-sessions/")?;
    if request.method == "GET" && !tail.is_empty() && !tail.contains('/') {
        return Some(PairingRequest::PublicStatus(tail.to_string()));
    }
    if request.method == "POST" {
        if let Some(id) = tail.strip_suffix("/claim") {
            if !id.is_empty() && !id.contains('/') {
                return Some(PairingRequest::Claim(id.to_string()));
            }
        }
        if let Some(id) = tail.strip_suffix("/approve") {
            if !id.is_empty() && !id.contains('/') {
                return Some(PairingRequest::Approve(id.to_string()));
            }
        }
        if let Some(id) = tail.strip_suffix("/deny") {
            if !id.is_empty() && !id.contains('/') {
                return Some(PairingRequest::Deny(id.to_string()));
            }
        }
    }
    None
}

fn claimed_result(
    config: &PairingRouteConfig,
    result: Result<HttpRouteResponse>,
) -> HttpRouteResponse {
    config.metrics.record_response();
    match result {
        Ok(response) => response,
        Err(error) => {
            config.metrics.record_failure();
            eprintln!("Rust Pairing decision failed without Node replay: {error:#}");
            HttpRouteResponse::error(500, "Pairing operation failed.")
        }
    }
}

fn check_rate_limit(
    config: &PairingRouteConfig,
    key: &str,
    limit: u32,
    window: Duration,
) -> Result<RateLimitResult> {
    let now = SystemTime::now();
    let mut buckets = config
        .rate_limits
        .lock()
        .map_err(|_| anyhow::anyhow!("Pairing rate limiter is unavailable"))?;
    let bucket = buckets.entry(key.to_string()).or_insert(RateBucket {
        count: 0,
        reset_at: now + window,
    });
    if bucket.reset_at <= now {
        bucket.count = 0;
        bucket.reset_at = now + window;
    }
    bucket.count += 1;
    let retry_after_ms = bucket
        .reset_at
        .duration_since(now)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    Ok(RateLimitResult {
        ok: bucket.count <= limit,
        count: bucket.count,
        limit,
        reset_at: bucket.reset_at,
        retry_after_ms,
    })
}

fn rate_limit_headers(result: &RateLimitResult) -> Vec<(String, String)> {
    let reset_at_ms = result
        .reset_at
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut headers = vec![
        ("X-RateLimit-Limit".to_string(), result.limit.to_string()),
        (
            "X-RateLimit-Remaining".to_string(),
            result.limit.saturating_sub(result.count).to_string(),
        ),
        ("X-RateLimit-Reset".to_string(), reset_at_ms.to_string()),
    ];
    if !result.ok {
        headers.push((
            "Retry-After".to_string(),
            result.retry_after_ms.div_ceil(1000).to_string(),
        ));
    }
    headers
}

fn open_database(data_dir: &Path, read_only: bool) -> Result<Connection> {
    let mut flags = OpenFlags::SQLITE_OPEN_NO_MUTEX;
    flags |= if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    let path = data_dir.join("mobile-agent.sqlite");
    let connection = Connection::open_with_flags(&path, flags)
        .with_context(|| format!("Cannot open {}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("Cannot configure pairing database timeout")?;
    Ok(connection)
}

fn pairing_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PairingRow> {
    Ok(PairingRow {
        id: row.get(0)?,
        code_hash: row.get(1)?,
        label: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        ip: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        user_agent: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        status: row.get(5)?,
        created_at: row.get(6)?,
        expires_at: row.get(7)?,
        approved_at: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
        approved_by_device_id: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
        claimed_at: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
        device_id: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
    })
}

const PAIRING_COLUMNS: &str =
    "id, code_hash, label, ip, user_agent, status, created_at, expires_at,
    approved_at, approved_by_device_id, claimed_at, device_id";

fn read_pairing(connection: &Connection, id: &str) -> Result<Option<PairingRow>> {
    connection
        .query_row(
            &format!("SELECT {PAIRING_COLUMNS} FROM pairing_sessions WHERE id = ?1"),
            [id],
            pairing_row,
        )
        .optional()
        .context("Cannot query pairing session")
}

fn public_pairing_session(row: PairingRow) -> Value {
    let now: DateTime<Utc> = SystemTime::now().into();
    let expired = DateTime::parse_from_rfc3339(&row.expires_at)
        .map(|value| value.with_timezone(&Utc) <= now)
        .unwrap_or(false);
    let status = if row.status == "pending" && expired {
        "expired".to_string()
    } else {
        row.status
    };
    json!({
        "id": row.id,
        "label": row.label,
        "ip": row.ip,
        "userAgent": row.user_agent,
        "status": status,
        "createdAt": row.created_at,
        "expiresAt": row.expires_at,
        "approvedAt": row.approved_at,
        "approvedByDeviceId": row.approved_by_device_id,
        "claimedAt": row.claimed_at,
        "deviceId": row.device_id,
        "expired": expired
    })
}

fn get_pairing_session(data_dir: &Path, id: &str) -> Result<Option<Value>> {
    let connection = open_database(data_dir, true)?;
    read_pairing(&connection, id).map(|row| row.map(public_pairing_session))
}

fn list_pairing_sessions(data_dir: &Path, status: &str) -> Result<Vec<Value>> {
    let connection = open_database(data_dir, true)?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT {PAIRING_COLUMNS} FROM pairing_sessions
             WHERE (?1 = '' OR status = ?1) ORDER BY created_at DESC LIMIT 20"
        ))
        .context("Cannot prepare pairing list query")?;
    let items = statement
        .query_map([status], pairing_row)
        .context("Cannot query pairing sessions")?
        .map(|row| {
            row.context("Cannot read pairing session")
                .map(public_pairing_session)
        })
        .collect();
    items
}

fn decide_pairing(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    device_id: &str,
    session_id: &str,
    approve: bool,
) -> Result<HttpRouteResponse> {
    let mut connection = open_database(data_dir, false)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin pairing decision transaction")?;
    let Some(mut row) = read_pairing(&transaction, session_id)? else {
        record_audit(
            &transaction,
            request,
            request_ip,
            device_id,
            if approve {
                "pairing.approve"
            } else {
                "pairing.deny"
            },
            false,
            if approve { "not_found" } else { "" },
            session_id,
            &json!({}),
        )?;
        transaction
            .commit()
            .context("Cannot commit missing pairing decision audit")?;
        return Ok(HttpRouteResponse::error(404, "Pairing session not found."));
    };
    let current: DateTime<Utc> = SystemTime::now().into();
    let current = current.to_rfc3339_opts(SecondsFormat::Millis, true);
    if approve {
        let expired = DateTime::parse_from_rfc3339(&row.expires_at)
            .map(|value| value.with_timezone(&Utc) <= DateTime::<Utc>::from(SystemTime::now()))
            .unwrap_or(false);
        if row.status == "pending" && !expired {
            transaction
                .execute(
                    "UPDATE pairing_sessions
                     SET status = 'approved', approved_at = ?1, approved_by_device_id = ?2
                     WHERE id = ?3",
                    params![current, device_id, session_id],
                )
                .context("Cannot approve pairing session")?;
            row = read_pairing(&transaction, session_id)?
                .context("Approved pairing session disappeared")?;
        }
    } else {
        transaction
            .execute(
                "UPDATE pairing_sessions
                 SET status = 'denied', approved_at = COALESCE(approved_at, ?1),
                     approved_by_device_id = COALESCE(approved_by_device_id, ?2)
                 WHERE id = ?3",
                params![current, device_id, session_id],
            )
            .context("Cannot deny pairing session")?;
        row = read_pairing(&transaction, session_id)?
            .context("Denied pairing session disappeared")?;
    }
    let session = public_pairing_session(row);
    let success = if approve {
        session["status"] == "approved"
    } else {
        true
    };
    let reason = if approve {
        session["status"].as_str().unwrap_or("")
    } else {
        ""
    };
    record_audit(
        &transaction,
        request,
        request_ip,
        device_id,
        if approve {
            "pairing.approve"
        } else {
            "pairing.deny"
        },
        success,
        reason,
        session_id,
        &json!({}),
    )?;
    transaction
        .commit()
        .context("Cannot commit pairing decision transaction")?;
    Ok(HttpRouteResponse::json(
        200,
        json!({ "ok": if approve { success } else { true }, "session": session }),
    ))
}

fn audit_rate_limit(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    scope: &str,
    result: &RateLimitResult,
) -> Result<()> {
    let reset_at: DateTime<Utc> = result.reset_at.into();
    audit_only(
        data_dir,
        request,
        request_ip,
        "",
        "rate_limit",
        false,
        scope,
        "",
        &json!({
            "ok": result.ok,
            "count": result.count,
            "limit": result.limit,
            "resetAt": reset_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            "retryAfterMs": result.retry_after_ms
        }),
    )
}

#[allow(clippy::too_many_arguments)]
fn audit_only(
    data_dir: &Path,
    request: &ParsedRequest,
    request_ip: &str,
    device_id: &str,
    event_type: &str,
    success: bool,
    reason: &str,
    target: &str,
    meta: &Value,
) -> Result<()> {
    let mut connection = open_database(data_dir, false)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("Cannot begin pairing audit transaction")?;
    record_audit(
        &transaction,
        request,
        request_ip,
        device_id,
        event_type,
        success,
        reason,
        target,
        meta,
    )?;
    transaction.commit().context("Cannot commit pairing audit")
}

#[allow(clippy::too_many_arguments)]
fn record_audit(
    connection: &Connection,
    request: &ParsedRequest,
    request_ip: &str,
    device_id: &str,
    event_type: &str,
    success: bool,
    reason: &str,
    target: &str,
    meta: &Value,
) -> Result<()> {
    let current: DateTime<Utc> = SystemTime::now().into();
    let current = current.to_rfc3339_opts(SecondsFormat::Millis, true);
    connection
        .execute(
            "INSERT INTO audit_log (
                event_type, event_at, device_id, ip, user_agent, method, path,
                success, reason, target, meta_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?2)",
            params![
                clean_string(event_type, 120),
                current,
                clean_string(device_id, 160),
                clean_string(request_ip, 120),
                clean_string(request.header("user-agent").unwrap_or(""), 500),
                clean_string(&request.method, 16),
                clean_string(request.path(), 500),
                i64::from(success),
                clean_string(reason, 1000),
                clean_string(target, 500),
                meta.to_string()
            ],
        )
        .context("Cannot write pairing audit record")?;
    Ok(())
}

fn clean_string(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::{route_pairing_request, route_pairing_request_with_body, PairingRouteConfig};
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_data_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "vibelink-pairing-http-{}-{nonce}",
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
                    label TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT,
                    revoked_at TEXT,
                    expires_at TEXT,
                    rotated_at TEXT,
                    meta_json TEXT
                );
                CREATE TABLE pairing_sessions (
                    id TEXT PRIMARY KEY,
                    code_hash TEXT NOT NULL,
                    label TEXT,
                    ip TEXT,
                    user_agent TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    approved_at TEXT,
                    approved_by_device_id TEXT,
                    claimed_at TEXT,
                    device_id TEXT,
                    meta_json TEXT
                );
                CREATE TABLE audit_log (
                    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    event_at TEXT NOT NULL,
                    device_id TEXT,
                    ip TEXT,
                    user_agent TEXT,
                    method TEXT,
                    path TEXT,
                    success INTEGER NOT NULL DEFAULT 0,
                    reason TEXT,
                    target TEXT,
                    meta_json TEXT,
                    created_at TEXT NOT NULL
                );",
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO devices (
                    id, label, token_hash, created_at, last_seen_at, revoked_at,
                    expires_at, rotated_at, meta_json
                 ) VALUES ('device-admin', 'Admin', ?1, '2026-01-01T00:00:00.000Z',
                           '2026-01-01T00:00:00.000Z', NULL,
                           '2099-01-01T00:00:00.000Z', '', '{}')",
                [hash_token("admin-token")],
            )
            .unwrap();
        for (id, label, created_at, expires_at) in [
            (
                "pairing-pending",
                "New phone",
                "2026-07-03T00:00:00.000Z",
                "2099-01-01T00:00:00.000Z",
            ),
            (
                "pairing-deny",
                "Denied phone",
                "2026-07-02T00:00:00.000Z",
                "2099-01-01T00:00:00.000Z",
            ),
            (
                "pairing-expired",
                "Expired phone",
                "2026-07-01T00:00:00.000Z",
                "2000-01-01T00:00:00.000Z",
            ),
        ] {
            database
                .execute(
                    "INSERT INTO pairing_sessions (
                        id, code_hash, label, ip, user_agent, status, created_at,
                        expires_at, approved_at, approved_by_device_id, claimed_at,
                        device_id, meta_json
                     ) VALUES (?1, 'hash', ?2, '203.0.113.1', 'VibeLink-Test',
                               'pending', ?3, ?4, NULL, NULL, NULL, NULL, '{}')",
                    params![id, label, created_at, expires_at],
                )
                .unwrap();
        }
        data_dir
    }

    fn request(method: &str, path: &str, token: &str) -> crate::status_http::ParsedRequest {
        let authorization = if token.is_empty() {
            String::new()
        } else {
            format!("Authorization: Bearer {token}\r\n")
        };
        parse_request(
            format!("{method} {path} HTTP/1.1\r\nHost: bridge.test\r\n{authorization}\r\n")
                .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn routes_public_status_and_authenticated_pairing_list() {
        let data_dir = ready_data_dir();
        let config = PairingRouteConfig::new(data_dir.clone());

        let status = request("GET", "/api/pairing-sessions/pairing-pending", "");
        let status = route_pairing_request(&status, "198.51.100.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(status.status, 200);
        assert_eq!(status.body["session"]["status"], "pending");
        assert_eq!(status.body["session"]["label"], "New phone");
        assert!(status.body["session"].get("code").is_none());

        let expired = request("GET", "/api/pairing-sessions/pairing-expired", "");
        let expired = route_pairing_request(&expired, "198.51.100.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(expired.body["session"]["status"], "expired");
        assert_eq!(expired.body["session"]["expired"], true);

        let missing = request("GET", "/api/pairing-sessions/missing", "");
        assert_eq!(
            route_pairing_request(&missing, "198.51.100.1", &config)
                .unwrap()
                .unwrap()
                .status,
            404
        );

        let anonymous_list = request("GET", "/api/pairing-sessions", "");
        assert_eq!(
            route_pairing_request(&anonymous_list, "198.51.100.1", &config)
                .unwrap()
                .unwrap()
                .status,
            401
        );
        let list = request(
            "GET",
            "/api/pairing-sessions?status=pending&fields=id%2Cstatus",
            "admin-token",
        );
        let list = route_pairing_request(&list, "198.51.100.1", &config)
            .unwrap()
            .unwrap();
        assert_eq!(list.status, 200);
        assert_eq!(list.body["items"].as_array().unwrap().len(), 3);
        assert_eq!(
            list.body["items"][0],
            json!({ "id": "pairing-pending", "status": "pending" })
        );
        assert_eq!(list.body["items"][2]["status"], "expired");
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn approves_and_denies_pairing_sessions_with_atomic_audits() {
        let data_dir = ready_data_dir();
        let config = PairingRouteConfig::new(data_dir.clone());
        let approve = request(
            "POST",
            "/api/pairing-sessions/pairing-pending/approve",
            "admin-token",
        );
        let approved = route_pairing_request(&approve, "198.51.100.2", &config)
            .unwrap()
            .unwrap();
        assert_eq!(approved.status, 200);
        assert_eq!(approved.body["ok"], true);
        assert_eq!(approved.body["session"]["status"], "approved");
        assert_eq!(
            approved.body["session"]["approvedByDeviceId"],
            "device-admin"
        );

        let deny = request(
            "POST",
            "/api/pairing-sessions/pairing-deny/deny",
            "admin-token",
        );
        let denied = route_pairing_request(&deny, "198.51.100.2", &config)
            .unwrap()
            .unwrap();
        assert_eq!(denied.status, 200);
        assert_eq!(denied.body["ok"], true);
        assert_eq!(denied.body["session"]["status"], "denied");

        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let audits = database
            .prepare(
                "SELECT event_type, device_id, ip, success, target
                 FROM audit_log ORDER BY cursor",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(audits.len(), 2);
        assert_eq!(audits[0].0, "pairing.approve");
        assert_eq!(audits[0].1, "device-admin");
        assert_eq!(audits[0].2, "198.51.100.2");
        assert_eq!(audits[0].3, 1);
        assert_eq!(audits[1].0, "pairing.deny");
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn rate_limits_public_pairing_status_polling() {
        let data_dir = ready_data_dir();
        let config = PairingRouteConfig::new(data_dir.clone());
        let status = request("GET", "/api/pairing-sessions/pairing-pending", "");
        for remaining in (0..60).rev() {
            let response = route_pairing_request(&status, "198.51.100.3", &config)
                .unwrap()
                .unwrap();
            assert_eq!(response.status, 200);
            assert_eq!(
                response
                    .header("X-RateLimit-Remaining")
                    .and_then(|value| value.parse::<usize>().ok()),
                Some(remaining)
            );
        }
        let denied = route_pairing_request(&status, "198.51.100.3", &config)
            .unwrap()
            .unwrap();
        assert_eq!(denied.status, 429);
        assert_eq!(denied.body["error"], "Rate limit exceeded.");
        assert!(denied.header("Retry-After").is_some());
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn creates_and_claims_pairing_with_one_time_token_and_prefetched_settings() {
        let data_dir = ready_data_dir();
        let internal = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let internal_addr = internal.local_addr().unwrap();
        let internal_thread = std::thread::spawn(move || {
            let (mut stream, _) = internal.accept().unwrap();
            let mut request = [0_u8; 2048];
            let size = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(request.starts_with("GET /internal/public-settings HTTP/1.1"));
            assert!(request.contains("X-VibeLink-Internal-Token: secret"));
            let body = r#"{"theme":"dark","hasOpenAIKey":false}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let config = PairingRouteConfig::new(data_dir.clone())
            .with_internal_settings(internal_addr, "secret".to_string());
        let create = request("POST", "/api/pairing-sessions", "");
        let created = route_pairing_request_with_body(
            &create,
            "127.0.0.1",
            Some(br#"{"deviceLabel":"Rust phone","trustLocalLauncher":false}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(created.status, 201);
        assert_eq!(created.body["ok"], true);
        assert_eq!(created.body["session"]["label"], "Rust phone");
        assert_eq!(created.body["session"]["status"], "pending");
        let session_id = created.body["session"]["id"].as_str().unwrap();
        let code = created.body["session"]["code"].as_str().unwrap();
        assert_eq!(code.len(), 6);
        assert!(code
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_lowercase()));
        assert!(created.body["pairingUrl"]
            .as_str()
            .unwrap()
            .contains(session_id));
        assert!(created.body["qrSvg"].as_str().unwrap().starts_with("<?xml"));

        let approve = request(
            "POST",
            &format!("/api/pairing-sessions/{session_id}/approve"),
            "admin-token",
        );
        assert_eq!(
            route_pairing_request(&approve, "127.0.0.1", &config)
                .unwrap()
                .unwrap()
                .body["session"]["status"],
            "approved"
        );

        let claim = request(
            "POST",
            &format!("/api/pairing-sessions/{session_id}/claim"),
            "",
        );
        let claim_body = format!(r#"{{"code":"{code}","deviceLabel":"Claimed phone"}}"#);
        let claimed = route_pairing_request_with_body(
            &claim,
            "198.51.100.8",
            Some(claim_body.as_bytes()),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(claimed.status, 200);
        assert_eq!(claimed.body["session"]["status"], "claimed");
        assert_eq!(claimed.body["device"]["label"], "Claimed phone");
        assert_eq!(claimed.body["settings"]["theme"], "dark");
        let token = claimed.body["token"].as_str().unwrap();
        assert_eq!(token.len(), 64);
        internal_thread.join().unwrap();

        let database = Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let code_hash = database
            .query_row(
                "SELECT code_hash FROM pairing_sessions WHERE id = ?1",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(code_hash, hash_token(&format!("{session_id}:{code}")));
        let token_hash = database
            .query_row(
                "SELECT token_hash FROM devices WHERE id = ?1",
                [claimed.body["device"]["id"].as_str().unwrap()],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(token_hash, hash_token(token));
        assert_ne!(token_hash, token);
        let audit_count = database
            .query_row(
                "SELECT COUNT(*) FROM audit_log
                 WHERE target = ?1 AND event_type IN ('pairing.create', 'pairing.approve', 'pairing.claim')",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(audit_count, 3);
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }
}
