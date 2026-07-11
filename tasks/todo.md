# Rust Migration TODO

## Compression Contract

- [x] Specify the deterministic JSONL contract and explicit non-goals.
  - Acceptance: Methods, validation, outputs, errors, stats, and rollout boundary are documented.
  - Verify: Review `docs/compression-sidecar.md` against ADR-0001.
  - Files: `docs/compression-sidecar.md`
- [x] Add protocol constants and independent JavaScript fixture.
  - Acceptance: The fixture exposes protocol v1 with `trimUtf8`, `sampleLogLines`, and control methods.
  - Verify: Contract test can launch and query the fixture.
  - Files: `src/compressionContract.js`, `test/fixtures/compression-json-sidecar.js`
- [x] Write failing behavioral contract tests.
  - Acceptance: Tests cover multibyte head/tail trim, overlap-safe sampling, validation, stats, health, and close.
  - Verify: `node --test test/rustCompressionContract.test.js` fails because the Rust command is absent.
  - Files: `test/rustCompressionContract.test.js`
- [x] Implement the real Rust sidecar.
  - Acceptance: The release binary passes the same cases as the fixture with no production routing.
  - Verify: focused Node and Rust commands in `tasks/plan.md` pass.
  - Files: `apps/windows/src/compression_sidecar.rs`, `apps/windows/src/main.rs`
- [x] Promote the manifest to `contract` and update status docs.
  - Acceptance: Evidence and next action are accurate; feature flag remains non-required.
  - Verify: `npm run rust:migration:check`
  - Files: `docs/rust-migration-status.json`, `docs/rust-migration-status.md`, `README.md`
- [ ] Review, commit, and publish through GitHub CLI.
  - Acceptance: Tracked worktree is clean and remote tree equals the verified local tree.
  - Verify: `gh api repos/:owner/:repo/git/ref/heads/main` and GitHub Actions.

## Remaining Migration

- [ ] Audit all canary claims against current remote CI and runtime evidence.
- [ ] Advance any remaining server-side work that does not touch Android/live-call.
- [ ] Reconcile live-call changes before beginning the audio contract.
- [ ] Implement and stage the audio pipeline after concurrent testing completes.
- [ ] Prove every manifest promotion gate before declaring the full Rust migration goal complete.
