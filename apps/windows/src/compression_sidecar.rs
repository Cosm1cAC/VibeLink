use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

const PROTOCOL_VERSION: u64 = 1;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const SUPPORTED_METHODS: [&str; 2] = ["trimUtf8", "sampleLogLines"];
const CONTROL_METHODS: [&str; 3] = ["__health", "stats", "__close"];

#[derive(Debug, Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    args: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrimOptions {
    max_bytes: Option<u64>,
    #[serde(default)]
    keep: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleLogLinesOptions {
    head_lines: Option<u64>,
    tail_lines: Option<u64>,
}

struct Runtime {
    started_at: String,
    requests: u64,
    responses: u64,
    failures: u64,
    bytes_in: u64,
    bytes_out: u64,
    last_request_at: String,
    last_response_at: String,
    last_failure_at: String,
    last_error: String,
}

pub fn run() -> Result<()> {
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
            runtime.record_response();
            let result = runtime.stats();
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
            bytes_in: 0,
            bytes_out: 0,
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
                "supportedMethods": SUPPORTED_METHODS,
                "controlMethods": CONTROL_METHODS,
                "startedAt": self.started_at
            })),
            "trimUtf8" => self.handle_trim_utf8(args),
            "sampleLogLines" => self.handle_sample_log_lines(args),
            _ => bail!("Unsupported compression sidecar method: {method}"),
        }
    }

    fn handle_trim_utf8(&mut self, args: &[Value]) -> Result<Value> {
        let text: String = arg(args, 0)?;
        let options: TrimOptions = arg(args, 1)?;
        let max_bytes = required_count(options.max_bytes, "maxBytes")?;
        let keep = options.keep.as_deref().unwrap_or("tail");
        let output = match keep {
            "head" => trim_utf8_head(&text, max_bytes),
            "tail" => trim_utf8_tail(&text, max_bytes),
            _ => bail!("keep must be head or tail."),
        };
        let input_bytes = text.len();
        let output_bytes = output.len();
        self.bytes_in = self.bytes_in.saturating_add(input_bytes as u64);
        self.bytes_out = self.bytes_out.saturating_add(output_bytes as u64);
        Ok(json!({
            "text": output,
            "inputBytes": input_bytes,
            "outputBytes": output_bytes,
            "truncated": output_bytes < input_bytes
        }))
    }

    fn handle_sample_log_lines(&mut self, args: &[Value]) -> Result<Value> {
        let lines: Vec<String> = arg(args, 0)?;
        let options: SampleLogLinesOptions = arg(args, 1)?;
        let head_lines = required_count(options.head_lines, "headLines")?;
        let tail_lines = required_count(options.tail_lines, "tailLines")?;
        let sampled = sample_log_lines(&lines, head_lines, tail_lines);
        let input_bytes = total_bytes(&lines);
        let output_bytes = total_bytes(&sampled);
        self.bytes_in = self.bytes_in.saturating_add(input_bytes as u64);
        self.bytes_out = self.bytes_out.saturating_add(output_bytes as u64);
        Ok(json!({
            "lines": sampled,
            "inputLines": lines.len(),
            "outputLines": sampled.len(),
            "omittedLines": lines.len() - sampled.len(),
            "inputBytes": input_bytes,
            "outputBytes": output_bytes,
            "truncated": sampled.len() < lines.len()
        }))
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
            "bytesIn": self.bytes_in,
            "bytesOut": self.bytes_out,
            "lastRequestAt": self.last_request_at,
            "lastResponseAt": self.last_response_at,
            "lastFailureAt": self.last_failure_at,
            "lastError": self.last_error
        })
    }
}

fn arg<T: DeserializeOwned>(args: &[Value], index: usize) -> Result<T> {
    let value = args
        .get(index)
        .cloned()
        .with_context(|| format!("Missing compression sidecar arg {index}"))?;
    serde_json::from_value(value).map_err(Into::into)
}

fn required_count(value: Option<u64>, name: &str) -> Result<usize> {
    let value = value.ok_or_else(|| anyhow!("{name} must be a non-negative integer."))?;
    if value > MAX_SAFE_INTEGER {
        bail!("{name} must be a non-negative integer.");
    }
    usize::try_from(value).map_err(|_| anyhow!("{name} must be a non-negative integer."))
}

fn trim_utf8_head(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = 0;
    for (index, character) in text.char_indices() {
        let next = index + character.len_utf8();
        if next > max_bytes {
            break;
        }
        end = next;
    }
    text[..end].to_string()
}

fn trim_utf8_tail(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut start = text.len();
    for (index, _) in text.char_indices().rev() {
        if text.len() - index > max_bytes {
            break;
        }
        start = index;
    }
    text[start..].to_string()
}

fn sample_log_lines(lines: &[String], head_lines: usize, tail_lines: usize) -> Vec<String> {
    let head_count = head_lines.min(lines.len());
    let tail_start = head_count.max(lines.len().saturating_sub(tail_lines));
    lines[..head_count]
        .iter()
        .chain(lines[tail_start..].iter())
        .cloned()
        .collect()
}

fn total_bytes(lines: &[String]) -> usize {
    lines.iter().map(String::len).sum()
}

fn now_iso() -> String {
    let datetime: DateTime<Utc> = std::time::SystemTime::now().into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn write_result(stdout: &mut io::Stdout, id: &Value, result: Value) -> Result<()> {
    writeln!(stdout, "{}", json!({ "id": id, "result": result }))?;
    stdout.flush()?;
    Ok(())
}

fn write_error(stdout: &mut io::Stdout, id: &Value, message: &str) -> Result<()> {
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

#[cfg(test)]
mod tests {
    use super::{sample_log_lines, trim_utf8_head, trim_utf8_tail};

    #[test]
    fn trims_complete_utf8_code_points_from_both_ends() {
        let text = "ab\u{1f600}\u{4e2d}cd";
        assert_eq!(trim_utf8_head(text, 6), "ab\u{1f600}");
        assert_eq!(trim_utf8_tail(text, 6), "\u{4e2d}cd");
        assert_eq!(trim_utf8_tail(text, 0), "");
    }

    #[test]
    fn samples_head_and_tail_without_overlap() {
        let lines = ["a", "b", "c"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert_eq!(sample_log_lines(&lines, 2, 2), lines);

        let longer = ["1", "2", "3", "4", "5", "6"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert_eq!(sample_log_lines(&longer, 2, 2), ["1", "2", "5", "6"]);
    }
}
