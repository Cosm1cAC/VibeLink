# VibeLink Rust Control-Plane Migration

## Public Status Milestone

- [x] Audit the current Status sidecar, route canary, public process, Tunnel, and package state.
- [x] Write the staged migration, verification, and rollback plan.
- [x] Add a failing test for public Status runtime evidence.
- [x] Implement the public authenticated Status canary.
- [x] Add degraded-runtime and latency-threshold coverage.
- [x] Run Status Node/Rust contract and server-route verification.
- [x] Hide pairing tokens from startup logs after device pairing.
- [x] Build a portable package from the current commit and verify its manifest/checksum.
- [x] Preflight the named Tunnel and preserve the current rollback commands.
- [x] Restart the public bridge with `VIBELINK_RUST_STATUS=1` under the Rust launcher.
- [x] Run and archive the authenticated public canary.
- [x] Review, stage, commit, and push the verified milestone.

## Existing Data-Plane Promotions

- [x] Collect representative Workspace interactive-session evidence.
- [x] Collect controlled real-server and soak MCP evidence.
- [ ] Collect representative MCP natural-session evidence.
- [x] Collect Event Store real-session runtime statistics.
- [x] Evaluate every slice against parity, latency, and zero-fallback gates without premature promotion.
- [x] Add, package, deploy, and verify the explicit `--rust-canary` launcher profile.

## Rust HTTP Ownership

- [x] Add an opt-in Rust external front door with a loopback-only Node backend.
- [x] Verify transparent HTTP, SSE, WebSocket, authentication, and shutdown parity.
- [x] Migrate direct `/api/status` HTTP ownership behind a rollback flag.
- [x] Migrate direct `/api/doctor` HTTP ownership behind a rollback flag.
- [x] Migrate read-only `GET /api/devices` ownership behind an independent Rust flag.
- [x] Migrate audited device mutation routes with transaction-bound fallback semantics.
- [x] Migrate pairing status/list/approve/deny routes.
- [ ] Migrate pairing create/claim routes with bounded JSON bodies and one-time token safety.
- [ ] Migrate settings read, validation, dry-run, and mutation routes.
- [ ] Migrate audit-log read, pagination, and field-projection routes.
- [ ] Migrate workspace read/tree and registry routes.
- [ ] Migrate approvals, commands, Git actions, and tool-run routes.
- [ ] Migrate tool-event and unified-event SSE streams.
- [ ] Migrate task, history, and terminal routes.
- [ ] Migrate provider-process ownership out of Node.
- [ ] Migrate live-call HTTP and WebSocket/audio routes.

## Retirement And Desktop Release

- [ ] Confirm zero Node route ownership and fallback during the observation window.
- [ ] Remove retired Node route implementations in reversible slices.
- [ ] Remove bundled Node only after provider/runtime ownership permits it.
- [ ] Replace the console surface with a native Win32 `windows-rs` tray/window without WebView/HTML.
- [ ] Measure idle and active native GUI Private Working Set.
- [ ] Publish a tagged, checksummed, reproducible desktop release with rollback instructions.
