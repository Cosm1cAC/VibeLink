# ADR-0006: Rust Pairing HTTP Ownership

## Status

Accepted for opt-in canary implementation.

## Context

Pairing combines public polling, authenticated administration, JSON request bodies, one-time codes, token issuance, settings projection, rate limits, and audit writes. The current Rust front door parses bounded headers but intentionally streams request bodies to Node for unmatched routes. Moving the entire family in one change would couple a new body parser to security-sensitive token issuance.

## Decision

- Add `--rust-pairing-http`, effective only with `--rust-http-canary`.
- Migrate public create/status/claim and authenticated list/approve/deny behind one route-family flag.
- Direct JSON bodies use a 1 MiB bounded `Content-Length` reader which appends consumed bytes to the replay prefix. Unsupported transfer encodings, invalid lengths, and larger bodies remain byte-for-byte Node fallbacks during canary.
- Preserve stored-status filtering, computed expiry, field projection, authentication, polling rate limits, response codes, and audit records.
- Pairing decisions and their audit records share a SQLite transaction. Once Rust authenticates and claims approve/deny, failures return Rust `500` and never replay to Node.
- Claim acquires the Node-owned public settings snapshot through a loopback-only, process-token-protected endpoint before committing the one-time token transaction, so a post-commit dependency failure cannot strand the caller without its token. The settings migration removes this internal dependency later.

## Consequences

The feature flag owns the pairing family for normal Web/Android requests while preserving Node replay for unsupported body framing and pre-commit dependency failures. Rust-generated codes and tokens exist in plaintext only in their single response; SQLite stores hashes.
