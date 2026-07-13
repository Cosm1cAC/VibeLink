# ADR-0005: Rust Device Mutation HTTP Routes

## Status

Accepted for opt-in canary implementation.

## Context

The Rust HTTP front door already owns the read-only device list, while Node still owns token rotation and revocation. Replaying a mutation after Rust may have committed can rotate a token twice, return the wrong plaintext token, or write conflicting audit history. The read-route fallback behavior is therefore unsafe for these routes.

## Decision

- Add a separate `--rust-device-mutations-http` flag which is effective only with `--rust-http-canary`.
- Rust owns `POST /api/devices/current/rotate`, `POST /api/devices/:id/rotate`, and `POST /api/devices/:id/revoke` behind that flag.
- Missing initialization state may fall back to Node before Rust claims the request.
- After Rust authenticates and claims a matching mutation, every outcome is a Rust response. Database, audit, serialization, and socket errors must never replay the request to Node.
- The device update and its audit record share one SQLite transaction. A failed audit insert rolls back the device update.
- Rotation generates 32 random bytes, returns the lowercase hexadecimal token once, stores only its SHA-256 hash, and sets a 90-day expiry.
- Rotation retains Node's in-memory limit of six requests per ten-minute bucket keyed by request IP and target device. Rate-limit responses and audit records preserve Node's contract.
- Keep Node implementations intact as the rollback target until contract, failure-injection, packaged HTTP canary, and public rollout evidence pass.

## Consequences

Mutation failures are fail-closed after ownership begins instead of being silently retried by another runtime. This can expose a temporary Rust `500` during a database failure, but it prevents duplicate or ambiguous security operations. Disabling the route flag and restarting restores Node ownership for later requests.

## Rejected Alternatives

### Reuse Read-Route Error Fallback

Rejected because a connection or response error does not prove that the database transaction was uncommitted.

### Keep Audit Writes Outside The Transaction

Rejected because an unaudited token change is worse than failing and rolling back the requested mutation.

### Persist Plaintext Tokens For Recovery

Rejected because it expands credential exposure. A rotation response is the only place the new plaintext token exists.
