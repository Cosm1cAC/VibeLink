# VibeLink Rust Control-Plane Migration Plan

## Overview

Migrate VibeLink from the current Node control plane plus Rust data-plane sidecars to a Rust-owned HTTP control plane through reversible vertical slices. The immediate milestone is to deploy the current Rust status assembler, collect authenticated public-canary evidence, and promote it only when failure, fallback, timeout, pending, and backpressure counters remain zero. Later route families follow the same contract-first and canary-first process.

## Architecture Decisions

- Preserve the current OpenAPI and Web/Android HTTP/SSE contracts throughout the migration.
- Keep Node as an automatic fallback until the matching Rust route has representative production evidence and zero Node route usage.
- Migrate one route family at a time in this order: `status/doctor`, `pairing/device`, `settings/audit`, `workspace/tool`, then `task/live-call`.
- Keep the unconnected Audio and Compression performance sidecars at `contract` unless telemetry justifies them, while still migrating every product-required live-call/audio responsibility needed to remove bundled Node.
- Build and deploy the portable Windows package from a reproducible commit; archive the commit, checksum, canary output, and rollback command together.

## Task 1: Public Status Canary

**Description:** Add a secret-safe canary that exercises the real public `/api/status` route with anonymous and device-token requests, measures latency, and verifies Rust runtime deltas.

**Acceptance criteria:**

- [x] Anonymous requests return `401` and authenticated requests return `200`.
- [x] Rust attempts and responses increase together with zero fallback, failure, timeout, pending, or backpressure counts.
- [x] The JSON artifact contains no credential and fails when the latency or runtime thresholds are exceeded.

**Verification:**

- [x] Red/green Node tests cover healthy and degraded runtime evidence.
- [x] `npm run status:public-canary -- --base-url <url> --output <path>` passes against the deployed bridge.

**Dependencies:** None.

**Files likely touched:** `tools/status/public-canary.mjs`, `test/statusPublicCanary.test.js`, `package.json`.

**Estimated scope:** Medium.

## Task 2: Reproducible Canary Deployment

**Description:** Build the Rust launcher and portable package from the current commit, enable the Status opt-in only for the supervised bridge process, and preserve an immediate Node fallback.

**Acceptance criteria:**

- [x] Rust and Node focused tests pass before the running public process changes.
- [x] Tunnel `--check-only`, package checksum, release-manifest commit, and local health checks pass.
- [ ] A restart failure restores the previous Node bridge and public route.

**Verification:**

- [x] `npm run status:contract`, Rust status tests, and authenticated server canary pass.
- [x] Public root returns `200`, anonymous status returns `401`, and the authenticated public canary passes.

**Dependencies:** Task 1.

**Files likely touched:** `tools/windows/package-portable.ps1`, deployment evidence under `.tmp/`, and release documentation.

**Estimated scope:** Medium.

## Task 3: Promote Existing Data-Plane Canaries

**Description:** Collect representative Workspace, MCP, and Event Store production evidence before changing their defaults.

**Acceptance criteria:**

- [x] Workspace representative public sessions show parity and zero fallback.
- [x] MCP controlled real/soak sessions show stable reuse, zero readiness fallback, and drained pending work.
- [ ] MCP natural production sessions sustain the same result over the observation window.
- [x] Event Store real-data and public command sessions meet correctness and latency thresholds with zero fallback.

**Verification:**

- [x] Existing Workspace, MCP, and Event Store canary commands pass and archive evidence.
- [x] Each promote-or-hold decision updates `docs/rust-migration-status.json` and the migration report.

**Dependencies:** Task 2.

**Files likely touched:** existing sidecar clients, canary tools, migration status and report.

**Estimated scope:** Large; execute as three independent medium slices.

## Task 4: Rust Status And Doctor HTTP Routes

**Description:** Move direct HTTP handling for `/api/status`, `/api/doctor`, and the read-only device list into Rust while Node continues supplying not-yet-migrated routes through the loopback fallback.

**Acceptance criteria:**

- [x] An explicit Rust front-door canary owns the external listener while Node binds only to an ephemeral loopback port.
- [x] Transparent forwarding preserves HTTP, SSE, WebSocket, Host, authentication, and shutdown behavior for non-migrated routes.
- [x] Rust directly owns authentication, validation, response serialization, and HTTP status codes for Status, Doctor, and device-list requests.
- [x] Contract fixtures match the current Node responses and failure semantics.
- [x] Separate feature flags switch the front door and each direct route immediately back to Node.

**Verification:**

- [x] OpenAPI contract, anonymous/authenticated route tests, malformed-input tests, and failure injection pass.
- [x] Public anonymous canaries pass; authenticated device-list evidence is verified locally because no production plaintext device token is retained.

**Dependencies:** Tasks 2 and 3 evidence foundation.

**Files likely touched:** `apps/windows/src/`, `src/server.js`, status runtime/client, tests, and OpenAPI generation.

**Estimated scope:** Large; split front door, Status, and Doctor into separate commits.

## Task 5: Identity And Administrative Routes

**Description:** Migrate identity and administration in four independently reversible slices: audited device mutations, pairing lifecycle, settings validation/mutation, then audit queries.

**Acceptance criteria:**

- [ ] Pairing, approval, token rotation/revocation, settings validation, and audit writes preserve current contracts.
- [ ] Security tests cover replay, expiry, invalid hosts, rate limits, and secret redaction.
- [ ] Node fallback remains independently deployable until production canaries pass.
- [ ] Device mutations never replay to Node after a Rust transaction commits; only pre-commit failures may use the loopback fallback.
- [ ] Token plaintext is returned exactly once, never logged or stored, while only SHA-256 hashes reach SQLite.

**Verification:**

- [ ] Contract suites pass against both implementations.
- [ ] Staged public canaries pass at each route-family boundary.

**Dependencies:** Task 4.

**Files likely touched:** Rust HTTP modules, Node route adapters, security/store modules, tests, and OpenAPI.

**Execution order:**

1. `POST /api/devices/current/rotate`, `POST /api/devices/:id/rotate`, and `POST /api/devices/:id/revoke`.
2. Pairing session create/status/claim/approve/deny routes.
3. Settings read, validation, dry-run, and mutation routes.
4. Audit-log reads, pagination, and field projection.

**Estimated scope:** Large; execute as four medium slices with a commit, contract archive, package, and rollback flag per slice.

## Task 6: Workspace And Tool Routes

**Description:** Migrate workspace browsing, Git/command orchestration, approvals, tool registry/runs, and tool-event streams without weakening filesystem or command safety.

**Acceptance criteria:**

- [ ] Allowed-root, path traversal, command-risk, approval, cancellation, and SSE replay behavior remain equivalent.
- [ ] Rust reuses promoted Workspace/Event Store paths rather than duplicating implementations.
- [ ] All mutating routes retain dry-run and audit guarantees.

**Verification:**

- [ ] Contract, security, real-repository, Git, command, SSE, and rollback tests pass.
- [ ] Production canary records zero correctness mismatches and zero unrecovered failures.

**Dependencies:** Tasks 3 and 5.

**Files likely touched:** Rust HTTP/workspace/tool modules, Node adapters, tests, and OpenAPI.

**Execution order:** read-only workspace/tree routes; tool and command registries; approvals; dry-run and command execution; Git actions; tool runs/events and SSE replay.

**Estimated scope:** Large; split by read-only, registry, approval, Git/command, and event slices.

## Task 7: Task And Live-Call Routes

**Description:** Migrate task/history/terminal lifecycle, unified event streaming, provider orchestration boundaries, and live-call sessions after lower-level identity, tool, and event routes are stable.

**Acceptance criteria:**

- [ ] Start/resume/stop/recovery and live-call replay preserve task and event ordering.
- [ ] Provider subprocess failure and bridge restart behavior remain recoverable within current product limits.
- [ ] Android and Web clients require no migration-specific changes.

**Verification:**

- [ ] Task, provider, SSE, event replay, and live-call suites pass against both implementations.
- [ ] Long-running public canary meets error and latency thresholds with rollback ready.

**Dependencies:** Task 6.

**Files likely touched:** Rust task/live-call modules, Node provider adapters, tests, and OpenAPI.

**Execution order:** task/history reads; task mutations; terminal sessions; unified SSE; provider processes; live-call HTTP; live-call WebSocket/audio.

**Estimated scope:** Large; split by task lifecycle, terminals/events, providers, and live-call.

## Task 8: Retire Node And Ship Native Shell

**Description:** Remove Node route implementations only after usage reaches zero, then replace the console launcher with a native Win32 tray/window shell and publish a reproducible desktop release. Do not add a WebView or Web administration dashboard.

**Acceptance criteria:**

- [ ] Every migrated route reports zero Node fallback and zero Node ownership for the full observation window.
- [ ] Portable package no longer includes Node only after all route families and provider boundaries no longer require it.
- [ ] Native tray/window startup, shutdown, pairing, doctor, updates, and rollback are verified on Windows.
- [ ] Idle and active Private Working Set measurements meet the native-shell budget without an embedded browser process.

**Verification:**

- [ ] Full Node/Rust contract archive, desktop smoke tests, package provenance, checksum, and public canary pass.
- [ ] Release tag, changelog, rollback artifact, and recovery instructions are published.

**Dependencies:** Tasks 4-7.

**Files likely touched:** launcher UI, packaging, release workflow, documentation, and retired Node modules.

**Estimated scope:** Large; execute removal and native-shell work as separate releases.

## Checkpoints

### Public Status Canary

- [x] Focused tests and Rust migration manifest pass.
- [x] Reproducible package and rollback artifact exist.
- [x] Public authenticated evidence passes with zero Rust fallback.

### Route Family Promotion

- [ ] Both implementations pass the same contract suite.
- [ ] Canary error rate stays within 10% and p95 within 20% of baseline.
- [ ] Rollback is tested before advancing ownership.

### Mutation Safety

- [ ] Every write uses a SQLite transaction containing the domain write and audit record.
- [ ] Pre-commit failures may fall back; post-commit failures return a Rust error and never replay the request.
- [ ] Rate limits, idempotency expectations, dry-run behavior, and secret redaction match Node.
- [ ] Failure-injection tests prove both sides of the commit boundary.

### Node Retirement

- [ ] Node route usage is zero for the agreed observation window.
- [ ] Full tests, package, desktop smoke, public canary, and recovery drill pass.
- [ ] Documentation, release manifest, changelog, and tag match the shipped commit.

## Rollback Strategy

- Status canary rollback: unset `VIBELINK_RUST_STATUS` and restart the supervised bridge.
- Direct-route rollback: disable the route-family Rust ownership flag and restore Node routing.
- Deployment rollback: stop the new supervised processes, start the previous verified package, then verify local and public health.
- Data-plane rollback: retain the existing Rust-to-Worker-to-sync or Rust-to-Node fallback chains until the observation window completes.

## Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Public deployment runs a stale commit | High | Compare process start, release manifest commit, HEAD, and public canary artifact on every deploy. |
| Rust and Node contracts drift | High | Execute shared fixtures against both implementations and regenerate OpenAPI only from reviewed contracts. |
| Authentication regression exposes local data | Critical | Keep anonymous checks, fixed-host Tunnel validation, device-token tests, and immediate Node rollback. |
| Sidecar boundaries add latency without value | Medium | Require measured p95 improvement or operational benefit before promotion. |
| Removing Node breaks provider integrations | High | Track provider/runtime ownership separately from HTTP route ownership and remove Node last. |

## Open Questions

- The observation window for each `default-on` and Node-removal promotion must be set from actual request volume; until then use at least one representative interactive session plus the scheduled canary evidence.
