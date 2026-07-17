# ADR-0009: Rust Ownership for Non-Streaming Tool Events Reads

## Status

Accepted

## Date

2026-07-16

## Context

`GET /api/tool-events` serves both bounded JSON replay and a long-lived SSE subscription selected by `stream=1`. The JSON path is a parameterized SQLite read whose event-store implementation already exists in Rust. The SSE path also depends on Node's in-process subscriber set, catch-up scheduling, disconnect handling, and live append notifications. Moving both paths together would combine a small read migration with a separate connection-lifecycle migration.

The Rust HTTP front door must preserve Host validation, device authentication, rejection audit records, cursor ordering, filters, field projection, and transparent fallback. A failed Rust query must not partially write a response before the original request is replayed to Node.

## Decision

- Add `--rust-tool-events-http`, effective only with `--rust-http-canary`.
- Rust owns only exact non-streaming `GET /api/tool-events` requests. `stream=1`, other methods, and other paths remain byte-for-byte Node traffic.
- Share the parameterized query and event JSON/cursor mapping between the existing event-store sidecar and HTTP route through `tool_events_store.rs`. The HTTP route opens its data query with SQLite read-only flags.
- Preserve ascending `cursor > after` replay, `Last-Event-ID` fallback, `toolRunId`/`workspaceId`/`taskId` filters, default limit 500, maximum limit 5000, nested `fields`, and `{ items }` responses.
- Reuse the existing Rust control-plane Host/device authentication. Host and authentication rejections write the same `host.blocked` or `auth.failed` audit event before returning `403` or `401`.
- Treat missing initialization, authentication storage errors, audit errors, schema errors, and query errors as pre-response fallback cases. The front door replays the unchanged request to Node. Closing the flag restores Node ownership for later requests.

## Alternatives Considered

### Move JSON replay and SSE together

Rejected because SSE ownership requires a Rust broadcast/subscription lifecycle and append integration that is independent of the bounded SQLite query. Combining them would enlarge the failure and rollback surface without improving the current read migration.

### Call the event-store sidecar from the Rust HTTP route

Rejected because it would retain an extra process hop and JSONL serialization on every request, introduce session readiness into HTTP ownership, and provide no contract benefit over sharing the query function.

### Duplicate the SQLite query in the HTTP module

Rejected because sidecar and HTTP replay behavior could drift. A small crate-private store module gives both callers one ordering, filtering, limit, and JSON mapping implementation.

## Consequences

Authenticated non-streaming replay no longer traverses the Node HTTP handler, event-store worker selection, or sidecar JSONL request path. Node remains resident for SSE and all other unmigrated routes, so this slice can reduce request overhead but is not expected to materially reduce whole-process memory by itself. The route remains opt-in until CI, packaged, and controlled public canaries pass; removing Node requires a later Rust SSE implementation and migration of the remaining Node route families.
