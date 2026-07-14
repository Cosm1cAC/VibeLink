use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::io::{self, Write};

#[derive(Debug, Deserialize)]
pub(crate) struct SidecarRequest {
    #[serde(default)]
    pub(crate) id: Value,
    pub(crate) method: String,
    #[serde(default)]
    pub(crate) args: Vec<Value>,
}

pub(crate) fn write_sidecar_result(
    stdout: &mut io::Stdout,
    id: &Value,
    result: Value,
) -> Result<()> {
    writeln!(stdout, "{}", json!({ "id": id, "result": result }))?;
    stdout.flush()?;
    Ok(())
}

pub(crate) fn write_sidecar_error(
    stdout: &mut io::Stdout,
    id: &Value,
    message: &str,
) -> Result<()> {
    writeln!(
        stdout,
        "{}",
        json!({
            "id": id,
            "error": {
                "name": "Error",
                "message": message,
                "stack": "",
                "code": ""
            }
        })
    )?;
    stdout.flush()?;
    Ok(())
}

pub(crate) fn sidecar_arg<T: DeserializeOwned>(args: &[Value], index: usize) -> Result<T> {
    let value = args
        .get(index)
        .cloned()
        .with_context(|| format!("Missing sidecar arg {index}"))?;
    Ok(serde_json::from_value(value)?)
}

pub(crate) fn sidecar_arg_or_default<T: DeserializeOwned + Default>(
    args: &[Value],
    index: usize,
) -> Result<T> {
    match args.get(index) {
        Some(value) if !value.is_null() => Ok(serde_json::from_value(value.clone())?),
        _ => Ok(T::default()),
    }
}

pub(crate) fn now_iso() -> String {
    let datetime: DateTime<Utc> = std::time::SystemTime::now().into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
