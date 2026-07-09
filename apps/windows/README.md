# VibeLink Windows

Rust single-entry launcher for VibeLink on Windows.

## User entry

```powershell
vibelink.exe
```

The default mode starts the bridge role automatically, waits for the HTTP API to become healthy, then creates and displays an Android pairing QR.

## Internal modes

```powershell
vibelink.exe bridge
vibelink.exe pair
vibelink.exe doctor
vibelink.exe workspace-tree --root C:\path\to\repo --dir src --depth 2
vibelink.exe mcp-session-sidecar
```

- `bridge`: hosts the existing Node bridge in phase 1.
- `pair`: creates a QR pairing session against a running bridge.
- `doctor`: checks whether the bridge API is reachable.
- `workspace-tree`: emits the Rust workspace scanner JSON contract used by the Node bridge when `VIBELINK_RUST_WORKSPACE_TREE=1` is enabled.
- `mcp-session-sidecar`: serves the MCP persistent session JSONL contract for Rust-side stdio session reuse experiments, including bounded active-request scheduling and sidecar-level backpressure metrics.

The user should not need to run internal modes directly.

## Workspace tree scanner

The scanner skips heavy directories such as `.git`, `node_modules`, `target`, and `.agent-mobile-terminal`. It also honors root and nested `.gitignore` basename rules, path rules, simple `*` wildcard patterns, `**` path segments, negation, and directory-only rules such as `logs/`.

The JSON response includes a metadata `signature` for the scanned directory window. It also includes `truncated: true` when `--max-entries` prevents the scanner from returning every matching item. The Node bridge records the latest signature, Rust workspace-tree budget hits, and Rust scanner result cache hits/misses/evictions in runtime stats.

Remaining migration work: moving the reusable scanner cache into a long-lived Rust sidecar/native scanner is still a future Rust slice.

## Build

```powershell
cargo build --release --manifest-path apps/windows/Cargo.toml
```

```powershell
cargo test --manifest-path apps/windows/Cargo.toml
```
