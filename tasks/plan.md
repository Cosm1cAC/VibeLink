# Rust Migration Completion Plan

## Goal

Complete the repository's staged Rust migration without disturbing the concurrent Android/live-call validation. All remote operations use GitHub CLI, and every promoted slice must have contract, runtime, rollback, test, and CI evidence appropriate to its rollout state.

## Current State

- The three remote branch heads have been reconciled into `origin/main` through `gh api`.
- Event store, workspace tree, and persistent MCP sessions are at `canary` with passing Windows workflows.
- Workspace tree now has exact metadata/context parity across VibeLink, ok-wuthering-waves, and meetily after fixing locale-sensitive ordering; its process-per-miss cold penalty keeps it at `canary`.
- MCP now has a passing read-only real-session canary against the installed codebase-memory server; another server implementation is still required for broader evidence.
- Event store now has a write-rejecting read-only sidecar mode and exact replay evidence from the existing approximately 1.01GB database; human-driven append evidence remains outstanding.
- Audio remains `planned` and is temporarily excluded because another session is validating live call.
- Compression is now at `contract`; its bounded protocol is specified in `docs/compression-sidecar.md` and remains disconnected from production routing.
- Compression production routing is explicitly deferred: repeated Node hot-path p95 was 0.253-0.353ms on representative history and 0.425-0.547ms at the synthetic upper bound, far below the 10ms material-bottleneck threshold.

## Ordered Work

### Phase 1: Compression Contract

1. Define protocol constants and an independent JavaScript JSONL fixture.
2. Add failing cross-language contract tests for health, UTF-8 trimming, line sampling, errors, stats, and close.
3. Implement `vibelink compression-sidecar` in a dedicated Rust module.
4. Run focused Node/Rust tests, release build, migration checker, and broader Rust sidecar regression tests.
5. Promote only to `contract`, update docs, commit, and publish to `origin/main` with `gh api`.

### Phase 2: Remaining Non-Live Audit

1. Re-read the migration manifest and validate every claimed status against code, tests, workflows, and remote checks.
2. Identify any server-side gaps that can be closed without Android/live-call files.
3. Keep canary slices at canary until representative human/runtime evidence satisfies their default-on gates.

### Phase 3: Audio After Concurrent Validation

1. Reconcile the other session's live-call changes before editing audio paths.
2. Specify deterministic PCM level/peak/RMS and backpressure behavior.
3. Implement contract, fallback, opt-in, canary, and CI stages without moving ASR/provider logic into Rust.

## Risks And Mitigations

- Contract scope creep: keep semantic summaries and tokenizer claims explicitly out of compression v1.
- Main Rust file growth: put the implementation in `compression_sidecar.rs`; register only the CLI mode in `main.rs`.
- Cross-language drift: execute the same cases against an independent JavaScript fixture and real release binary.
- Concurrent live-call edits: do not touch Android, live-call, audio, or ASR files until that work is reconciled.
- Remote/local SHA divergence: verify tree equality and update remote `main` only through `gh` Git Data API.

## Verification Checkpoints

```powershell
node --test test/rustCompressionContract.test.js
cargo test --manifest-path apps/windows/Cargo.toml compression_sidecar
cargo test --manifest-path apps/windows/Cargo.toml
cargo build --release --manifest-path apps/windows/Cargo.toml
npm run rust:migration:check
```

Remote completion for each published slice requires the relevant GitHub Actions run to finish successfully on the resulting `origin/main` commit.
