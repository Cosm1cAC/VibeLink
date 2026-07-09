# Rust Migration TODO

Generated from `docs/rust-migration-status.json`. Keep this aligned with `npm run rust:migration:check`.

## Status automation

- [x] Add `docs/rust-migration-status.json` with all Rust migration slices.
- [x] Add `docs/rust-migration-status.md` with status table and promotion gates.
- [x] Add `tools/check-rust-migration-status.mjs`.
- [x] Add package scripts for Rust migration checks and focused test bundles.
- [ ] Link README and `docs/feature-gap-table.md` to `docs/rust-migration-status.md`.
- [ ] Add ADR for Node control plane + Rust data plane + sidecar-first + fallback-required.

## Slice next actions

- [ ] Workspace tree scanner (`opt-in`): add auto mode, parity gates, fallback counters, lastError stats, and either full gitignore path semantics or an explicit blocker before canary.
- [ ] Persistent MCP stdio sessions (`opt-in`): add auto mode, health readiness checks, promotion thresholds, and docs for spawn-reduction and fallback-rate gates before canary/default-on.
- [ ] Event store append/replay sidecar (`contract`): add `__health`/`stats` to the JSONL contract, implement real Rust `event-store-sidecar`, then wire `src/db.js` to prefer it under an explicit flag with Worker/sync fallback.
- [ ] Live audio low-latency pipeline (`planned`): define a bounded JSONL contract for deterministic PCM chunk preprocessing: level, peak, RMS, sequence accounting, ring-buffer/backpressure stats, `__health`, `stats`, and `__close`; do not move ASR into Rust in the first slice.
- [ ] Compression and context budget helper (`planned`): if needed, define a deterministic data-plane helper contract for byte/log sampling and budget trimming only; do not claim semantic summarization or provider-token precision.

## Verification

- [x] `node tools/check-rust-migration-status.mjs`
- [ ] `npm run rust:migration:check`
- [ ] `npm run rust:test`
- [ ] `npm run test:event-store`
- [ ] `npm run test:rust-sidecars`
