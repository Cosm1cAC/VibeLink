# Android Handoff Gap Closure TODO

Generated from the prior Android handoff review and the current `codex/android-handoff-gaps` branch state. The final closure status is now captured in `docs/android-parity-closure-report.md`.

## Already completed by previous commits

- [x] Restore message routes from `conversationKey` after pending state is lost.
- [x] Block targeted Desktop Remote sends when focus confirmation fails.
- [x] Add explicit approval handoff with Settings > Approvals and retry context.
- [x] Correlate Live Call QA answers by stable question/task identifiers.
- [x] Add system-following dark mode.
- [x] Add Live Call entry point to the main composer.
- [x] Add streaming assistant bubble behavior and attach tool cards to active turns.
- [x] Add prompt history and quick command chips.
- [x] Add message copy and code-block copy actions.
- [x] Add Workspace search/show-more/full-diff/test/git actions.
- [x] Add Android share and foreground notification polish.

## Completed in this session

- [x] Add file-reference extraction utility and tests.
- [x] Surface detected file references in chat message actions.
- [x] Add or update focused tests for file-reference behavior.
- [x] Add Android message edit/delete/regenerate reducers and focused tests.
- [x] Surface edit/delete/regenerate in the Android message action menu.
- [x] Add native image/file picker buttons to the Android composer.
- [x] Upload picked attachments through `/api/attachments` and inject markdown/preview prompt text.
- [x] Add Android Settings admin summaries for devices, pending pairing sessions, audit logs, MCP status, and Doctor checks.
- [x] Add Android device revoke and pairing approve/deny actions.
- [x] Add Workspace file write/rename/delete routes and Android file editor controls.
- [x] Add branch create/switch, stash push/pop, worktree creation, per-hunk stage, and conflict-resolution actions.
- [x] Add Android PTY terminal session controls with input, resize, stop, and tool-event output polling.
- [x] Add richer Markdown rendering plus image/artifact link chips in Android message bubbles.
- [x] Add direct file-reference open from chat into Workspace file preview, with copy still available.
- [x] Add Cloudflare guidance, tool-event retention/prune controls, MCP probe controls, and Doctor summaries in Settings.
- [x] Add a tested mobile runtime policy for weak network, background catch-up, notification permission, foreground audio, and multi-device sync decisions.
- [x] Add native push token registration, FCM credential configuration, and server-side native push delivery path.
- [x] Add settings export/import endpoints with dry-run preview plus Android Settings controls.
- [x] Add inline Android image thumbnail gallery using Coil while preserving artifact link actions.

## Verification

- [x] Baseline Android unit tests: `apps/android/.\gradlew.bat testDebugUnitTest`
- [x] Focused Android unit tests after final slice: `apps/android/.\gradlew.bat :app:testDebugUnitTest --tests "com.vibelink.app.ui.screens.MessageContentUtilsTest"`
- [x] Focused Android message reducer tests: `apps/android/.\gradlew.bat :app:testDebugUnitTest --tests "com.vibelink.app.ui.screens.MessageListReducerTest"`
- [x] Focused Android Workspace/mobile tests: `apps/android/.\gradlew.bat :app:testDebugUnitTest --tests "com.vibelink.app.ui.screens.WorkspaceDiffUtilsTest" --tests "com.vibelink.app.mobile.MobileResiliencePolicyTest"`
- [x] Focused backend workspace tests: `node --test test/workspacesFileMutation.test.js test/workspacesGitDepth.test.js test/workspacesWorktree.test.js`
- [x] Focused backend settings/native push tests: `node --test test/settingsImportExport.test.js test/nativePushSubscription.test.js`
- [x] Final Android unit test suite: `apps/android/.\gradlew.bat testDebugUnitTest`
- [x] Review diff for scope and secrets.
- [ ] Stage, commit, and push current branch.
