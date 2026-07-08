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
```

- `bridge`: hosts the existing Node bridge in phase 1.
- `pair`: creates a QR pairing session against a running bridge.
- `doctor`: checks whether the bridge API is reachable.

The user should not need to run internal modes directly.

## Build

```powershell
cargo build --release --manifest-path apps/windows/Cargo.toml
```

Rust is not currently installed on the checked machine, so build verification is blocked until `rustc` and `cargo` are available.
