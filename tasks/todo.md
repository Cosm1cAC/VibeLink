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
- [ ] Review, stage, commit, and push the verified milestone.

## Existing Data-Plane Promotions

- [ ] Collect representative Workspace interactive-session evidence.
- [ ] Collect representative MCP natural-session evidence.
- [ ] Collect Event Store real-session runtime statistics.
- [ ] Promote only slices meeting parity, latency, and zero-fallback gates.

## Rust HTTP Ownership

- [ ] Migrate direct `/api/status` HTTP ownership behind a rollback flag.
- [ ] Migrate direct `/api/doctor` HTTP ownership behind a rollback flag.
- [ ] Migrate pairing and device routes.
- [ ] Migrate settings and audit routes.
- [ ] Migrate workspace and tool routes.
- [ ] Migrate task and live-call routes.

## Retirement And Desktop Release

- [ ] Confirm zero Node route ownership and fallback during the observation window.
- [ ] Remove retired Node route implementations in reversible slices.
- [ ] Remove bundled Node only after provider/runtime ownership permits it.
- [ ] Replace the console surface with a native Windows tray/window.
- [ ] Publish a tagged, checksummed, reproducible desktop release with rollback instructions.
