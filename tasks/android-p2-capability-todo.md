# Android P2 Capability Checklist

## Phase 1: Global Discovery And Search

- [ ] P2.1 Add search request filters, pagination, and stale-response tests.
- [ ] P2.2 Expose scope/tag/favorite controls and explicit search states in Android.
- [ ] P2.3 Route registry commands and search result kinds to their owning screens.
- [ ] P2.4 Run focused bridge/JVM tests, debug build, and device navigation smoke.

## Phase 2: Capability Center

- [ ] P2.5 Specify and test capability-resource list/detail/mutation contracts.
- [ ] P2.6 Build Plugins/Hooks/Automations/Subagents/AGENTS/config Android views.
- [ ] P2.7 Verify approval, audit, offline, empty, and denied states.

## Phase 3: Browser Workspace

- [ ] P2.8 Specify and test browser session/control/trace contracts.
- [ ] P2.9 Build Android browser session, navigation, trace, and remote-control views.
- [ ] P2.10 Verify redaction, pagination, reconnect, cleanup, and phone E2E.

## Phase 4: Artifact Workbench

- [ ] P2.11 Specify authenticated metadata/range/save contracts.
- [ ] P2.12 Add table/workbook, Office/PDF, and Notebook viewers.
- [ ] P2.13 Add format-safe editing only after conflict and round-trip tests pass.

## Final Gate

- [ ] Android unit tests, instrumentation, lint, and debug build pass.
- [ ] Bridge contract tests and security redaction tests pass.
- [ ] Runtime screenshots/logs cover phone and tablet states.
- [ ] `android-capability-matrix.md` records evidence and residual risks.

