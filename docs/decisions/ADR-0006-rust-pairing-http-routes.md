# ADR-0006: Staged Rust Pairing HTTP Ownership

## Status

Accepted for opt-in canary implementation.

## Context

Pairing combines public polling, authenticated administration, JSON request bodies, one-time codes, token issuance, settings projection, rate limits, and audit writes. The current Rust front door parses bounded headers but intentionally streams request bodies to Node for unmatched routes. Moving the entire family in one change would couple a new body parser to security-sensitive token issuance.

## Decision

- Add `--rust-pairing-http`, effective only with `--rust-http-canary`.
- First migrate public `GET /api/pairing-sessions/:id`, authenticated `GET /api/pairing-sessions`, and authenticated approve/deny operations. Creation and claim remain byte-for-byte Node fallbacks in this stage.
- Preserve stored-status filtering, computed expiry, field projection, authentication, polling rate limits, response codes, and audit records.
- Pairing decisions and their audit records share a SQLite transaction. Once Rust authenticates and claims approve/deny, failures return Rust `500` and never replay to Node.
- The next stage adds a bounded request-body reader and migrates create/claim. Claim must acquire any Node-owned public settings snapshot before committing the one-time token transaction, so a post-commit dependency failure cannot strand the caller without its token.

## Consequences

The feature flag temporarily owns a documented subset of the pairing family while create/claim remain reversible Node paths. This gives Android polling and native administration an independently testable Rust slice without weakening one-time token handling.
