# Android Handoff Gap Closure Plan

## Goal

Close the gaps listed in `docs/android-handoff.md` by verifying the previous Android parity work, finishing the remaining Android-native parity slices, and keeping the app testable after every increment. This plan treats the report as a matrix, not a single bug: correctness/safety items first, then chat-native UX, then Web parity surfaces, then remaining platform-depth items.

## Current state

Previous agents have already landed the major P0/P1 Android parity fixes on `codex/android-handoff-gaps`:

- Conversation route restore now uses `conversationKey` plus session-list data instead of relying only on in-memory pending state.
- Desktop Remote sends now fail closed when targeted focus cannot be confirmed.
- Approval handoff detects 428/approval responses, surfaces Settings > Approvals, and keeps retry context.
- Live Call QA pairs now correlate on `questionId`/`taskId` instead of last-item-wins.
- Dark mode follows the system theme.
- Main composer includes quick commands, prompt history, and a Live Call mic entry point.
- Streaming assistant turns and tool calls are merged into the active assistant bubble.
- Workspace now has file search, show-more controls, full-diff reveal, test command, commit/pull/push/PR actions, and 48dp row targets.
- Android share and foreground notification polish are present.

This session continues from that baseline. The completed Android handoff slice covers message-level file references and edit/delete/regenerate actions, native file/image attachments in the composer, Workspace file/Git/PTTY depth, richer message output links, Settings admin summaries, and tested mobile runtime policy decisions.

## Ordered phases

### Phase 1: Verify Existing Progress

1. Read `docs/android-handoff.md` and map each P0/P1/P2 gap against current Android code.
2. Check current branch, uncommitted diff, and recent commit history to avoid duplicating previous work.
3. Run Android unit tests to establish a green baseline.

### Phase 2: Finish Message-Level Interactions

1. Keep the existing file-reference extraction helper and test coverage.
2. Surface detected file references as message actions in Android chat bubbles.
3. Add edit/delete/regenerate operations with ViewModel reducer tests.
4. Support copying either a single file reference or all detected file references.
5. Keep actions touch-friendly and avoid introducing backend dependencies unless a concrete open-file route exists.

### Phase 3: Composer Attachments and Native Share

1. Add native image/file pickers to the Android composer.
2. Upload selected files through the existing bridge `/api/attachments` endpoint.
3. Inject the returned markdown and text preview into the prompt using the same attachment-preview convention as the Web composer.
4. Preserve the existing Android share intent path for text/image/file handoff.

### Phase 4: Settings/Admin Parity

1. Add Android API models/client methods for `/api/devices`, `/api/pairing-sessions`, `/api/audit-log`, `/api/mcp/status`, and `/api/doctor`.
2. Surface paired devices, current device state, pending pairing requests, audit log rows, MCP server summary, and Doctor failures/warnings in Settings.
3. Allow revoking non-current devices and approving/denying pending pairing requests from Android.

### Phase 5: Platform-Depth Work Completed In This Slice

1. Workspace depth now includes file edit/create/delete/rename, branch create/switch, stash push/pop, worktree creation, per-hunk stage, conflict actions, and PTY terminal session controls.
2. Output parity now includes Markwon Markdown rendering, code-copy actions, file-reference chips that open into Workspace, inline image thumbnails/gallery, and artifact links that open through Android URI handling.
3. Settings depth now includes Cloudflare guidance, notification email/Web Push/native push visibility and FCM credential configuration, tool-event retention/prune controls, settings import/export with dry-run preview, audit/device/pairing summaries, MCP probe controls, and Doctor summaries.
4. Mobile resilience now has a tested policy for weak-network polling, background catch-up, notification permission prompts, foreground microphone service decisions, and multi-device sync state.

### Phase 6: Verification and Handoff

1. Run focused Android unit tests after each slice.
2. Run the Android debug unit test suite.
3. Review `git diff` for scope, secrets, and accidental unrelated edits.
4. Stage only Android handoff files and `tasks/*`; leave unrelated Rust/event-store sidecar work untouched.
5. Commit and push the completed Android handoff slice.

## Acceptance Criteria

- [x] Every concrete P0/P1 item in `docs/android-handoff.md` is either implemented or explicitly documented as already implemented by prior commits.
- [x] Chat messages expose file-reference actions when assistant output mentions repo files.
- [x] Chat messages expose copy/edit/delete/regenerate actions where appropriate.
- [x] The Android composer can attach images/files through the bridge attachment endpoint.
- [x] Settings exposes device, pairing, audit, MCP, and Doctor summaries.
- [x] Android unit tests pass with the new message-content behavior.
- [ ] Working tree is committed and pushed to `origin/codex/android-handoff-gaps`.

## Verification Commands

```powershell
cd apps/android
.\gradlew.bat testDebugUnitTest
```

```powershell
node --test test/workspacesFileMutation.test.js test/workspacesGitDepth.test.js test/workspacesWorktree.test.js test/settingsImportExport.test.js test/nativePushSubscription.test.js
```
