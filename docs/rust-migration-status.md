# Rust Migration Status

Last updated: 2026-07-09

This file is the human-readable status view for the Rust migration program. The machine-readable source of truth is `docs/rust-migration-status.json`; run `npm run rust:migration:check` before changing statuses.

## Policy

- **Node control plane:** HTTP routes, settings, security, approvals, provider orchestration, REST/SSE, and product state stay in Node.
- **Rust data plane:** high-frequency or low-latency paths move to Rust sidecars/CLI commands one slice at a time.
- **Sidecar first:** every slice starts with a stable CLI/JSONL contract before deeper embedding.
- **Fallback required:** a missing, failing, timing-out, or incompatible Rust sidecar must fall back to the Node/Worker path unless the slice is explicitly test-only.
- **Promotion is gated:** no slice moves from `planned` to `contract`, `opt-in`, `canary`, or `default-on` unless its gate in the manifest is satisfied.

## Status legend

| Status | Meaning |
| --- | --- |
| `planned` | No implemented Rust contract yet. The manifest must include a bounded next action and promotion gate. |
| `contract` | JSONL/CLI/API contract exists and is tested, but production does not route to a real Rust implementation. |
| `opt-in` | Real Rust implementation exists and production can route to it only under an explicit flag with fallback. |
| `canary` | Auto/safe-detection mode and rollback instructions exist; metrics are good enough for limited default exposure. |
| `default-on` | Rust is the default path, fallback remains available, and CI/status checks block drift. |
| `deprecated-node-path` | Rust is default and the old Node path has a separate removal plan. |

## Current slice table

| Slice | Status | Rollout | Feature flag(s) | Fallback | Next action |
| --- | --- | --- | --- | --- | --- |
| Workspace tree scanner | `opt-in` | Manual flag only | `VIBELINK_RUST_WORKSPACE_TREE`, `VIBELINK_RUST_BIN`, `VIBELINK_RUST_BIN_ARGS_JSON` | Node `listDirectory()` in `src/workspaces.js` | Add `auto` mode, parity gates, fallback counters, lastError stats, and resolve/record full gitignore path semantics before canary. |
| Persistent MCP stdio sessions | `opt-in` | Manual flag only | `VIBELINK_MCP_RUST_SIDECAR`, `VIBELINK_MCP_RUST_SIDECAR_COMMAND`, `VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON`, `VIBELINK_MCP_PERSISTENT_SESSIONS` | Existing Node stdio probe/call path in `src/mcpRuntime.js` | Add `auto` mode, health readiness checks, spawn-reduction/fallback-rate promotion gates, and rollback docs. |
| Event store append/replay sidecar | `contract` | Contract smoke only | Current Worker/batch flags; planned `VIBELINK_EVENT_STORE_RUST_SIDECAR` | Sync SQLite, optionally Node Worker with `VIBELINK_EVENT_STORE_WORKER=1` | Add `__health`/`stats`, implement real Rust `event-store-sidecar`, then wire explicit Rust flag with Worker/sync fallback. |
| Live audio low-latency pipeline | `planned` | Not implemented | Planned `VIBELINK_AUDIO_RUST_PIPELINE` | Existing live-call audio/ASR path | Define deterministic PCM preprocessing contract for level/peak/RMS/ring-buffer/backpressure; ASR stays out of first slice. |
| Compression and context budget helper | `planned` | Not implemented; conditional need | Planned `VIBELINK_RUST_COMPRESSION` | Existing Node/provider prompt construction | Only if needed, define deterministic byte/log sampling and budget trimming helper; do not claim semantic summarization or exact provider tokens. |

## Promotion gates

### Workspace tree scanner

Current state: Rust CLI and Node opt-in integration exist. Rust scanner covers fixed ignored directories, partial gitignore basename rules, truncation, signature output, and Node cache reuse.

Can move to `canary` only when:

- Node/Rust parity tests cover directories-first sorting, hidden file policy, fixed ignores, nested `.gitignore`, path-pattern `.gitignore`, truncation, signature/cache behavior, and missing-binary fallback.
- `VIBELINK_RUST_WORKSPACE_TREE=auto` or an equivalent safe-detection mode exists.
- Runtime stats include fallback count and last error.
- Any remaining gitignore semantic gap is explicitly listed as a blocker.

### Persistent MCP stdio sessions

Current state: Node manager, JSONL sidecar client, real Rust `mcp-session-sidecar`, opt-in runtime routing, contract tests, burst tests, timeout tests, and crash-replacement tests exist.

Can move to `canary` only when:

- `VIBELINK_MCP_RUST_SIDECAR=auto` or equivalent readiness detection exists.
- Tests cover spawn failure, tool-call failure, timeout, invalid JSON, and fallback without user-visible task failure.
- Runtime status exposes starts, failures, fallbacks, pending, terminated, and last error.
- Docs define spawn-reduction and fallback-rate thresholds for default-on.

### Event store append/replay sidecar

Current state: Node Worker boundary, event-store metrics, batchers, JSONL sidecar client, shared method allowlist, and JS fixture contract smoke exist. A real Rust event-store sidecar does not exist yet.

Can move to `opt-in` only when:

- `test/eventStoreSidecarContract.test.js` runs against a real Rust sidecar as well as the JS fixture.
- Rust and Node read/write the same SQLite DB fixtures with matching cursor and duplicate-event semantics.
- Unsupported methods return structured errors and do not crash the process.
- `src/db.js` exposes Rust sidecar mode and fallback stats.
- Missing binary, bad health, timeout, or request failure falls back to Worker or sync SQLite.

### Live audio low-latency pipeline

Current state: not implemented in Rust.

Can move to `contract` only when:

- A deterministic JSONL contract exists for synthetic PCM chunk processing.
- Tests assert level, peak, RMS, sequence accounting, and backpressure counters.
- The first slice explicitly excludes ASR and provider behavior.

Can move to `opt-in` only when:

- A real Rust sidecar exists behind `VIBELINK_AUDIO_RUST_PIPELINE=1`.
- Missing/failing sidecar falls back to the current Node live-call path.
- `npm run live-call:stream-levels` and `npm run live-call:qa-stress` remain viable smoke checks.

### Compression and context budget helper

Current state: not implemented; conditional need only.

Can move to `contract` only when:

- Deterministic fixtures exist for byte/log sampling and budget trimming.
- Docs state this is a data-plane helper, not semantic summarization.
- The contract avoids provider-token precision claims unless a tokenizer is explicitly introduced later.

## Verification bundle

Run this bundle before promoting any Rust status:

```bash
npm run rust:migration:check
node --test test/eventStoreSidecarContract.test.js
node --test test/eventStoreWorker.test.js
node --test test/eventStoreMetrics.test.js
node --test test/eventStoreBatcher.test.js
node --test test/workspacesRustTree.test.js
node --test test/mcpRuntime.test.js
node --test test/mcpSessionSidecarContract.test.js
cargo test --manifest-path apps/windows/Cargo.toml
cargo build --manifest-path apps/windows/Cargo.toml
```

Audio promotion also requires:

```bash
npm run live-call:stream-levels
npm run live-call:qa-stress
```
