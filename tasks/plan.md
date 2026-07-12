# Android Defect Remediation Plan

## Overview

Fix every application-owned defect reproduced during the Android 16 emulator audit: task approval handoff, approval navigation, message composer keyboard behavior, landscape login, history preview leakage, and repeated notification permission prompts. External Mobile MCP crash-list behavior and an emulator camera source that produces black frames are tracked as environment constraints, not VibeLink source defects.

## Architecture Decisions

- Treat approval as an asynchronous execution handoff. The approval endpoint already starts the stored tool run, so Android consumes its typed task result instead of creating a second request.
- Sanitize history at the server boundary so every client receives only user-visible user/assistant preview text.
- Keep responsive decisions explicit: supplemental composer controls collapse while the IME is visible, while the prompt and send command remain reachable.
- Persist the notification prompt decision locally so Activity recreation cannot repeat an already answered permission request.

## Task List

### Phase 1: Data And Contract Safety

- [x] Task 1: Sanitize history previews and add Node regression coverage.
- [x] Task 2: Model approval execution results and add Android handoff tests.

### Checkpoint: Contracts

- [x] Focused Node and Android tests pass.
- [x] Approval response remains backward compatible with existing fields.

### Phase 2: Workflow And Layout

- [x] Task 3: Preserve approval state, deep-link Settings to Pending Approvals, and attach the automatically started task.
- [x] Task 4: Make login content scrollable in portrait, landscape, and scanner states.
- [x] Task 5: Keep the composer usable with the IME open and give the prompt a stable minimum width.
- [x] Task 6: Prevent repeated notification permission prompts after the first automatic request.

### Checkpoint: Android

- [x] Android unit suite passes.
- [x] Debug APK builds successfully.
- [x] Approval, keyboard, rotation, and permission scenarios pass on `Codex_API_36`.

### Phase 3: Verification And Delivery

- [x] Task 7: Run full focused verification, inspect the diff, and perform a quality review.
- [ ] Task 8: Stage only intended files, commit, and push the current branch.

The full Node suite also exposed an existing event-store sidecar contract defect. The client now forwards its optional database path to the child process and uses the sidecar-specific backpressure error code; the existing regression tests pass.

The intended files are staged and committed locally. Push remains pending because three HTTPS attempts could not connect to `github.com:443`.

## Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Approval result shape changes | High | Additive typed fields matching the existing JSON; retain current response fields. |
| Shared ViewModel attaches the wrong task | High | Match the approval ID and clear only the active pending approval. |
| IME inset changes regress non-keyboard layout | Medium | Hide only supplemental controls while IME is visible; manually verify both states. |
| History filtering removes legitimate content | Medium | Keep only normalized user/assistant roles and test both visible and internal entries. |
| Permission prompt cannot be recovered | Low | Automatic prompt becomes one-shot; users can still grant permission from Android settings. |

## Open Questions

- None blocking. Mobile MCP's `list_crashes` device lookup and the emulator's black camera feed are outside this repository; ADB crash logs and non-QR token pairing remain the verification fallback.
