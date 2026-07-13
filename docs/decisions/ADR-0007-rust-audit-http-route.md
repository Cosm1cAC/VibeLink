# ADR-0007: Rust Audit Log HTTP Ownership

## Status

Accepted

## Context

`GET /api/audit-log` exposes security-relevant records to authenticated devices. Its observable contract includes descending cursor order, strict `cursor > after` pagination, nested `fields` projection, Host enforcement, device authentication, and audit records for rejected access. The Node implementation also passed negative limits to SQLite, where `LIMIT -1` becomes an unbounded read.

## Decision

- Add `--rust-audit-http`, effective only with `--rust-http-canary`.
- Preserve the authenticated `{ items }` response, descending cursor order, strict `after` behavior, nullable-column defaults, boolean success conversion, invalid `meta_json` fallback, and nested `fields` projection.
- Use parameterized SQLite queries and normalize `after` to a non-negative integer. Bound `limit` to 1–5000 with a default of 200; this intentionally closes the old unbounded negative-limit behavior.
- Record `host.blocked` and `auth.failed` before returning Rust `403`/`401`, including the first forwarded IP only. If initialization, authentication storage, rejection audit, or the read query fails before a response is owned, replay the original request to Node.

## Consequences

Normal Web/Android clients retain their existing contract while abusive pagination cannot force an unbounded audit scan. The route remains opt-in during canary and Node remains the byte-preserving fallback until production evidence is complete.
