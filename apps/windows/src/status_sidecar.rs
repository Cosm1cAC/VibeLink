use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    io::{self, BufRead, Write},
    time::SystemTime,
};

const PROTOCOL_VERSION: u64 = 1;

#[derive(Debug, Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    args: Vec<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusSnapshot {
    ok: bool,
    settings: Map<String, Value>,
    provider_registry: Map<String, Value>,
    storage: StatusStorage,
    security: Map<String, Value>,
    notifications: Map<String, Value>,
    workspaces: Vec<Value>,
    workspace_runtime: Map<String, Value>,
    network: Vec<Value>,
    tasks: Vec<Value>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize, Serialize)]
struct StatusStorage {
    sqlite: String,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

struct Runtime {
    started_at: String,
    requests: u64,
    responses: u64,
    failures: u64,
    renders: u64,
    last_request_at: String,
    last_response_at: String,
    last_failure_at: String,
    last_error: String,
}

pub(crate) fn run() -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut runtime = Runtime::new();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                runtime.record_failure(&error.to_string());
                write_error(&mut stdout, &Value::Null, &error.to_string())?;
                continue;
            }
        };

        runtime.record_request();
        if request.method == "__close" {
            runtime.record_response();
            write_result(&mut stdout, &request.id, Value::Bool(true))?;
            break;
        }
        if request.method == "stats" {
            let result = runtime.stats();
            runtime.record_response();
            write_result(&mut stdout, &request.id, result)?;
            continue;
        }

        match runtime.handle(&request.method, &request.args) {
            Ok(result) => {
                runtime.record_response();
                write_result(&mut stdout, &request.id, result)?;
            }
            Err(error) => {
                let message = format!("{error:#}");
                runtime.record_failure(&message);
                write_error(&mut stdout, &request.id, &message)?;
            }
        }
    }
    Ok(())
}

impl Runtime {
    fn new() -> Self {
        Self {
            started_at: now_iso(),
            requests: 0,
            responses: 0,
            failures: 0,
            renders: 0,
            last_request_at: String::new(),
            last_response_at: String::new(),
            last_failure_at: String::new(),
            last_error: String::new(),
        }
    }

    fn record_request(&mut self) {
        self.requests += 1;
        self.last_request_at = now_iso();
    }

    fn record_response(&mut self) {
        self.responses += 1;
        self.last_response_at = now_iso();
    }

    fn record_failure(&mut self, message: &str) {
        self.failures += 1;
        self.last_failure_at = now_iso();
        self.last_error = message.to_string();
    }

    fn handle(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        match method {
            "__health" => Ok(json!({
                "ok": true,
                "implementation": "rust",
                "protocolVersion": PROTOCOL_VERSION,
                "supportedMethods": ["renderStatus"]
            })),
            "renderStatus" => self.render_status(args),
            _ => bail!("Unsupported status sidecar method: {method}"),
        }
    }

    fn render_status(&mut self, args: &[Value]) -> Result<Value> {
        let value = args
            .first()
            .cloned()
            .context("Missing status sidecar snapshot")?;
        validate_status_shape(&value)?;
        let snapshot: StatusSnapshot =
            serde_json::from_value(value).context("Invalid status snapshot")?;
        if !snapshot.ok {
            bail!("Status snapshot ok must be true");
        }
        if snapshot.storage.sqlite.trim().is_empty() {
            bail!("Status snapshot storage.sqlite must not be empty");
        }
        self.renders += 1;
        serde_json::to_value(snapshot).context("Cannot serialize status snapshot")
    }

    fn stats(&self) -> Value {
        json!({
            "implementation": "rust",
            "protocolVersion": PROTOCOL_VERSION,
            "startedAt": self.started_at,
            "pending": 0,
            "requests": self.requests,
            "responses": self.responses,
            "failures": self.failures,
            "renders": self.renders,
            "lastRequestAt": self.last_request_at,
            "lastResponseAt": self.last_response_at,
            "lastFailureAt": self.last_failure_at,
            "lastError": self.last_error
        })
    }
}

fn validate_status_shape(value: &Value) -> Result<()> {
    let object = value
        .as_object()
        .context("Status snapshot must be an object")?;
    for field in [
        "settings",
        "providerRegistry",
        "storage",
        "security",
        "notifications",
        "workspaceRuntime",
    ] {
        if !object.get(field).is_some_and(Value::is_object) {
            bail!("Status snapshot {field} must be an object");
        }
    }
    for field in ["workspaces", "network", "tasks"] {
        if !object.get(field).is_some_and(Value::is_array) {
            bail!("Status snapshot {field} must be an array");
        }
    }
    Ok(())
}

fn now_iso() -> String {
    let now: DateTime<Utc> = SystemTime::now().into();
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn write_result(stdout: &mut impl Write, id: &Value, result: Value) -> Result<()> {
    writeln!(stdout, "{}", json!({ "id": id, "result": result }))?;
    stdout.flush()?;
    Ok(())
}

fn write_error(stdout: &mut impl Write, id: &Value, message: &str) -> Result<()> {
    writeln!(
        stdout,
        "{}",
        json!({
            "id": id,
            "error": { "name": "Error", "message": message }
        })
    )?;
    stdout.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_snapshot_requires_array_workspaces() {
        let invalid = json!({
            "ok": true,
            "settings": {},
            "providerRegistry": {},
            "storage": { "sqlite": "db.sqlite" },
            "security": {},
            "notifications": {},
            "workspaces": "invalid",
            "workspaceRuntime": {},
            "network": [],
            "tasks": []
        });
        let error = Runtime::new().render_status(&[invalid]).unwrap_err();
        assert!(error.to_string().contains("workspaces"));
    }
}
