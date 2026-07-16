# Android Capability Repair Plan

## Scope

Close the remaining Android capability gaps recorded in `tasks/android-capability-matrix.md`. Each task is a vertical slice with a focused test, a debug build check, and an independently revertible commit. Existing Keystore work is out of scope and must remain isolated.

## Phase 0: Baseline And Contracts

### Task 1: Restore A Clean Android Quality Gate

**Acceptance criteria**

- [ ] `lintDebug` is clean, including CameraX opt-in and camera feature declarations.
- [ ] `testDebugUnitTest` and `assembleDebug` pass from a clean checkout.
- [ ] The Android capability matrix distinguishes implemented, partially implemented, and missing behavior.

**Dependencies:** None.

**Verification:** Run the three Gradle tasks and archive the lint report.

**Scope:** Small; lint/config plus matrix documentation.

### Checkpoint A

- [ ] Clean Android quality gate is reproducible.
- [ ] No user-local or generated files are staged.

## Phase 1: Live Call And Mobile Reliability

### Task 2: Reconnect The Audio WebSocket

**Acceptance criteria**

- [ ] Unexpected WebSocket close/failure keeps the session alive and retries with bounded backoff.
- [ ] Audio recording state, pause state, and PCM output survive reconnect attempts without duplicate sockets.
- [ ] Explicit stop cancels retries and closes the recorder/socket exactly once.

**Dependencies:** Task 1.

**Verification:** Unit-test the retry state machine; run a MockWebServer disconnect/reconnect test; build the debug APK.

**Scope:** Medium; streamer, recovery policy, and tests.

### Task 3: Wire Mobile Resilience To Connectivity And Lifecycle

**Acceptance criteria**

- [ ] Connectivity loss pauses or defers network work according to `MobileResiliencePolicy`.
- [ ] App background/foreground transitions do not create duplicate SSE, polling, or audio jobs.
- [ ] Recovery resumes from the last cursor/checkpoint after connectivity returns.

**Dependencies:** Tasks 2 and existing ViewModel lifecycle fix.

**Verification:** Unit-test policy transitions; instrument process lifecycle and network callbacks; run long-lived disconnect/recovery smoke.

**Scope:** Medium; resilience policy, lifecycle owner, affected ViewModels, tests.

### Task 4: Make Long-Running Live Call Verification Observable

**Acceptance criteria**

- [ ] Reconnect attempts, failures, recovered cursors, and audio state transitions are counted without logging tokens/audio data.
- [ ] A diagnostic screen or test artifact reports a bounded session run and zero duplicate subscriptions.

**Dependencies:** Tasks 2 and 3.

**Verification:** Run a fixed-duration emulator/bridge scenario and inspect the artifact.

**Scope:** Small to medium; instrumentation and test harness.

## Phase 2: Attachments And Message Semantics

### Task 5: Stream And Cancel Attachment Uploads

**Acceptance criteria**

- [ ] Content URIs are size-checked before reading; files above the server limit are rejected locally.
- [ ] Upload uses streaming request bodies with progress and cancellation; no whole-file `readBytes()` path remains.
- [ ] Cancellation removes partial UI state and does not leave an orphaned upload indicator.

**Dependencies:** Task 1.

**Verification:** Unit-test size boundaries/cancellation; MockWebServer verifies streamed bytes and auth; instrument a large-file upload.

**Scope:** Medium; API client, attachment UI/state, tests.

### Task 6: Authenticate Attachment Preview And External Open

**Acceptance criteria**

- [ ] In-app previews send the same bearer authentication as other API calls.
- [ ] External open uses a short-lived authenticated handoff or downloaded content, never an unauthenticated API URL.
- [ ] Expired/unauthorized attachments show a recoverable error.

**Dependencies:** Task 5.

**Verification:** Mock authenticated/401 attachment GETs; device-test preview and external-open flows.

**Scope:** Medium; attachment URL/auth helper, message rendering, tests.

### Task 7: Persist Message Edit/Delete/Regenerate

**Acceptance criteria**

- [ ] Backend contracts exist for edit, delete, and regenerate, with authorization and conflict errors defined.
- [ ] Android actions call those contracts and update UI only after server success.
- [ ] Refresh/re-entry returns the persisted result; failed mutations preserve the original message.

**Dependencies:** Task 1; backend contract decision required.

**Verification:** Server contract tests, ViewModel tests for success/failure, and device refresh/re-entry smoke.

**Scope:** Large; split backend contract, API client, ViewModel/UI, and tests into separate commits.

## Checkpoint B

- [ ] Live Call remains recoverable across network loss.
- [ ] Attachments are bounded, cancellable, and authenticated.
- [ ] Message mutations survive refresh.

## Phase 3: Notifications And Device Lifecycle

### Task 8: Complete FCM Native Push Registration

**Acceptance criteria**

- [ ] Firebase Messaging dependency/configuration is valid for release builds.
- [ ] A `FirebaseMessagingService` obtains/refreshes the token and registers it automatically.
- [ ] `bridge-push` notification channel is created and incoming payloads render on Android 13+.

**Dependencies:** Backend push contract and Firebase project credentials.

**Verification:** JVM token-registration tests; device token-refresh and foreground/background delivery test; verify channel ID.

**Scope:** Large; dependency/config, service, channel, settings fallback, tests.

### Task 9: Rotate And Revoke The Current Device Token

**Acceptance criteria**

- [ ] App installation identity is stable and token rotation is idempotent.
- [ ] Logout/revoke removes the current push subscription server-side.
- [ ] Stale tokens are not re-registered after logout or account switch.

**Dependencies:** Task 8 and existing device APIs.

**Verification:** API contract tests plus device logout/login rotation smoke.

**Scope:** Medium; SettingsStore, ApiClient, ViewModel, tests.

## Phase 4: Task And Workspace Product Gaps

### Task 10: Add Task Change Timeline And Recovery

**Acceptance criteria**

- [ ] `/api/tasks/:id/changes` contract is exposed and cursor-paginated.
- [ ] Android renders changes, catches up after reconnect, and deduplicates by cursor/event ID.
- [ ] Task stop/retry/recovery states remain consistent after process recreation.

**Dependencies:** Task 3 and backend endpoint contract.

**Verification:** API contract, reducer, reconnect, and device process-recreation tests.

**Scope:** Medium; API client, task ViewModel/screen, models, tests.

### Task 11: Complete Workspace Context And Creation/Upsert

**Acceptance criteria**

- [ ] Workspace selection/context reaches Composer and task creation requests.
- [ ] Create/upsert is idempotent and refreshes the selected workspace without stale state.
- [ ] Errors and approval requirements are rendered without losing draft composer content.

**Dependencies:** Task 10 only for shared task context; backend workspace contract.

**Verification:** API contract tests, ViewModel tests, and device create/select/send smoke.

**Scope:** Medium; workspace/composer APIs, ViewModels, UI, tests.

### Task 12: PR Review And Complete Worktree Operations

**Acceptance criteria**

- [ ] Android exposes the supported PR review/read/write contract with approval and audit semantics.
- [ ] Worktree create/list/switch/delete/cleanup states are represented and recover after refresh.
- [ ] Destructive operations require explicit confirmation and server approval where required.

**Dependencies:** Task 11 and backend PR/worktree contract.

**Verification:** Contract/security tests and device workflow smoke against a disposable repository.

**Scope:** Large; split by contract, Git API, UI, and safety tests.

## Phase 5: Discovery, Accessibility, And Polish

### Task 13: Global Command Palette, Full-Text Search, Tags, And Favorites

**Acceptance criteria**

- [ ] Global command palette searches the existing command catalog and routes to the right surface.
- [ ] Full-text search, tags, and favorites persist and are reflected in session/workspace results.
- [ ] Empty, offline, and permission-denied states are explicit.

**Dependencies:** Tasks 7 and 11 for message/workspace data contracts.

**Verification:** Reducer/ViewModel tests and device navigation/search smoke.

**Scope:** Large; split into command palette, search index, and metadata persistence.

### Task 14: Accessibility, Localization, And Rotation Coverage

**Acceptance criteria**

- [ ] Operational/status strings are localized without hard-coded Chinese fallbacks in user-facing paths.
- [ ] Keyboard, TalkBack semantics, navigation, and rotation tests cover core workflows.
- [ ] No duplicate subscriptions, lost drafts, or overlapping controls occur after rotation.

**Dependencies:** Tasks 2-13 as features stabilize.

**Verification:** Compose instrumentation on API 36, accessibility tree checks, and rotation smoke.

**Scope:** Medium; strings, semantics, instrumentation tests.

## Final Checkpoint

- [ ] All tasks are checked off in `android-capability-repair-todo.md`.
- [ ] JVM, instrumentation, debug build, lint, Rust/server contract, and real-bridge smoke checks pass.
- [ ] The capability matrix is updated with evidence links and residual risks.
- [ ] Each task is committed and pushed independently; no unrelated user changes are included.

## Open Decisions

- Backend endpoint shapes for message mutations, task changes, PR review, and workspace upsert must be confirmed before Android implementation.
- Firebase project/application configuration and release signing requirements must be supplied before native push can be marked complete.
- The long-running smoke duration and acceptable reconnect latency need an agreed threshold.
