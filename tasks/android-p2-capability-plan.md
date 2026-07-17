# Android P2 Capability Plan

## Objective

Close the Android product gaps for discovery/management, browser control, global
navigation/search, and rich artifact handling without presenting unsupported
backend behavior as working controls. The target user is an engineer operating a
local VibeLink bridge from a phone. Success means each surface loads real bridge
state, exposes only actions backed by an audited contract, and remains usable when
the bridge is offline or denies an operation.

## Tech Stack And Commands

- Android: Kotlin, Jetpack Compose, Navigation Compose, OkHttp/Gson.
- Bridge: Node.js HTTP server with JSON-only contracts.
- JVM tests: `cd apps/android; .\gradlew.bat testDebugUnitTest --no-daemon`.
- Focused JVM tests: `cd apps/android; .\gradlew.bat testDebugUnitTest --tests "*SessionList*" --tests "*ApiClientSearchTest" --no-daemon`.
- Bridge tests: `node --test test/search.test.js test/commandRegistry.test.js test/commandPaletteModel.test.js`.
- Debug build: `cd apps/android; .\gradlew.bat assembleDebug --no-daemon`.
- Lint: `cd apps/android; .\gradlew.bat lintDebug --no-daemon`.

## Project Structure

- `apps/android/app/src/main/java/com/vibelink/app/network/`: bridge contracts and API client.
- `apps/android/app/src/main/java/com/vibelink/app/ui/screens/`: Compose screens and ViewModels.
- `apps/android/app/src/test/`: JVM contract, reducer, and policy tests.
- `apps/android/app/src/androidTest/`: device navigation, rotation, and accessibility smoke tests.
- `src/`: bridge routes and domain services.
- `test/`: bridge contract tests.
- `tasks/`: living plan, checklist, capability matrix, and verification evidence links.

## Code Style

Keep remote state in ViewModels and render it through focused Compose components.
Prefer explicit state over boolean combinations that hide loading/error/empty
transitions. API methods mirror route names and return typed models.

```kotlin
data class BrowserSessionUiState(
    val sessions: List<BrowserSession> = emptyList(),
    val loading: Boolean = false,
    val error: String = "",
)
```

Use the VibeLink design tokens: near-white canvas, pale cyan navigation, graphite
commands, teal focus/success, and orange only for permission or attention states.
Keep operational layouts compact and avoid nested cards.

## Testing Strategy

- Write a failing JVM or Node contract test before every behavior change.
- Test query encoding, stale-response rejection, pagination deduplication, command
  dispatch, and resource mutations as small tests.
- Use MockWebServer for Android HTTP boundaries and real bridge contract tests for
  server routes.
- Verify every new screen at 320 px and a tablet/desktop-width emulator, including
  loading, empty, offline, denied, and populated states.
- Finish browser-facing work with a real runtime screenshot, clean logs, and an
  accessibility-tree/navigation check.

## Boundaries

- Always: authenticate bridge calls, validate untrusted content, preserve explicit
  approval for risky actions, paginate lists, and keep offline/denied states visible.
- Ask first: add a third-party Office renderer, change persistence formats, or add
  browser automation dependencies with native binaries.
- Never: render remote HTML with privileged bridge credentials, expose tokens in
  traces, treat AGENTS/config content as executable instructions, or enable a
  management toggle that has no backend mutation contract.

## Architecture Decisions

1. Reuse `/api/search`, `/api/command-registry`, thread state, tool registry, MCP
   status, workspace file, and attachment contracts where they already exist.
2. Add contract-first route families for capability resources and browser sessions;
   Android UI follows only after their list/detail/mutation schemas are tested.
3. Model Plugins, Hooks, Automations, Subagents, and AGENTS/config as typed resource
   categories in one capability center, while keeping category-specific actions
   explicit rather than creating a generic unsafe mutation endpoint.
4. Treat browser traces as append-only session events with bounded pagination and
   redacted headers/bodies. Remote control actions require session ownership and
   normal approval/audit policy.
5. Dispatch artifacts by detected kind. CSV/XLSX, DOCX, PPTX/PDF, and Notebook get
   dedicated viewers; unsupported formats fall back to metadata/download, not raw
   binary text.

## Delivery Plan

### Phase 1: Global Discovery And Search

- Finish query scope, tag/favorite filters, pagination, stale-response protection,
  and explicit search states in Android.
- Fix command-palette filtering and route dispatch; do not duplicate ad-hoc menu
  actions inside registry results.
- Route session/task/message/file results to their owning surface.

Checkpoint: focused Node/JVM tests and Android debug build pass; device smoke proves
search, filtering, command navigation, and offline behavior.

### Phase 2: Capability Center

- Define list/detail schemas for Plugins/MCP, Hooks, Automations, Subagents, and
  AGENTS/config sources with capability flags for supported actions.
- Add a compact Android capability center with category tabs, status, source,
  last-run/error metadata, and safe edit/run/enable controls only where supported.
- Record approval and audit results in the same interaction flow.

Checkpoint: contract tests cover every resource category and rejected mutation;
Android device smoke covers loaded, empty, offline, and denied states.

### Phase 3: Browser Workspace

- Add browser session create/list/detail/close and navigation/action routes.
- Persist bounded redacted trace events for navigation, console, network, screenshot,
  and test steps.
- Add Android browser view, address/navigation toolbar, session switcher, trace
  timeline, and remote-control state.

Checkpoint: localhost E2E proves phone navigation/control, trace pagination, redaction,
reconnect, and session cleanup with no privileged data in logs.

### Phase 4: Artifact Workbench

- Add authenticated byte/range retrieval plus kind/size metadata.
- Implement dedicated read-only viewers first: delimited tables, workbook sheets,
  Office/PDF pages, and Notebook cells/outputs.
- Add constrained editing only after format-preserving save contracts and conflict
  handling are proven.

Checkpoint: representative fixtures render on phone/tablet, large files stay bounded,
unsupported/corrupt files show recoverable fallback, and edits survive reload.

## Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| UI gets ahead of bridge capability | High | Capability flags and contract-first slices; hide unsupported commands. |
| Browser traces leak credentials | High | Redaction at ingestion, bounded payloads, and security contract tests. |
| Office formats add large dependencies | Medium | Native/simple readers first; dependency review before richer editors. |
| Search races display stale results | Medium | Generation/request identity checks plus deterministic tests. |
| One giant screen becomes unmaintainable | Medium | Separate route per workbench and focused components/ViewModels. |

## Success Criteria

- Search, tags, favorites, and commands are globally usable and persist correctly.
- Android can inspect and safely operate every supported capability resource; unsupported
  actions are visibly unavailable with a reason.
- A phone can create/control a browser session and inspect a redacted test trace.
- Office, spreadsheet, PDF, and Notebook artifacts use dedicated previews with bounded
  memory and clear fallback states.
- Focused tests, full Android JVM tests, lint, debug build, runtime navigation, and
  accessibility checks pass; the capability matrix links to evidence.

## Open Decisions

- Browser engine ownership (bridge-managed Chromium vs. attached browser) must be
  selected before Phase 3 implementation.
- Office editing library and licensing must be approved before Phase 4 editing.
- Automation scheduling semantics and persistence need a backend contract before an
  Android enable/disable control is exposed.

