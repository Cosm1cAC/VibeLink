use anyhow::{bail, Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const DEFAULT_SPOOL_QUOTA_BYTES: u64 = 64 * 1024 * 1024;
pub const DEFAULT_SEGMENT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestEnvelope {
    pub protocol_version: u32,
    pub request_id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub protocol_version: u32,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolError>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default)]
    pub details: Value,
}

impl ResponseEnvelope {
    pub fn success(request_id: impl Into<String>, result: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            result: Some(result),
            error: None,
        }
    }

    pub fn error(
        request_id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            result: None,
            error: Some(ProtocolError {
                code: code.into(),
                message: message.into(),
                retryable,
                details: Value::Object(Default::default()),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Starting,
    Running,
    AwaitingApproval,
    Stopping,
    Completed,
    Failed,
    Cancelled,
    Lost,
    OutcomeUnknown,
}

impl ExecutionStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Lost | Self::OutcomeUnknown
        )
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttachState {
    Attached,
    Reconnecting,
    Unreachable,
    Lost,
    External,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub enum BackendKind {
    #[serde(rename = "conpty")]
    ConPty,
    #[serde(rename = "stdio")]
    Stdio,
    #[serde(rename = "app_server")]
    AppServer,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppServerParams {
    pub thread_resume_params: Value,
    pub turn_start_params: Value,
    #[serde(default = "default_app_server_connect_timeout")]
    pub connect_timeout_ms: u64,
}

fn default_app_server_connect_timeout() -> u64 {
    15_000
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartParams {
    #[serde(default)]
    pub execution_id: Option<String>,
    pub kind: String,
    pub backend: BackendKind,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub app_server: Option<AppServerParams>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default = "default_spool_quota")]
    pub spool_quota_bytes: u64,
    #[serde(default = "default_segment_bytes")]
    pub segment_bytes: u64,
    pub operation_id: String,
}

fn default_cols() -> u16 {
    120
}

fn default_rows() -> u16 {
    30
}

fn default_spool_quota() -> u64 {
    DEFAULT_SPOOL_QUOTA_BYTES
}

fn default_segment_bytes() -> u64 {
    DEFAULT_SEGMENT_BYTES
}

impl StartParams {
    pub fn validate(&self) -> Result<()> {
        if self.kind.trim().is_empty() || self.kind.len() > 64 {
            bail!("kind must contain 1-64 characters");
        }
        if self.command.trim().is_empty() || self.command.len() > 32_768 {
            bail!("command must contain 1-32768 characters");
        }
        if self.args.len() > 1024 || self.env.len() > 1024 {
            bail!("args or env exceeds the bounded v1 schema");
        }
        if self.cols == 0 || self.rows == 0 {
            bail!("terminal size must be positive");
        }
        match (self.backend, self.kind.as_str(), self.app_server.as_ref()) {
            (BackendKind::AppServer, "provider.appServer", Some(app_server)) => {
                validate_app_server_params(app_server)?;
            }
            (BackendKind::AppServer, _, _) => {
                bail!("app_server backend requires kind provider.appServer and appServer params");
            }
            (_, "provider.appServer", _) => {
                bail!("provider.appServer requires the app_server backend");
            }
            (_, _, Some(_)) => bail!("appServer params require the app_server backend"),
            _ => {}
        }
        if self.spool_quota_bytes < 4096 || self.segment_bytes < 1024 {
            bail!("spool quota and segment size are too small");
        }
        validate_operation_id(&self.operation_id)
    }
}

fn validate_app_server_params(params: &AppServerParams) -> Result<()> {
    let resume = params
        .thread_resume_params
        .as_object()
        .context("appServer.threadResumeParams must be an object")?;
    let turn = params
        .turn_start_params
        .as_object()
        .context("appServer.turnStartParams must be an object")?;
    let resume_thread = resume
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .context("appServer.threadResumeParams.threadId is required")?;
    let turn_thread = turn
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .context("appServer.turnStartParams.threadId is required")?;
    if resume_thread != turn_thread {
        bail!("appServer resume and turn threadId must match");
    }
    if !turn.get("input").is_some_and(Value::is_array) {
        bail!("appServer.turnStartParams.input must be an array");
    }
    if !(100..=60_000).contains(&params.connect_timeout_ms) {
        bail!("appServer.connectTimeoutMs must be between 100 and 60000");
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionParams {
    pub execution_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventsParams {
    pub execution_id: String,
    #[serde(default)]
    pub after_host_seq: u64,
    #[serde(default = "default_event_limit")]
    pub limit: usize,
}

fn default_event_limit() -> usize {
    1000
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AckParams {
    pub execution_id: String,
    pub host_seq: u64,
    pub operation_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputParams {
    pub execution_id: String,
    pub data: String,
    #[serde(default = "default_utf8")]
    pub encoding: String,
    pub operation_id: String,
}

fn default_utf8() -> String {
    "utf8".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResizeParams {
    pub execution_id: String,
    pub cols: u16,
    pub rows: u16,
    pub operation_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignalParams {
    pub execution_id: String,
    pub signal: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListParams {
    #[serde(default)]
    pub after_execution_id: String,
    #[serde(default = "default_list_limit")]
    pub limit: usize,
}

fn default_list_limit() -> usize {
    100
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerHelloParams {
    pub nonce: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerBootstrap {
    pub manifest_path: String,
    pub start: StartParams,
    pub worker_instance_id: String,
    pub pipe_name: String,
    pub nonce: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionManifest {
    pub protocol_version: u32,
    pub execution_id: String,
    pub start_operation_id: String,
    pub start_fingerprint: String,
    pub kind: String,
    pub backend: BackendKind,
    pub owner: String,
    pub status: ExecutionStatus,
    pub attach_state: AttachState,
    pub worker_instance_id: String,
    pub worker_pid: u32,
    pub worker_started_at_ticks: u64,
    pub pipe_name: String,
    pub nonce: String,
    pub process_pid: Option<u32>,
    pub process_started_at_ticks: Option<u64>,
    pub process_started_at: String,
    pub last_host_seq: u64,
    pub last_acked_host_seq: u64,
    pub capabilities: Value,
    pub started_at: String,
    pub ended_at: String,
    pub exit_code: Option<u32>,
    pub signal: String,
    pub spool_quota_bytes: u64,
    pub segment_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSnapshot {
    pub execution_id: String,
    pub kind: String,
    pub owner: String,
    pub status: ExecutionStatus,
    pub attach_state: AttachState,
    pub worker_instance_id: String,
    pub worker_pid: u32,
    pub process_pid: Option<u32>,
    pub process_started_at: String,
    pub last_host_seq: u64,
    pub last_acked_host_seq: u64,
    pub capabilities: Value,
    pub started_at: String,
    pub ended_at: String,
    pub exit_code: Option<u32>,
    pub signal: String,
}

impl From<&ExecutionManifest> for ExecutionSnapshot {
    fn from(manifest: &ExecutionManifest) -> Self {
        Self {
            execution_id: manifest.execution_id.clone(),
            kind: manifest.kind.clone(),
            owner: manifest.owner.clone(),
            status: manifest.status,
            attach_state: manifest.attach_state,
            worker_instance_id: manifest.worker_instance_id.clone(),
            worker_pid: manifest.worker_pid,
            process_pid: manifest.process_pid,
            process_started_at: manifest.process_started_at.clone(),
            last_host_seq: manifest.last_host_seq,
            last_acked_host_seq: manifest.last_acked_host_seq,
            capabilities: manifest.capabilities.clone(),
            started_at: manifest.started_at.clone(),
            ended_at: manifest.ended_at.clone(),
            exit_code: manifest.exit_code,
            signal: manifest.signal.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostEvent {
    pub execution_id: String,
    pub host_seq: u64,
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub at: String,
    pub payload: Value,
}

pub fn validate_request(request: &RequestEnvelope) -> Result<()> {
    if request.protocol_version != PROTOCOL_VERSION {
        bail!("unsupported protocol version {}", request.protocol_version);
    }
    if request.request_id.is_empty() || request.request_id.len() > 128 {
        bail!("requestId must contain 1-128 characters");
    }
    if request.method.is_empty() || request.method.len() > 128 {
        bail!("method must contain 1-128 characters");
    }
    Ok(())
}

pub fn validate_operation_id(operation_id: &str) -> Result<()> {
    if operation_id.is_empty() || operation_id.len() > 128 {
        bail!("operationId must contain 1-128 characters");
    }
    Ok(())
}

pub fn parse_params<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).context("request params violate the strict v1 schema")
}

pub fn read_json_frame<R: Read, T: DeserializeOwned>(reader: &mut R) -> Result<Option<T>> {
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error).context("failed to read frame length"),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        bail!("frame length {length} exceeds the protocol boundary");
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .context("failed to read complete frame")?;
    let value =
        serde_json::from_slice(&payload).context("frame is not a strict protocol envelope")?;
    Ok(Some(value))
}

pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<RequestEnvelope>> {
    read_json_frame(reader)
}

pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<()> {
    let payload = serde_json::to_vec(value).context("failed to serialize protocol frame")?;
    if payload.len() > MAX_FRAME_BYTES {
        bail!("serialized frame exceeds the protocol boundary");
    }
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .context("failed to write frame length")?;
    writer
        .write_all(&payload)
        .context("failed to write frame payload")?;
    writer.flush().context("failed to flush protocol frame")
}

pub fn operation_fingerprint(method: &str, params: &Value) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(method.as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_vec(params).context("failed to fingerprint operation params")?);
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn start_fingerprint(start: &StartParams) -> Result<String> {
    let mut canonical = start.clone();
    canonical.execution_id = None;
    operation_fingerprint("execution.start", &serde_json::to_value(canonical)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strict_request_envelope_rejects_unknown_fields() {
        let error = serde_json::from_value::<RequestEnvelope>(json!({
            "protocolVersion": 1,
            "requestId": "r1",
            "method": "host.health",
            "params": {},
            "unexpected": true
        }))
        .unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn frame_round_trip_is_length_bounded() {
        let request = RequestEnvelope {
            protocol_version: 1,
            request_id: "r1".to_string(),
            method: "host.health".to_string(),
            params: json!({}),
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &request).unwrap();
        assert_eq!(
            read_frame(&mut bytes.as_slice()).unwrap().unwrap().method,
            "host.health"
        );

        let mut oversized = ((MAX_FRAME_BYTES + 1) as u32).to_le_bytes().to_vec();
        oversized.extend_from_slice(b"{}");
        assert!(read_frame(&mut oversized.as_slice()).is_err());
    }

    #[test]
    fn strict_method_params_reject_unknown_fields() {
        let error = parse_params::<ExecutionParams>(json!({
            "executionId": "e1",
            "workerPid": 42
        }))
        .unwrap_err();
        assert!(error.to_string().contains("strict v1 schema"));
    }

    #[test]
    fn app_server_start_requires_matching_resume_and_turn_thread() {
        let valid = StartParams {
            execution_id: None,
            kind: "provider.appServer".to_string(),
            backend: BackendKind::AppServer,
            command: "codex".to_string(),
            args: Vec::new(),
            cwd: Some("C:\\repo".to_string()),
            env: BTreeMap::new(),
            app_server: Some(AppServerParams {
                thread_resume_params: json!({ "threadId": "thread-1" }),
                turn_start_params: json!({ "threadId": "thread-1", "input": [] }),
                connect_timeout_ms: 15_000,
            }),
            cols: 120,
            rows: 30,
            spool_quota_bytes: DEFAULT_SPOOL_QUOTA_BYTES,
            segment_bytes: DEFAULT_SEGMENT_BYTES,
            operation_id: "start-1".to_string(),
        };
        valid.validate().unwrap();

        let mut mismatched = valid.clone();
        mismatched.app_server.as_mut().unwrap().turn_start_params["threadId"] =
            Value::String("thread-2".to_string());
        assert!(mismatched
            .validate()
            .unwrap_err()
            .to_string()
            .contains("must match"));
    }
}
