# VibeLink Windows

Rust launcher, sidecar host, portable desktop package, and public-tunnel supervisor.

## User entry

```powershell
vibelink.exe
```

The default mode starts the packaged or development bridge, waits for the HTTP API, then creates an Android pairing QR. Packaged builds prefer `runtime/node.exe`; `VIBELINK_NODE_COMMAND` remains an explicit override and development falls back to `node` on PATH.

Use the explicit canary profile to enable the currently promoted Rust Status, Workspace, MCP, and Event Store paths while preserving every existing environment override and Node/Worker fallback:

```powershell
vibelink.exe --rust-canary
```

Portable packages also include `start-vibelink-canary.cmd`. The normal `vibelink.exe` and `start-vibelink.cmd` entry points remain conservative and do not enable canary routes.

Use the separate HTTP front-door canary only when validating control-plane migration:

```powershell
vibelink.exe --rust-canary --rust-http-canary
```

`start-vibelink-http-canary.cmd` provides the same packaged entry. Rust owns the configured external TCP listener and binds Node to an ephemeral `127.0.0.1` port. Non-migrated HTTP, SSE, and WebSocket streams are forwarded byte-for-byte; disabling `--rust-http-canary` restores direct Node listening. The front door does not yet mean Status or Doctor route logic is fully Rust-owned.

Use `--rust-status-http` with the front-door flag, or run `start-vibelink-status-http-canary.cmd`, to let Rust own `GET /api/status` authentication and responses while Node supplies the protected loopback snapshot. Disabling only `--rust-status-http` restores transparent Node routing for Status.

Use `--rust-doctor-http` with the front-door flag, or run `start-vibelink-doctor-http-canary.cmd`, to let Rust own `GET /api/doctor` Host validation, device authentication, and HTTP responses. Node keeps the protected diagnostic executor so the existing checks, tool run, and audit records remain unchanged. The Doctor flag can be disabled independently.

Use `--rust-devices-http` with the front-door flag to let Rust own the read-only `GET /api/devices` route directly from SQLite. Device rotation/revocation and Pairing are independently reversible through `--rust-device-mutations-http` and `--rust-pairing-http`; the cumulative packaged launchers enable each promoted family in order.

Use `--rust-settings-http` with the front-door flag, or run `start-vibelink-settings-http-canary.cmd`, to let Rust own Settings update, export, and import. Rust performs validation, dry runs, atomic file replacement, DPAPI credential writes, public projection, and audit records. During the hybrid phase, a protected loopback reload keeps the remaining Node routes on the same in-memory settings; disabling the flag restores Node ownership for subsequent requests.

Use `--rust-workspace-http` with the front-door flag to let Rust own authenticated `POST /api/workspaces/:id/file` write, delete, and rename operations. The route enforces SQLite workspace roots, bounded JSON bodies, path traversal checks, and audit records; unsupported workspace and tool routes continue to fall back to Node.

The normal `vibelink.exe` user entry now enables the Rust front door and all currently migrated route flags by default. Run `vibelink.exe bridge` to use the direct Node bridge as an emergency rollback path.

## Internal modes

```powershell
vibelink.exe bridge
vibelink.exe pair
vibelink.exe doctor
vibelink.exe tunnel --check-only
vibelink.exe tunnel
vibelink.exe workspace-tree --root C:\path\to\repo --dir src --depth 2
vibelink.exe mcp-session-sidecar
vibelink.exe event-store-sidecar C:\path\to\mobile-agent.sqlite
vibelink.exe status-sidecar
vibelink.exe execd --data-dir C:\path\to\VibeLinkData
```

- `bridge`: hosts the existing Node bridge in phase 1.
- `pair`: creates a QR pairing session against a running bridge.
- `doctor`: checks whether the bridge API is reachable.
- `tunnel`: validates a named Cloudflare Tunnel, fixed hostname, loopback ingress, Host allowlist, matching port, disabled legacy login, and 404 fallback before launching bundled `cloudflared.exe`.
- `workspace-tree`: emits the Rust workspace scanner JSON contract used by the Node bridge when `VIBELINK_RUST_WORKSPACE_TREE=1` is enabled.
- `mcp-session-sidecar`: serves the MCP persistent session JSONL contract for Rust-side stdio session reuse experiments.
- `event-store-sidecar`: serves the SQLite event-store JSONL contract for explicit Rust-side append/replay experiments.
- `status-sidecar`: validates and assembles `/api/status` snapshots when `VIBELINK_RUST_STATUS=1`; the Node snapshot remains the automatic fallback.
- `execd`: discovers and routes durable executions over a current-user/SYSTEM named pipe. It starts a detached worker per execution; the hidden `execution-worker` role owns the Job Object, ConPTY/stdio handles, manifest, and event spool.

The user should not need to run internal modes directly.

When `bridge` launches the Node process, it supplies the current `vibelink.exe` path as the default MCP, event-store, and workspace-tree Rust command. Explicit `VIBELINK_MCP_RUST_SIDECAR_COMMAND`, `VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND`, and `VIBELINK_RUST_BIN` values remain authoritative. This keeps packaged installs independent of development-only `apps/windows/target` paths.

## Build

```powershell
cargo build --release --manifest-path apps/windows/Cargo.toml
```

```powershell
cargo test --manifest-path apps/windows/Cargo.toml
```

Create the portable Windows package:

```powershell
npm run package:windows
```

The ZIP under `artifacts/windows/` contains the Rust launcher, Node LTS runtime, production-only server dependencies, current Web build, and cloudflared. Its adjacent `.sha256` file verifies the archive.

The bridge is still a hybrid package while HTTP routes migrate incrementally from Node to Rust. API compatibility and fallback are required before any Node route is removed.

The planned administration shell is native Win32 through `windows-rs`, without WebView, HTML, Tauri, or Electron. See `docs/decisions/ADR-0002-rust-frontdoor-native-win32-admin.md`.
