# VibeLink Windows Rust Entry Plan

## Decision

VibeLink should expose one Windows user entry: `vibelink.exe`.

Internally, the binary can run two roles:

- `vibelink.exe`: user-facing launcher. It owns tray/window UX, service status, QR pairing display, and device management.
- `vibelink.exe bridge`: supervised bridge role. In phase 1 it hosts the existing Node bridge process; later it can be replaced by native Rust bridge modules route by route.

This keeps the product simple for users while preserving process isolation for reliability.

## Why Rust

- Lower baseline memory than Electron-style desktop shells.
- Native process supervision is straightforward and cheap.
- Windows tray/window integration can be native without embedding a browser.
- The bridge can migrate from Node to Rust incrementally instead of doing a risky rewrite.

## Design Principles

- One visible entry. Users should not start two executables or understand bridge internals.
- No Web control surface. Pairing and device management belong in the Windows app.
- QR payloads must carry short-lived pairing material only, never long-lived device tokens.
- Android must confirm before claiming a token.
- Keep the existing HTTP API contract stable while moving the desktop entry to Rust.
- Prefer native Windows UI/tray over Electron or a WebView shell.

## Phase Plan

### Phase 1: Rust single-entry launcher

- Add `apps/windows` Rust crate.
- Implement `vibelink.exe` default mode as the only user entry.
- Default mode starts `vibelink.exe bridge` as a hidden child process.
- Bridge mode launches the existing `src/server.js` with the configured host and port.
- Wait for `/api/status` before showing connection information.
- Create a pairing session through `/api/pairing-sessions` and render a QR payload for Android.

### Phase 2: Native Windows tray/window

- Add tray icon and compact native pairing window.
- Show service state, LAN URL, QR code, expiry, and latest pairing status.
- Add actions: refresh QR, stop/start bridge, copy server URL, open logs.

### Phase 3: Device management

- List devices from `/api/devices`.
- Revoke device tokens from the Windows app.
- Show pending pairing sessions with approve/deny controls.

### Phase 4: Android QR flow

- Android scans `vibelink://pair?...`.
- Android parses `server`, `session`, and `code`.
- Android shows confirmation with server URL and pairing metadata.
- Android polls status, claims approved sessions, and stores the device token.

### Phase 5: Native Rust bridge migration

- Keep the Node bridge as the compatibility core while the launcher stabilizes.
- Migrate low-risk support services first: status, pairing session creation, device listing.
- Leave agent execution, terminal control, and MCP routes on the existing implementation until each route has tests.

## First QR Payload

```text
vibelink://pair?server=http%3A%2F%2F192.168.1.10%3A8787&session=<sessionId>&code=<pairingCode>
```

The server continues to own session state and token issuance. The QR code is only a transport for the server URL and short-lived claim material.
## Loopback auto-approval

When the Rust Windows launcher creates a pairing session, it sends `trustLocalLauncher: true` to the existing bridge over `127.0.0.1`. The bridge may auto-approve that session only when the request source is loopback. Android still has to scan the QR and claim the short-lived session before receiving a device token.