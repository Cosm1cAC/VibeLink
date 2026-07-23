# ADR-0003: Rust-Owned Status HTTP Route

## Status

Accepted

## Date

2026-07-13

## Context

ADR-0002 moved the external listener into Rust while Node remained a loopback-only backend. The next migration slice must move `GET /api/status` authentication and HTTP response ownership into Rust without duplicating every dynamic provider, workspace, task, and notification collector in one risky change.

The public contract must remain compatible: Host allowlisting runs before authentication, missing or invalid device credentials return `401 {"error":"Unauthorized"}`, valid requests return the current Status object, and disabling the new route flag immediately restores transparent Node forwarding.

## Trust Boundaries

- External HTTP request bytes, headers, Host, query parameters, and tokens are untrusted.
- `settings.json` and SQLite are local state but still require shape validation and parameterized queries.
- The Node snapshot response is an internal service response and must be validated before Rust sends it publicly.
- The internal snapshot credential is a process secret. It must never appear in command arguments, logs, API responses, evidence files, or source control.

## Decision

1. Add a separate `--rust-status-http` flag that is effective only with `--rust-http-canary`. Both remain disabled by default.
2. Parse at most 64KiB of request headers with `httparse`. Requests that are incomplete, malformed, or exceed the bound fall back to the existing Node connection path rather than creating a second public error contract.
3. For exactly `GET /api/status`, Rust validates Host using the existing local/private/allowlist rules, then authenticates the Bearer token (or existing `?token=` fallback) against the SQLite `devices` table using SHA-256, revocation, and expiry checks. Queries remain parameterized and successful authentication updates `last_seen_at`.
4. Rust builds the status snapshot locally from the settings projection, SQLite device state, and route-owned runtime fields. The former Node internal snapshot callback is removed.
5. The internal endpoint returns the existing dynamic snapshot before Status rendering. Rust reads internal JSON through a 16MiB streaming bound, validates and renders it with the same `status_sidecar` contract, then returns the existing JSON content type, no-store cache policy, and status code. Oversized snapshots use the Node fallback path.
6. Host denial and authentication denial are Rust-owned for this route. Internal transport, snapshot, validation, or serialization failures increment Rust route fallback counters and transparently replay the original request to Node.
7. Non-Status HTTP, SSE, and WebSocket traffic remains byte-transparent through the existing front door.

Official references:

- `httparse`: https://docs.rs/httparse/latest/httparse/
- `sha2`: https://docs.rs/sha2/latest/sha2/
- `getrandom`: https://docs.rs/getrandom/0.2.17/getrandom/
- `rusqlite`: https://docs.rs/rusqlite/0.32.1/rusqlite/

## Rejected Alternatives

### Trust Node Authentication And Proxy Its Final Response

Rejected because the public Status route would still be Node-owned despite the Rust listener.

### Reimplement Every Dynamic Status Collector In Rust Immediately

Rejected because provider probes, credential state, desktop integration, workspace state, and task state are independent migration slices. Moving them together would remove the rollback boundary.

### Expose An Unauthenticated Loopback Snapshot Endpoint

Rejected because unrelated local processes could read device, workspace, task, and runtime information.

### Replace The Front Door With A Full Async Web Framework

Rejected for this slice because the current byte proxy already preserves SSE and WebSocket behavior with low memory overhead. A framework migration can be reconsidered only if multiple native routes make the bounded parser harder to maintain safely.

## Consequences

- Public Status authentication, denial responses, snapshot validation, and success serialization can be proven Rust-owned independently.
- Node remains a typed dynamic data source and an immediate fallback, not the external Status route authority.
- Two small direct dependencies (`httparse` and `sha2`) are added; `getrandom` becomes a direct dependency but is already present transitively.
- Status connections may use an explicit close during the first canary; clients must remain compatible with standard HTTP connection closure. Keep-Alive ownership can be added only with a dedicated connection-loop contract test.
- `/api/doctor` remains Node-owned until the Status canary passes.
