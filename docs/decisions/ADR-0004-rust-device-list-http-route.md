# ADR-0004: Rust-Owned Device List HTTP Route

## Status

Accepted

## Date

2026-07-14

## Context

The Rust front door already owns opt-in Status and Doctor routes. The next pairing/device slice must support the future native Win32 administration shell without moving token rotation, revocation, or pairing state transitions in the same change.

`GET /api/devices` is a bounded read-only boundary backed entirely by the existing SQLite `devices` table. Its response contract includes public device metadata, the authenticated device ID, ordering by recent activity, expiry state, and optional nested `fields` selection.

## Decision

1. Add `--rust-devices-http`, effective only with `--rust-http-canary` and disabled by default.
2. Rust owns exactly `GET /api/devices`; pairing and all device mutation routes remain Node-owned.
3. Reuse the Status route's 64KiB request parser, Host allowlist, Bearer/query token authentication, revocation/expiry checks, and successful `last_seen_at` update.
4. Read device rows through a read-only parameter-free SQLite query ordered by `COALESCE(last_seen_at, created_at) DESC`. Never select or serialize `token_hash`.
5. Preserve the Node public shape: `items`, `currentDeviceId`, camel-case timestamps, parsed `meta`, computed `expired`, and nested `?fields=` filtering.
6. Rust responses use the existing JSON/no-store/security headers and `X-VibeLink-Control-Plane: rust`. Successful list responses expose `controlPlaneRuntime.devicesHttp` counters so canaries can require zero failures and fallbacks. Initialization, settings, authentication-store, query, or serialization errors replay the original request to Node.
7. The cumulative portable canary entry enables Status, Doctor, and Devices, while every route retains its independent kill switch.

Official references:

- `rusqlite`: https://docs.rs/rusqlite/0.32.1/rusqlite/
- `serde_json`: https://docs.rs/serde_json/latest/serde_json/
- `chrono`: https://docs.rs/chrono/latest/chrono/

## Rejected Alternatives

### Migrate Device Mutations Together

Rejected because revoke and rotate operations require rate limits, audit writes, token return handling, and stronger rollback evidence. A read-only slice is independently useful to the native GUI and has a smaller security surface.

### Ask Node For A Device Snapshot

Rejected because the public device shape is already derived directly from one SQLite table. An internal Node hop would preserve Node ownership without adding dynamic data that Rust cannot read safely.

### Remove The Node List Route Immediately

Rejected because the opt-in Rust path still requires initialization and error fallback evidence before deprecation.

## Consequences

- The future native administration shell can list paired devices without a WebView or Node HTTP route on the success path.
- Device writes remain centralized in Node until their own audited vertical slices are implemented.
- SQLite public-device mapping now exists in both runtimes during the canary window and must remain contract-tested until Node fallback is retired.
