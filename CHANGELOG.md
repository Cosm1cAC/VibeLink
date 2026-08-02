# Changelog

## [0.1.1] - 2026-08-02

### Added

- Rust-only Windows control plane, execution host recovery, native pairing, and release evidence gates.
- Reproducible release bundle verification for package manifests, checksums, SBOM, dependency audit, rollback rehearsal, and release notes.

### Fixed

- Rust-only startup and SQLite busy handling no longer surface transient initialization failures as misleading 404 responses.
- Search indexing keeps filesystem reads outside short SQLite write transactions.
- Legacy token login and pairing-card layout are restored in Rust-only and Web clients.
- Rust canaries reject stale release binaries and do not apply release performance thresholds to debug binaries.

### Release Status

- This is a Windows preview release. QG-003 external Provider, natural MCP, weak-network Live Call, and physical Android evidence remain an explicit non-blocking preview decision and must not be interpreted as stable-release evidence.
