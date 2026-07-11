# Audio Pipeline Sidecar Contract

## Objective

Define deterministic, bounded PCM16 preprocessing before any production live-call routing changes. This contract covers level, peak, RMS, sequence accounting, and ring-buffer/backpressure counters. It does not perform VAD, resampling, ASR, transcript generation, device capture, or WebSocket handling.

The existing Node/Kotlin/.NET live-call paths remain authoritative. There is no production client and `VIBELINK_AUDIO_RUST_PIPELINE` is intentionally unused at `contract` status.

## Protocol

- Command: `vibelink audio-pipeline-sidecar`
- Transport: newline-delimited JSON over stdin/stdout
- Protocol version: `1`
- Defaults: 48,000 buffered samples and 8,192 samples per chunk
- Limits can be overridden with `--max-buffered-samples` and `--max-samples-per-chunk` for contract tests and future canaries.

Each request is one line:

```json
{"id":1,"method":"processPcm16","args":[{"sequence":10,"samples":[0,16384,-16384]}]}
```

Each response echoes `id` and contains exactly one of `result` or `error`.

### `processPcm16`

- `sequence` is a non-negative JavaScript-safe integer.
- `samples` is a non-empty array of signed 16-bit integers (`-32768..32767`).
- `silenceThreshold` is optional, defaults to `0.01`, and must be in `[0,1]`.
- `peak` is the maximum absolute sample divided by `32768`.
- `rms` is the square root of the mean squared normalized samples.
- `level` equals `rms` in protocol v1; this avoids an undocumented perceptual or dB mapping.
- `silence` is true when `rms < silenceThreshold`.
- Results report sample/byte counts, per-request sequence gap/duplicate/out-of-order state, next expected sequence, current buffered chunks/samples, and cumulative evictions.

Sequence gaps count missing sequence numbers. A duplicate or out-of-order chunk is still measured and buffered, but it does not move `lastSequence` backward.

### Ring Buffer And Backpressure

The sidecar stores only chunk sample counts, not audio payloads. Before adding a processed chunk, it evicts oldest entries until the configured sample capacity is available. A chunk larger than either the per-chunk limit or total ring capacity is rejected as backpressure and increments dropped chunk/sample/byte counters.

This first contract is synchronous, so `pending` is always `0`. A future production client must add its own bounded request queue and fallback before `opt-in`.

### Control Methods

- `__health`: implementation, protocol, methods, limits, and start time.
- `stats`: request/response/failure totals; processed, dropped, buffered, and evicted counts; sequence anomalies; backpressure; timestamps; `pending`; and last error.
- `__close`: returns `true` and exits cleanly.

## Commands

```powershell
cargo build --release --manifest-path apps/windows/Cargo.toml
cargo test --manifest-path apps/windows/Cargo.toml audio_pipeline_sidecar
npm run audio-pipeline:contract
npm run rust:migration:check
```

## Files

- `apps/windows/src/audio_pipeline_sidecar.rs`: Rust protocol, PCM math, counters, and unit tests
- `apps/windows/src/main.rs`: CLI registration only
- `src/audioPipelineContract.js`: shared protocol constants and error conversion
- `test/fixtures/audio-pipeline-json-sidecar.js`: independent Node fixture
- `test/rustAudioPipelineContract.test.js`: identical fixture/Rust behavior checks
- `.github/workflows/audio-pipeline-rust-contract.yml`: independent Windows contract gate

## Promotion Boundary

Remain at `contract` until concurrent live-call work is reconciled. Moving to `opt-in` requires an optional Node client behind `VIBELINK_AUDIO_RUST_PIPELINE=1`, bounded pending requests, missing/bad/timeout/invalid/exit fallback to the existing Node path, runtime routing metrics, and real PCM canaries. ASR/provider behavior remains outside this slice.
