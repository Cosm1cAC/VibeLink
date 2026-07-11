# Compression Sidecar Contract

## Objective

Define a deterministic Rust data-plane helper for bounded text and log sampling. The first slice exists to prove a stable JSONL contract and cross-language parity before any production routing is considered.

This helper is not semantic compression, summarization, or a provider tokenizer. `src/compactService.js` and `src/contextBudget.js` remain authoritative.

## Tech Stack

- Rust command: `vibelink compression-sidecar`
- Transport: newline-delimited JSON over stdin/stdout
- Protocol version: `1`
- JavaScript fixture and contract tests: Node.js built-in test runner

## Contract

Each request is one JSON line:

```json
{"id":1,"method":"trimUtf8","args":["text",{"maxBytes":16,"keep":"tail"}]}
```

Each response echoes `id` and contains exactly one of `result` or `error`:

```json
{"id":1,"result":{"text":"text","inputBytes":4,"outputBytes":4,"truncated":false}}
```

```json
{"id":1,"error":{"name":"Error","message":"...","stack":"","code":""}}
```

### Data Methods

`trimUtf8(text, options)`

- `text` must be a string.
- `options.maxBytes` must be a JavaScript-safe non-negative integer.
- `options.keep` is `head` or `tail`; it defaults to `tail`.
- The result is the longest complete-code-point prefix or suffix whose UTF-8 encoding is at most `maxBytes`.
- Result fields: `text`, `inputBytes`, `outputBytes`, and `truncated`.

`sampleLogLines(lines, options)`

- `lines` must be an array of strings.
- `options.headLines` and `options.tailLines` must be JavaScript-safe non-negative integers.
- The result keeps up to `headLines` entries from the start and up to `tailLines` entries from the end, preserving source order and never duplicating overlapping entries.
- Result fields: `lines`, `inputLines`, `outputLines`, `omittedLines`, `inputBytes`, `outputBytes`, and `truncated`.
- Byte totals are the sum of each line's UTF-8 bytes and do not include transport or newline bytes.

### Control Methods

- `__health` returns `ok`, `implementation`, `protocolVersion`, `supportedMethods`, `controlMethods`, and `startedAt`.
- `stats` returns request/response/failure counters, aggregate input/output bytes, timestamps, `lastError`, and `pending: 0`.
- `__close` returns `true` and exits cleanly.

Malformed JSON and invalid method arguments return the same structured error envelope. A malformed line uses `id: null`. Failed requests increment the sidecar failure counter.

## Commands

```powershell
cargo test --manifest-path apps/windows/Cargo.toml compression_sidecar
cargo build --release --manifest-path apps/windows/Cargo.toml
node --test test/rustCompressionContract.test.js
npm run rust:migration:check
```

## Project Structure

- `apps/windows/src/compression_sidecar.rs`: Rust protocol implementation and unit tests
- `apps/windows/src/main.rs`: CLI registration only
- `src/compressionContract.js`: shared protocol constants and error conversion
- `test/fixtures/compression-json-sidecar.js`: independent JavaScript fixture
- `test/rustCompressionContract.test.js`: fixture/Rust parity contract
- `docs/rust-migration-status.json`: rollout state and evidence

## Code Style

The protocol uses camelCase JSON fields and explicit boundary validation:

```rust
let value = value.ok_or_else(|| anyhow!("{name} must be a non-negative integer."))?;
```

Rust internals use snake_case and return `anyhow::Result`; all protocol errors are serialized only at the stdin/stdout boundary.

## Testing Strategy

- Unit-test UTF-8 prefix/suffix boundaries and overlapping line samples in Rust.
- Run identical behavioral cases against the JavaScript fixture and release Rust binary.
- Assert health metadata, deterministic outputs, validation errors, stats, and clean close.
- Keep the slice at `contract`; production fallback and routing tests are required before `opt-in`.

## Boundaries

- Always: preserve complete UTF-8 code points, validate all external inputs, keep deterministic ordering, run focused Rust/Node tests before commit.
- Ask first: change semantic compaction, token estimation, provider prompts, or production routing.
- Never: claim tokenizer accuracy, generate summaries, modify Android/live-call paths, or make this helper required for bridge startup.

## Success Criteria

- The JavaScript fixture and real Rust command pass the same contract cases.
- Multibyte truncation never emits invalid UTF-8 or exceeds `maxBytes`.
- Log samples preserve order, deduplicate overlap, and report exact counts/bytes.
- Invalid calls use a stable error envelope and appear in `stats.failures`.
- The migration manifest advances from `planned` to `contract` without enabling a feature flag or production path.

## Open Questions

- Whether production measurements justify an optional Node client and routing remains intentionally unresolved until contract evidence exists.
- Provider-specific tokenization remains outside this sidecar and requires a separate design.
