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
```

- `bridge`: hosts the existing Node bridge in phase 1.
- `pair`: creates a QR pairing session against a running bridge.
- `doctor`: checks whether the bridge API is reachable.
- `workspace-tree`: emits the Rust workspace scanner JSON contract used by the Node bridge when `VIBELINK_RUST_WORKSPACE_TREE=1` is enabled.

The user should not need to run internal modes directly.

## Workspace tree scanner

The scanner skips heavy directories such as `.git`, `node_modules`, `target`, and `.agent-mobile-terminal`. It also honors root and nested `.gitignore` basename rules for literal file names, simple `*` wildcard file patterns, and directory-only rules such as `logs/`.

The JSON response includes `truncated: true` when `--max-entries` prevents the scanner from returning every matching item. The Node bridge records that as a Rust workspace-tree budget hit in runtime stats.

Remaining migration work: full gitignore path semantics and incremental cache metadata are still Node-side or future Rust slices.

## Build

```powershell
cargo build --release --manifest-path apps/windows/Cargo.toml
```

```powershell
cargo test --manifest-path apps/windows/Cargo.toml
```
