# Rust Migration Status

Last updated: 2026-07-10

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
| Workspace tree scanner | `opt-in` | Manual flag plus auto safe-detection | `VIBELINK_RUST_WORKSPACE_TREE`, `VIBELINK_RUST_BIN`, `VIBELINK_RUST_BIN_ARGS_JSON` | Node `listDirectory()` in `src/workspaces.js` | Finish the remaining parity gates and document the long-lived scanner/cache limitations before canary. |
| Persistent MCP stdio sessions | `opt-in` | Manual flag plus auto safe-detection | `VIBELINK_MCP_RUST_SIDECAR`, `VIBELINK_MCP_RUST_SIDECAR_COMMAND`, `VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON`, `VIBELINK_MCP_SESSION_SIDECAR_MAX_ACTIVE_REQUESTS`, `VIBELINK_MCP_PERSISTENT_SESSIONS` | Existing Node stdio probe/call path in `src/mcpRuntime.js` | Run representative runtime canaries and capture spawn-reduction/fallback-rate evidence before canary/default-on. |
| Event store append/replay sidecar | `canary` | Auto readiness canary with manual rollback flag | `VIBELINK_EVENT_STORE_RUST_SIDECAR`, `VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND`, `VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON`, `VIBELINK_EVENT_STORE_RUST_SIDECAR_TIMEOUT_MS`, Worker/batch flags | Rust sidecar falls back to Node Worker when enabled, otherwise sync SQLite | Run limited human-driven real-session canaries with runtime stats capture before broader default exposure. |
| Live audio low-latency pipeline | `planned` | Not implemented | Planned `VIBELINK_AUDIO_RUST_PIPELINE` | Existing live-call audio/ASR path | Define deterministic PCM preprocessing contract for level/peak/RMS/ring-buffer/backpressure; ASR stays out of first slice. |
| Compression and context budget helper | `planned` | Not implemented; conditional need | Planned `VIBELINK_RUST_COMPRESSION` | Existing Node/provider prompt construction | Only if needed, define deterministic byte/log sampling and budget trimming helper; do not claim semantic summarization or exact provider tokens. |

## Promotion gates

### Workspace tree scanner

Current state: Rust CLI and Node opt-in integration exist. Rust scanner covers fixed ignored directories, root and nested gitignore basename/wildcard/directory rules, path-pattern rules, negation rules, truncation, signature output, Node cache reuse, `VIBELINK_RUST_WORKSPACE_TREE=auto` safe-detection, and runtime stats for mode, availability, fallbacks, failures, and last error.

Can move to `canary` only when:

- Remaining Node/Rust parity tests cover directories-first sorting, hidden file policy, fixed ignores, nested `.gitignore`, path-pattern `.gitignore`, truncation, signature/cache behavior, and missing-binary fallback.
- Any remaining gitignore semantic gap or long-lived scanner/cache limitation is explicitly listed as a blocker.

### Persistent MCP stdio sessions

Current state: Node manager, JSONL sidecar client, real Rust `mcp-session-sidecar`, opt-in runtime routing, `VIBELINK_MCP_RUST_SIDECAR=auto` safe-detection, stats readiness checks, contract tests, burst tests, timeout tests, crash-replacement tests, in-flight stats, and sidecar-level active-request backpressure exist.

Can move to `canary` only when:

- Representative auto-mode runtime sessions preserve 0 readiness fallback after command availability, 0 sidecar backpressure under normal load, reduced stdio server spawns versus the non-persistent path, and clean pending drain.
- Tests cover spawn failure, readiness failure, tool-call failure, timeout, invalid JSON, and fallback without user-visible task failure.
- Runtime status exposes starts, failures, fallbacks, pending, terminated, and last error.
- Docs define spawn-reduction and fallback-rate thresholds for default-on.

### Event store append/replay sidecar

Current state: Node Worker boundary, event-store metrics, batchers, JSONL sidecar client, shared method allowlist, a real Rust `event-store-sidecar` command, real Rust contract coverage, explicit opt-in runtime routing, `auto` readiness mode, a health gate, runtime stats, Worker/sync fallback tests, rollback docs, canary thresholds, local/runtime/server canary harnesses, CI canary status wiring, and passing 2026-07-10 representative release canaries exist. Rust batch append now avoids repeated owner lookups and uses `last_insert_rowid()` on the normal insert hot path.

Can move to `default-on` only when:

- Canary metrics stay within the documented latency, fallback-rate, and main-thread stall thresholds across representative local, runtime, and server sessions.
- Limited real-session canaries preserve 0 fallback/failure/backpressure and clean pending drain after readiness.
- CI or release status checks run the event-store contract/runtime tests plus the local, runtime, and server canary harnesses.
- `src/db.js` route-level tests continue to cover spawn failure, bad health, timeout, invalid JSON, sidecar exit, request failure, and Worker/sync fallback without task-visible failure.
- Runtime status continues to expose starts, failures, fallbacks, pending, terminated, ready/failed state, last error, and mode counts for Rust, Worker, and sync fallback.
- Rollback remains tested and documented with `VIBELINK_EVENT_STORE_RUST_SIDECAR=0`.

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
node --test test/eventStoreRustRuntime.test.js
node --test test/eventStoreWorker.test.js
node --test test/eventStoreMetrics.test.js
node --test test/eventStoreBatcher.test.js
node --test test/workspacesRustTree.test.js
node --test test/mcpRuntime.test.js
node --test test/mcpSessionSidecarContract.test.js
cargo test --manifest-path apps/windows/Cargo.toml
cargo build --manifest-path apps/windows/Cargo.toml
npm run event-store:canary
npm run event-store:runtime-canary
npm run event-store:server-canary
# or run the canary harnesses serially with CI output paths
npm run event-store:canary:all
```

Audio promotion also requires:

```bash
npm run live-call:stream-levels
npm run live-call:qa-stress
```
