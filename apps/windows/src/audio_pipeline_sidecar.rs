use anyhow::{bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{self, BufRead, Write};

const PROTOCOL_VERSION: u64 = 1;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    args: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct PcmInput {
    sequence: u64,
    samples: Vec<i32>,
    #[serde(rename = "silenceThreshold", default = "default_silence_threshold")]
    silence_threshold: f64,
}

struct AudioPipeline {
    max_buffered_samples: usize,
    max_samples_per_chunk: usize,
    ring: VecDeque<usize>,
    buffered_samples: usize,
    requests: u64,
    responses: u64,
    failures: u64,
    processed_chunks: u64,
    processed_samples: u64,
    processed_bytes: u64,
    dropped_chunks: u64,
    dropped_samples: u64,
    dropped_bytes: u64,
    backpressure_rejects: u64,
    sequence_gaps: u64,
    duplicate_sequences: u64,
    out_of_order_sequences: u64,
    evicted_chunks: u64,
    evicted_samples: u64,
    last_sequence: Option<u64>,
    started_at: String,
    last_request_at: String,
    last_response_at: String,
    last_failure_at: String,
    last_error: String,
}

fn default_silence_threshold() -> f64 {
    0.01
}

fn now_iso() -> String {
    let datetime: DateTime<Utc> = std::time::SystemTime::now().into();
    datetime.to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl AudioPipeline {
    fn new(max_buffered_samples: usize, max_samples_per_chunk: usize) -> Self {
        Self {
            max_buffered_samples: max_buffered_samples.max(1),
            max_samples_per_chunk: max_samples_per_chunk.max(1),
            ring: VecDeque::new(),
            buffered_samples: 0,
            requests: 0,
            responses: 0,
            failures: 0,
            processed_chunks: 0,
            processed_samples: 0,
            processed_bytes: 0,
            dropped_chunks: 0,
            dropped_samples: 0,
            dropped_bytes: 0,
            backpressure_rejects: 0,
            sequence_gaps: 0,
            duplicate_sequences: 0,
            out_of_order_sequences: 0,
            evicted_chunks: 0,
            evicted_samples: 0,
            last_sequence: None,
            started_at: now_iso(),
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
                "supportedMethods": ["processPcm16"],
                "controlMethods": ["__health", "stats", "__close"],
                "maxBufferedSamples": self.max_buffered_samples,
                "maxSamplesPerChunk": self.max_samples_per_chunk,
                "startedAt": self.started_at
            })),
            "stats" => Ok(self.stats()),
            "processPcm16" => {
                let value = args.first().cloned().context("Missing sidecar arg 0")?;
                let input: PcmInput = serde_json::from_value(value)?;
                self.process_pcm(input)
            }
            _ => bail!("Unsupported audio pipeline sidecar method: {method}"),
        }
    }

    fn process_pcm(&mut self, input: PcmInput) -> Result<Value> {
        if input.sequence > MAX_SAFE_SEQUENCE {
            bail!("sequence must be a non-negative safe integer");
        }
        if input.samples.is_empty() {
            bail!("samples must be a non-empty array");
        }
        if !input.silence_threshold.is_finite() || !(0.0..=1.0).contains(&input.silence_threshold) {
            bail!("silenceThreshold must be between 0 and 1");
        }
        if input
            .samples
            .iter()
            .any(|sample| !(-32768..=32767).contains(sample))
        {
            bail!("samples must contain signed 16-bit integers");
        }

        let sample_count = input.samples.len();
        if sample_count > self.max_samples_per_chunk || sample_count > self.max_buffered_samples {
            self.dropped_chunks += 1;
            self.dropped_samples += sample_count as u64;
            self.dropped_bytes += (sample_count * 2) as u64;
            self.backpressure_rejects += 1;
            bail!(
                "Audio pipeline backpressure: chunk exceeds maxSamplesPerChunk ({}) or ring capacity ({})",
                self.max_samples_per_chunk,
                self.max_buffered_samples
            );
        }

        let mut sequence_gap = 0;
        let mut duplicate = false;
        let mut out_of_order = false;
        match self.last_sequence {
            None => self.last_sequence = Some(input.sequence),
            Some(last) if input.sequence == last => {
                duplicate = true;
                self.duplicate_sequences += 1;
            }
            Some(last) if input.sequence < last => {
                out_of_order = true;
                self.out_of_order_sequences += 1;
            }
            Some(last) => {
                sequence_gap = input.sequence.saturating_sub(last).saturating_sub(1);
                self.sequence_gaps += sequence_gap;
                self.last_sequence = Some(input.sequence);
            }
        }

        let mut sum_squares = 0.0;
        let mut peak = 0.0_f64;
        for sample in &input.samples {
            let normalized = *sample as f64 / 32768.0;
            peak = peak.max(normalized.abs());
            sum_squares += normalized * normalized;
        }
        let rms = (sum_squares / sample_count as f64).sqrt();

        while !self.ring.is_empty()
            && self.buffered_samples + sample_count > self.max_buffered_samples
        {
            if let Some(removed) = self.ring.pop_front() {
                self.buffered_samples -= removed;
                self.evicted_chunks += 1;
                self.evicted_samples += removed as u64;
            }
        }
        self.ring.push_back(sample_count);
        self.buffered_samples += sample_count;
        self.processed_chunks += 1;
        self.processed_samples += sample_count as u64;
        self.processed_bytes += (sample_count * 2) as u64;

        let expected_sequence = self
            .last_sequence
            .and_then(|sequence| sequence.checked_add(1))
            .filter(|sequence| *sequence <= MAX_SAFE_SEQUENCE);
        Ok(json!({
            "sequence": input.sequence,
            "samples": sample_count,
            "bytes": sample_count * 2,
            "level": rms,
            "peak": peak,
            "rms": rms,
            "silence": rms < input.silence_threshold,
            "sequenceGap": sequence_gap,
            "duplicate": duplicate,
            "outOfOrder": out_of_order,
            "expectedSequence": expected_sequence,
            "bufferedChunks": self.ring.len(),
            "bufferedSamples": self.buffered_samples,
            "evictedChunks": self.evicted_chunks,
            "evictedSamples": self.evicted_samples
        }))
    }

    fn stats(&self) -> Value {
        json!({
            "implementation": "rust",
            "protocolVersion": PROTOCOL_VERSION,
            "startedAt": self.started_at,
            "pending": 0,
            "maxBufferedSamples": self.max_buffered_samples,
            "maxSamplesPerChunk": self.max_samples_per_chunk,
            "requests": self.requests,
            "responses": self.responses,
            "failures": self.failures,
            "processedChunks": self.processed_chunks,
            "processedSamples": self.processed_samples,
            "processedBytes": self.processed_bytes,
            "droppedChunks": self.dropped_chunks,
            "droppedSamples": self.dropped_samples,
            "droppedBytes": self.dropped_bytes,
            "backpressureRejects": self.backpressure_rejects,
            "sequenceGaps": self.sequence_gaps,
            "duplicateSequences": self.duplicate_sequences,
            "outOfOrderSequences": self.out_of_order_sequences,
            "bufferedChunks": self.ring.len(),
            "bufferedSamples": self.buffered_samples,
            "evictedChunks": self.evicted_chunks,
            "evictedSamples": self.evicted_samples,
            "lastSequence": self.last_sequence,
            "lastRequestAt": self.last_request_at,
            "lastResponseAt": self.last_response_at,
            "lastFailureAt": self.last_failure_at,
            "lastError": self.last_error
        })
    }
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
            "error": { "name": "Error", "message": message, "stack": "", "code": "" }
        })
    )?;
    stdout.flush()?;
    Ok(())
}

pub fn run(max_buffered_samples: usize, max_samples_per_chunk: usize) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut pipeline = AudioPipeline::new(max_buffered_samples, max_samples_per_chunk);

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_error(&mut stdout, &Value::Null, &error.to_string())?;
                continue;
            }
        };
        pipeline.record_request();
        if request.method == "__close" {
            pipeline.record_response();
            write_result(&mut stdout, &request.id, Value::Bool(true))?;
            break;
        }
        match pipeline.handle(&request.method, &request.args) {
            Ok(result) => {
                write_result(&mut stdout, &request.id, result)?;
                pipeline.record_response();
            }
            Err(error) => {
                let message = format!("{error:#}");
                pipeline.record_failure(&message);
                write_error(&mut stdout, &request.id, &message)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_pcm_level_peak_and_rms() {
        let mut pipeline = AudioPipeline::new(8, 8);
        let result = pipeline
            .process_pcm(PcmInput {
                sequence: 1,
                samples: vec![0, 16384, -16384, -32768],
                silence_threshold: 0.01,
            })
            .unwrap();
        assert_eq!(result["peak"], 1.0);
        assert_eq!(result["level"], result["rms"]);
        assert_eq!(result["silence"], false);
    }

    #[test]
    fn bounds_the_ring_and_counts_sequence_anomalies() {
        let mut pipeline = AudioPipeline::new(2, 2);
        for sequence in [3, 5, 5, 4] {
            pipeline
                .process_pcm(PcmInput {
                    sequence,
                    samples: vec![0],
                    silence_threshold: 0.01,
                })
                .unwrap();
        }
        assert_eq!(pipeline.sequence_gaps, 1);
        assert_eq!(pipeline.duplicate_sequences, 1);
        assert_eq!(pipeline.out_of_order_sequences, 1);
        assert_eq!(pipeline.ring.len(), 2);
        assert_eq!(pipeline.evicted_chunks, 2);
    }
}
