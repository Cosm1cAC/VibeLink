# Rust Migration Implementation Plan

## Goal

Turn the Rust migration from scattered slice work into a repeatable program with a single status source, automatic drift checks, and ordered implementation tasks. The architecture stays Node control plane + Rust data plane + sidecar-first + fallback-required.

## Current state

- Workspace tree scanner: real Rust command exists and is opt-in through `VIBELINK_RUST_WORKSPACE_TREE`.
- MCP persistent sessions: real Rust `mcp-session-sidecar` exists and is opt-in through `VIBELINK_MCP_RUST_SIDECAR`.
- Event store: Node Worker, batchers, metrics, and JSONL sidecar contract exist; real Rust event-store sidecar is missing.
- Live audio pipeline: planned only.
- Compression adapter: planned only and conditional.

## Ordered phases

### Phase 1: Status automation

1. Maintain `docs/rust-migration-status.json` as the machine-readable source of truth.
2. Maintain `docs/rust-migration-status.md` as the human-readable table.
3. Run `npm run rust:migration:check` before promoting any Rust slice.
4. Keep README and feature-gap docs linked to the status table.

### Phase 2: Event-store Rust sidecar

1. Add `__health` and `stats` to the event-store JSONL contract.
2. Implement `vibelink event-store-sidecar --db <path>` in `apps/windows`.
3. Run contract tests against both the JS fixture and the real Rust sidecar.
4. Wire `src/db.js` to prefer Rust only under `VIBELINK_EVENT_STORE_RUST_SIDECAR=1`, with Worker/sync fallback.
5. Add runtime stats for starts, failures, fallbacks, pending, and last error.

### Phase 3: Promotion gates for existing Rust slices

1. Add `auto`/safe-detection mode for workspace tree.
2. Add parity tests for Node/Rust workspace tree behavior.
3. Add `auto`/readiness mode for MCP Rust sidecar.
4. Add fallback and failure-mode tests before canary/default-on.

### Phase 4: Bounded first contracts for planned slices

1. Define an audio JSONL contract for deterministic PCM chunk preprocessing only: level, peak, RMS, sequence accounting, and backpressure stats.
2. Define a compression helper contract only if needed: deterministic byte/log sampling and budget trimming, not semantic summarization.

### Phase 5: Verification bundle

Run before status promotion:

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
