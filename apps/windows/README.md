# VibeLink Windows

Rust launcher, sidecar host, portable desktop package, and public-tunnel supervisor.

## User entry

```powershell
vibelink.exe
```

The default mode starts the packaged or development bridge, waits for the HTTP API, then creates an Android pairing QR. Packaged builds prefer `runtime/node.exe`; `VIBELINK_NODE_COMMAND` remains an explicit override and development falls back to `node` on PATH.

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
```

- `bridge`: hosts the existing Node bridge in phase 1.
- `pair`: creates a QR pairing session against a running bridge.
- `doctor`: checks whether the bridge API is reachable.
- `tunnel`: validates a named Cloudflare Tunnel, fixed hostname, loopback ingress, Host allowlist, matching port, disabled legacy login, and 404 fallback before launching bundled `cloudflared.exe`.
- `workspace-tree`: emits the Rust workspace scanner JSON contract used by the Node bridge when `VIBELINK_RUST_WORKSPACE_TREE=1` is enabled.
- `mcp-session-sidecar`: serves the MCP persistent session JSONL contract for Rust-side stdio session reuse experiments.
- `event-store-sidecar`: serves the SQLite event-store JSONL contract for explicit Rust-side append/replay experiments.
- `status-sidecar`: validates and assembles `/api/status` snapshots when `VIBELINK_RUST_STATUS=1`; the Node snapshot remains the automatic fallback.

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
