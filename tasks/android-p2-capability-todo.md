# P2 Capability Checklist

## Phase 1: Global Discovery And Search

- [ ] P2.1 Add search request filters, pagination, and stale-response tests.
- [ ] P2.2 Expose scope/tag/favorite controls and explicit search states in Android.
- [ ] P2.3 Route registry commands and search result kinds to their owning screens.
- [ ] P2.4 Run focused bridge/JVM tests, debug build, and device navigation smoke.

## Phase 2: Capability Center

- [x] P2.5 Specify and test capability-resource list/detail/mutation contracts and SQLite Automation persistence.
- [x] P2.6 Build Plugins/Hooks/Automations/Subagents/AGENTS/config Web views.
- [x] P2.7 Build Plugins/Hooks/Automations/Subagents/AGENTS/config Android views.
- [x] P2.8 Verify approval, audit, offline, empty, and denied states.

## Phase 3: Browser Workspace

- [x] P2.9 Specify and test browser session/control/trace contracts.
- [x] P2.10 Build the Web browser workspace.
- [x] P2.11 Build Android browser session, navigation, trace, and remote-control views.
- [ ] P2.12 Verify redaction, pagination, reconnect, cleanup, and desktop/phone E2E.

## Phase 4: Artifact Workbench

- [x] P2.13 Specify authenticated metadata/range/revision-save contracts.
- [x] P2.14 Add Web table/workbook, Office/PDF, and Notebook viewers.
- [x] P2.15 Add Android table/workbook, Office/PDF, and Notebook viewers.
- [x] P2.16 Add revision-safe CSV/TSV and Notebook editing with round-trip tests.

## Final Gate

- [ ] Android unit tests, instrumentation, lint, and debug build pass.
- [ ] Bridge contract tests and security redaction tests pass.
- [ ] Runtime screenshots/logs cover desktop, phone, and tablet states.
- [ ] `android-capability-matrix.md` records evidence and residual risks.
