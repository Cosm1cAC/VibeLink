# Rust Migration Status

Last updated: 2026-07-11

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
| Workspace tree scanner | `canary` | Auto-mode canary with manual rollback flag | `VIBELINK_RUST_WORKSPACE_TREE`, `VIBELINK_RUST_BIN`, `VIBELINK_RUST_BIN_ARGS_JSON` | Node `listDirectory()` in `src/workspaces.js` | Run the real-repository canary on more repositories and address or accept the cold-route penalty before considering default-on. |
| Persistent MCP stdio sessions | `canary` | Auto-mode canary with manual rollback flag | `VIBELINK_MCP_RUST_SIDECAR`, `VIBELINK_MCP_RUST_SIDECAR_COMMAND`, `VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON`, `VIBELINK_MCP_SESSION_SIDECAR_MAX_ACTIVE_REQUESTS`, `VIBELINK_MCP_PERSISTENT_SESSIONS` | Existing Node stdio probe/call path in `src/mcpRuntime.js` | Run the real-session canary against another MCP server implementation before considering default-on. |
| Event store append/replay sidecar | `canary` | Auto readiness canary with manual rollback flag | `VIBELINK_EVENT_STORE_RUST_SIDECAR`, `VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND`, `VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON`, `VIBELINK_EVENT_STORE_RUST_SIDECAR_TIMEOUT_MS`, Worker/batch flags | Rust sidecar falls back to Node Worker when enabled, otherwise sync SQLite | Run limited human-driven real-session canaries with runtime stats capture before broader default exposure. |
| Live audio low-latency pipeline | `planned` | Not implemented | Planned `VIBELINK_AUDIO_RUST_PIPELINE` | Existing live-call audio/ASR path | Define deterministic PCM preprocessing contract for level/peak/RMS/ring-buffer/backpressure; ASR stays out of first slice. |
| Compression and context budget helper | `contract` | Contract-only; no production routing | Reserved `VIBELINK_RUST_COMPRESSION` | Existing Node compact/token-budget behavior remains authoritative | Measure whether Node compaction is a material bottleneck before considering an optional client and opt-in routing. |

## Promotion gates

### Workspace tree scanner

Current state: Rust CLI, Node opt-in/auto routing, root-directory routing, supported-subset parity, inherited and nested `.gitignore` handling, Windows metadata parity, Node-compatible locale/BFS result ordering, conservative Node fallback for truncated Rust subsets, signature/cache behavior, nested ignore-file invalidation, content-safe file-sample caching, fallback stats, isolated and real-repository canary harnesses, and an independent Windows CI gate exist. VibeLink, `ok-wuthering-waves`, and `meetily` all preserved exact tree/context parity, full warm cache reuse, and zero failures/fallbacks. Repeated runs on the two additional repositories measured Node at 56.3-94.9ms, Rust cold at 152.2-228.1ms, and Rust warm at 20.8-30.3ms, so the slice remains `canary` rather than `default-on`.

Can move to `default-on` only when:

- Representative auto-mode runs preserve exact Node/Rust path/type parity for the supported ignore-rule subset.
- Runs with an available command record zero Rust failures and fallbacks; missing-command auto mode falls back without recording a failure.
- Repeated unchanged scans reuse the Node-held Rust result without another CLI start, while nested `.gitignore` changes invalidate it.
- Cold and warm latency evidence is acceptable for interactive workspace context requests.
- The per-cache-miss CLI process, synchronous Node cache validation, bounded process-local cache, and incomplete full-Git ignore semantics remain explicitly documented in `docs/workspace-tree-rust.md`.
- The independent Windows canary status stays green and rollback with `VIBELINK_RUST_WORKSPACE_TREE=0` remains tested.

### Persistent MCP stdio sessions

Current state: Node manager, JSONL sidecar client, real Rust `mcp-session-sidecar`, auto readiness routing, contract/burst/timeout/crash/backpressure coverage, synthetic and real-session canary harnesses, and an independent Windows CI gate exist. The synthetic canary reduced MCP server spawns from 13 to 1. A 2026-07-11 `codebase-memory-mcp` session discovered 8 tools and completed 3 real `get_architecture` calls at 32.6ms average and 45.5ms max with one sidecar start, zero failures/fallbacks/backpressure/pending, and clean single-session drain.

Can move to `default-on` only when:

- Representative auto-mode runtime sessions preserve 0 readiness fallback after command availability, 0 sidecar backpressure under normal load, reduced stdio server spawns versus the non-persistent path, and clean pending drain.
- Tests cover spawn failure, readiness failure, tool-call failure, timeout, invalid JSON, and fallback without user-visible task failure.
- Runtime status exposes starts, failures, fallbacks, pending, terminated, and last error.
- Docs define spawn-reduction and fallback-rate thresholds for default-on.
- The independent Windows canary stays green and rollback with `VIBELINK_MCP_RUST_SIDECAR=0` remains tested.

### Event store append/replay sidecar

Current state: Node Worker boundary, event-store metrics, batchers, JSONL sidecar client, shared method allowlist, a real Rust `event-store-sidecar` command, read-only/query-only mode, contract and write-rejection coverage, explicit opt-in runtime routing, `auto` readiness, Worker/sync fallback tests, rollback docs, robust canary thresholds, local/runtime/server/real-data harnesses, and CI status wiring exist. A 2026-07-11 canary read the approximately 1.01GB existing database and preserved exact task/tool/live list, unified, and replay-window parity across 9 comparisons with zero failures/pending. Rust batch append avoids repeated owner lookups and uses `last_insert_rowid()` on the normal insert hot path.

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

Current state: protocol v1, shared JavaScript constants, an independent Node fixture, a real Rust `compression-sidecar` command, UTF-8-safe head/tail byte trimming, overlap-safe head/tail log sampling, structured errors, runtime stats, Rust unit tests, cross-language contract tests, a reproducible Node hot-path benchmark, and an independent Windows CI contract gate exist. Two 2026-07-11 runs measured the current Node production functions at 0.253-0.353ms combined p95 on the largest real task stream and 0.425-0.547ms p95 on a 1000-event/2,000,000-character synthetic upper bound, below the 10ms material-bottleneck threshold. The command therefore remains contract-only and does not perform semantic summarization or provider tokenization.

Can move to `opt-in` only when:

- Measurements show that current Node compact-input construction is a material bottleneck worth another process boundary.
- An optional Node client is gated by `VIBELINK_RUST_COMPRESSION=1` and falls back without changing current compact/token-budget behavior on missing command, bad health, timeout, invalid JSON, request failure, or sidecar exit.
- Runtime metrics expose starts, failures, fallbacks, request counts, bytes in/out, pending requests, and last error.
- Contract and fallback tests remain green, and docs continue to exclude semantic summarization and provider-token precision.

## Verification bundle

Run this bundle before promoting any Rust status:

```bash
npm run rust:migration:check
node --test test/eventStoreSidecarContract.test.js
node --test test/eventStoreRustRuntime.test.js
node --test test/eventStoreWorker.test.js
node --test test/eventStoreMetrics.test.js
node --test test/eventStoreBatcher.test.js
node --test test/eventStoreRealDataCanary.test.js
node --test test/workspacesRustTree.test.js
node --test test/workspaceTreeCanary.test.js
node --test test/workspaceTreeRealCanary.test.js
node --test test/mcpRuntime.test.js
node --test test/mcpSessionSidecarContract.test.js
node --test test/mcpSessionCanary.test.js
node --test test/mcpSessionRealCanary.test.js
node --test test/rustCompressionContract.test.js
cargo test --manifest-path apps/windows/Cargo.toml
cargo build --manifest-path apps/windows/Cargo.toml
npm run event-store:canary
npm run event-store:runtime-canary
npm run event-store:server-canary
npm run event-store:real-data-canary -- --limit 50
npm run compression:benchmark -- --require-real --output .tmp/compression-node-benchmark-final.json
npm run workspace-tree:canary
npm run workspace-tree:real-canary -- --workspace . --paths src,docs
npm run mcp-session:canary
npm run mcp-session:real-canary -- --calls 3
# or run the canary harnesses serially with CI output paths
npm run event-store:canary:all
```

Audio promotion also requires:

```bash
npm run live-call:stream-levels
npm run live-call:qa-stress
```
