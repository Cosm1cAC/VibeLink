# Rust Migration Completion Plan

## Goal

Complete the repository's staged Rust migration without disturbing the concurrent Android/live-call validation. All remote operations use GitHub CLI, and every promoted slice must have contract, runtime, rollback, test, and CI evidence appropriate to its rollout state.

## Current State

- Pull requests #1 (`codex/mcp-sidecar-concurrency`), #2 (`codex/workspace-rust-ignore-paths`), and #3 (`codex/event-store-rust-sidecar`) are merged into `main`; `gh pr list --state open` is empty.
- Event store, workspace tree, and persistent MCP sessions are at `canary` with passing Windows workflows.
- Workspace tree now has exact metadata/context parity across VibeLink, ok-wuthering-waves, and meetily plus a persistent Rust sidecar that keeps cold totals at 53.7-80.3ms with one process and zero session fallback; it remains limited `canary` pending remote/interactive evidence.
- Workspace Tree and Event Store remote canaries now run weekly at staggered UTC times and retain JSON evidence for 30 days; interactive/human promotion gates remain separate.
- MCP now has passing read-only real-session canaries against codebase-memory and Headroom. Both reused one Rust sidecar with zero failures, fallbacks, backpressure, or pending work and clean session drain.
- MCP now also has a five-session auto-mode soak: 65 baseline spawns fell to 5, all sessions drained cleanly, health counters stayed at zero, and scheduled Windows CI repeats it weekly.
- The Rust Windows bridge now injects its current executable as the packaged MCP/event/workspace sidecar command while preserving deployment overrides, removing the development-target path dependency.
- Event store now has a write-rejecting read-only sidecar mode and exact replay evidence from the existing approximately 1.01GB database; human-driven append evidence remains outstanding.
- Audio is now `contract` through an isolated PCM16 Rust sidecar and cross-language tests; it remains disconnected from production because another session is validating live call.
- Audio RMS benchmarking measured Node p95 at 0.003-0.008ms and Rust JSONL p95 at 0.189-0.356ms for 10/20/100ms frames with exact numeric parity and healthy counters, so RMS-only production routing is not justified.
- Compression is now at `contract`; its bounded protocol is specified in `docs/compression-sidecar.md` and remains disconnected from production routing.
- Compression production routing is explicitly deferred: repeated Node hot-path p95 was 0.253-0.353ms on representative history and 0.425-0.547ms at the synthetic upper bound, far below the 10ms material-bottleneck threshold.
- Audio protocol v1, the independent Node fixture, the Rust sidecar, cross-language tests, and its Windows CI gate are published at `contract`; no Android or production live-call path was changed.

## Ordered Work

### Phase 1: Compression Contract

1. Define protocol constants and an independent JavaScript JSONL fixture.
2. Add failing cross-language contract tests for health, UTF-8 trimming, line sampling, errors, stats, and close.
3. Implement `vibelink compression-sidecar` in a dedicated Rust module.
4. Run focused Node/Rust tests, release build, migration checker, and broader Rust sidecar regression tests.
5. Promote only to `contract`, update docs, commit, and publish to `origin/main` with `gh api`.

### Phase 2: Remaining Non-Live Audit

1. Re-read the migration manifest and validate every claimed status against code, tests, workflows, and remote checks. Completed 2026-07-11.
2. Identify and close server-side gaps that do not touch Android/live-call files. Completed through the persistent workspace sidecar, real event-store replay, real MCP session, compression benchmark, and isolated audio contract.
3. Keep canary slices at canary until representative human/runtime evidence satisfies their default-on gates. This remains an external promotion boundary, not an unimplemented server-side task.

### Phase 3: Audio After Concurrent Validation

1. Reconcile the other session's live-call changes before editing audio paths.
2. Specify deterministic PCM level/peak/RMS and backpressure behavior. Completed at contract status without production routing.
3. After reconciliation, measure representative PCM workloads and implement the optional bounded client, fallback metrics, opt-in routing, and canary without moving ASR/provider logic into Rust.

## Evidence Audit (2026-07-11)

- Local: `npm run test:rust-sidecars` passed 75/75; `cargo fmt --check`, Clippy with `-D warnings`, release build, focused live-call audio regressions, and `npm run rust:migration:check` passed.
- Remote commit `64db347f31847b02b388a2da09820786d08da7e2`: Audio Pipeline Rust Contract `29145867540`, MCP Session Rust Canary `29145867538`, Event Store Rust Canary `29145867560`, Workspace Tree Rust Canary `29145867534`, and Compression Rust Contract `29145867536` all completed successfully.
- Remote tree `8ee19abff2d782de36fef5a7c76baab8860ba7f0` exactly matches the verified local audio-contract commit tree.
- Remaining default-on/opt-in gates require evidence or integration work that this slice does not manufacture: a human-driven event append session, representative interactive workspace sessions, sustained MCP auto-mode monitoring, and reconciliation with the concurrent live-call work before audio production routing.

## Risks And Mitigations

- Contract scope creep: keep semantic summaries and tokenizer claims explicitly out of compression v1.
- Main Rust file growth: put the implementation in `compression_sidecar.rs`; register only the CLI mode in `main.rs`.
- Cross-language drift: execute the same cases against an independent JavaScript fixture and real release binary.
- Concurrent live-call edits: keep the isolated audio contract disconnected; do not touch Android, production live-call, or ASR files until that work is reconciled.
- Remote/local SHA divergence: verify tree equality and update remote `main` only through `gh` Git Data API.

## Verification Checkpoints

```powershell
node --test test/rustCompressionContract.test.js
node --test test/rustAudioPipelineContract.test.js
cargo test --manifest-path apps/windows/Cargo.toml compression_sidecar
cargo test --manifest-path apps/windows/Cargo.toml
cargo build --release --manifest-path apps/windows/Cargo.toml
npm run rust:migration:check
```

Remote completion for each published slice requires the relevant GitHub Actions run to finish successfully on the resulting `origin/main` commit.
