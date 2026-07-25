# ADR-0008: Rust Settings HTTP Ownership

## Status

Accepted

## Context

`POST /api/settings`, `GET /api/settings/export`, and `POST /api/settings/import` combine authenticated configuration changes, secret storage, import/export filtering, dry-run responses, runtime reloads, and audit records. The Windows package already stores API and FCM credentials as current-user DPAPI ciphertext under `secrets/*.dpapi`; a migration must not copy those values into `settings.json` or return them from public/export responses.

The hybrid runtime also keeps an in-memory Node settings object for routes that have not migrated yet. A direct Rust file update without a compatibility reload would leave those routes on stale configuration until restart.

## Decision

- Add `--rust-settings-http`, effective only with `--rust-http-canary`, for all three Settings endpoints.
- Port sanitization, MCP secret-placeholder merging, bounded retention values, import/export allowlists, public projections, validation, dry-run summaries, Host enforcement, device authentication, and audit records to Rust.
- Serialize Settings mutations with a process-wide mutex. Write `settings.json` through a synced temporary file and same-directory replacement; snapshot the original file before ownership.
- Keep API keys and the FCM service account out of `settings.json`. On Windows, use the existing DPAPI ciphertext format through the system Windows PowerShell security module, pass plaintext only through a child-process environment, and snapshot every affected ciphertext file for rollback.
- Rust mutations now reload and project settings locally after atomic persistence. No internal Node reload callback is required.
- Once Rust owns a mutation body, later file, credential, reload, or audit failure returns a Rust `500` and never replays the request to Node. Restore settings and credential snapshots and request a best-effort reload of the restored state. Initialization/authentication failures and unsupported body framing remain pre-ownership fallback cases.
- Keep the route opt-in until local, packaged, CI, and public canaries pass. Removing Node still requires Rust-native notification-key initialization and removal of the internal reload compatibility endpoint.

## Consequences

Android and other API clients retain the Settings contract while secrets remain user-bound ciphertext and concurrent mutations cannot interleave rollback state. Non-migrated Node routes observe new settings immediately. The portable package remains hybrid and independently reversible; this ADR does not authorize removing the bundled Node runtime.
