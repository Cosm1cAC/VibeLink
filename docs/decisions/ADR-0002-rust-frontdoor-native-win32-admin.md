# ADR-0002: Rust Front Door And Native Win32 Administration

## Status

Accepted

## Date

2026-07-13

## Context

VibeLink is migrating from a Node HTTP control plane to Rust without breaking the existing Android, HTTP, SSE, WebSocket, authentication, approval, or rollback contracts. The desktop administration surface must not become a browser-hosted dashboard or embed a WebView. Its steady-state memory footprint should be as small and predictable as practical on Windows.

The current portable package already has a Rust launcher, but Node still owns the external listener. Moving individual routes into Rust safely first requires a Rust-owned front door that can preserve every non-migrated byte stream while Node moves to a loopback-only backend.

## Decision

1. Add an opt-in Rust TCP/HTTP front door. It owns the configured external listener, starts Node on an ephemeral loopback port, and transparently forwards HTTP, SSE, and WebSocket traffic. The normal launcher remains unchanged until public canary and rollback evidence pass.
2. Migrate `/api/status` and `/api/doctor` from transparent forwarding to Rust-owned authentication, validation, serialization, and status codes in later vertical slices. All other routes continue through the loopback backend until their own contract gates pass.
3. Build the future desktop administration shell with the native Win32 API through Microsoft's `windows-rs` crate. Do not use WebView2, Tauri, Electron, HTML, or an embedded browser for administration.
4. Keep the existing Web client only as a compatibility client during migration; do not add new administration features to it. Retire its administrative role after the native shell and mobile flows cover pairing, status, doctor, settings, updates, and rollback.
5. Measure the native shell's idle and active Private Working Set before release. Raw Win32 is selected for minimal framework overhead, not as an unmeasured promise of a fixed memory value.

Official references:

- Microsoft Rust for Windows: https://learn.microsoft.com/en-us/windows/dev-environment/rust/rust-for-windows
- Microsoft `windows-rs`: https://github.com/microsoft/windows-rs
- Rust `TcpListener`: https://doc.rust-lang.org/std/net/struct.TcpListener.html
- Rust `TcpStream`: https://doc.rust-lang.org/std/net/struct.TcpStream.html

## Alternatives Considered

### Slint

- Pros: Rust-first declarative UI, better layout productivity, cross-platform.
- Cons: Adds a UI runtime and renderer above Win32 controls.
- Rejected for the first administration shell because minimum memory overhead is the primary requirement. It remains the fallback if native control maintenance cost becomes unacceptable.

### egui/eframe

- Pros: Fast implementation, strong Rust ecosystem, immediate-mode ergonomics.
- Cons: Renderer/GPU integration and continuous immediate-mode UI work add overhead unnecessary for a small settings and diagnostics window.
- Rejected for the low-memory administration shell.

### Tauri Or WebView2

- Pros: Reuses Web skills and assets.
- Cons: Keeps an HTML/WebView administration architecture and violates the explicit no-Web-management requirement.
- Rejected.

## Consequences

- The external service boundary can move to Rust before every route implementation does.
- Node is no longer directly reachable from LAN or Tunnel while the front-door canary is enabled.
- Transparent byte forwarding preserves streaming and upgrade semantics but adds one local socket hop until routes migrate.
- The native shell will require more Windows-specific layout, accessibility, DPI, lifecycle, and testing work than a WebView or declarative framework.
- The desktop GUI is Windows-specific; Android remains the remote client.
- Every front-door and route-ownership step remains disabled by default and independently reversible.
