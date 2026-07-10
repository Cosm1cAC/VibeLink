# ADR-0001: Rust Data Plane Sidecars

Date: 2026-07-09

## Status

Accepted

## Context

VibeLink needs lower-latency and lower-stall execution for high-frequency paths such as workspace scanning, event append/replay, MCP stdio session reuse, live audio preprocessing, and future compression/context-budget helpers. At the same time, the existing Node bridge owns the product control plane: HTTP APIs, settings, security policy, device pairing, provider orchestration, approvals, REST/SSE routes, and frontend delivery.

A full rewrite would risk breaking mobile/Web API compatibility, pairing/security semantics, event recovery, and provider behavior. The repository already has successful Rust vertical slices in `apps/windows`: the Windows launcher, `workspace-tree`, and `mcp-session-sidecar`.

## Decision

Use a hybrid architecture:

- **Node control plane:** product state, HTTP routes, security, approvals, provider orchestration, REST/SSE, and compatibility contracts remain in Node.
- **Rust data plane:** high-frequency or low-latency work moves into Rust one vertical slice at a time.
- **Sidecar first:** Rust modules are introduced as CLI/JSONL sidecars before any native addon or deeper embedding.
- **Fallback required:** every production Rust path must fall back to the existing Node or Worker path when the binary is missing, startup fails, health checks fail, requests time out, responses are invalid, or the sidecar exits.
- **Contract first:** Node and Rust communicate through stable JSON contracts. Tests must run the same contract against fixtures and real Rust sidecars before production routing is promoted.
- **Status-gated promotion:** slice states are tracked in `docs/rust-migration-status.json` and checked by `npm run rust:migration:check` before docs or rollout status are changed.

## Consequences

### Positive

- Rust can improve hot paths without destabilizing the bridge API.
- Each migration slice has measurable acceptance criteria and rollback behavior.
- Android/Web clients continue using stable HTTP/SSE contracts.
- Missing Rust toolchains or binaries do not break normal local development.

### Negative

- Sidecars add process lifecycle and JSON protocol overhead.
- `apps/windows` can grow large if sidecar code is not later split into modules.
- Every slice needs duplicate compatibility tests across Node and Rust paths.

## Implementation rules

1. New Rust slices must start as `planned` or `contract` in `docs/rust-migration-status.json`.
2. A slice cannot become `opt-in` until a real Rust implementation exists and fallback tests pass.
3. A slice cannot become `canary` until auto/safe detection, runtime stats, failure-mode tests, and rollback docs exist.
4. A slice cannot become `default-on` until measured canary behavior shows no correctness regression and CI/status checks cover it.
5. Planned audio work must initially cover only deterministic PCM preprocessing; ASR/provider behavior remains outside the first Rust slice.
6. Planned compression work must initially cover only deterministic data-plane helpers; it must not claim semantic summarization or provider-token precision without a dedicated tokenizer/model design.

## Related files

- `docs/rust-migration-status.json`
- `docs/rust-migration-status.md`
- `tools/check-rust-migration-status.mjs`
- `apps/windows/src/main.rs`
- `src/workspaces.js`
- `src/mcpRuntime.js`
- `src/db.js`
- `src/eventStoreSidecarClient.js`
