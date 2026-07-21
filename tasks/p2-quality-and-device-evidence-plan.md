# P2 Quality And Device Evidence Plan

## Overview

Close the P2 release-quality gaps by making the Node/Rust/Android validation entry points explicit and repeatable, repairing stale assertions and canary assumptions, localizing Capability Center runtime copy, and adding a physical-device evidence contract that can be required by release workflows when device credentials are available.

## Task List

### Phase 1: Baseline Repair

- [x] Add a unified `npm test` command that discovers and runs the complete Node test suite serially.
- [x] Update artifact HTTP expectations to cover editable CSV behavior, including malformed, stale-digest, rotation, and large-content cases.
- [x] Make the MCP real canary discover an indexed graph project instead of assuming `VibeLink`.

### Phase 2: Release Gates

- [x] Add CI jobs for unified Node tests, full Cargo tests, Android JVM/build checks, and rust-only negative packaging.
- [x] Keep connected-device tests and physical-device evidence separate, with an explicit release gate that fails only when the physical matrix is required but its manifest is missing or invalid.
- [x] Archive logs, screenshots, and device metadata through a checked-in evidence manifest format.

### Phase 3: Capability Center Localization

- [x] Move Capability Center user-facing runtime strings into the existing language map.
- [x] Add a focused test preventing newly exposed hard-coded English operation labels.

## Verification

- `npm test`
- `npm run build`
- `cargo test --manifest-path apps/windows/Cargo.toml`
- `cd apps/android && gradlew.bat testDebugUnitTest assembleDebug`
- `npm run release:android-device-evidence -- --manifest <manifest>`

## Risks

- Full Cargo or Android builds may be unavailable on the current host; CI definitions must still be valid and local failures must be reported.
- Physical-device evidence cannot be fabricated. The gate validates real manifests and remains an explicit/manual release input when no device farm is configured.
