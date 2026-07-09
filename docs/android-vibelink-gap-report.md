# Android VibeLink parity and UX gap report

Date: 2026-07-09

This report captures the Android/Web parity and mobile UX gaps identified during review. It is intended to drive implementation work until Android reaches full VibeLink capability parity where practical, with mobile-native substitutions where direct Web behavior does not apply.

## Executive summary

The Android direction is sound: it uses native Jetpack Compose rather than a WebView and implements the core VibeLink surfaces: login/pairing, session list, VibeLink Agent composer, Codex Desktop Remote, Workspace, Settings/Approvals, tool events, and Live Call Assistant.

However, Android is currently core-capability aligned rather than full parity with the Web VibeLink experience. The largest gaps are:

1. Message-level actions and rich rendering are weaker than Web.
2. Workspace/Git/Terminal/Test support is a subset.
3. Settings, security, devices, audit, Cloudflare, and MCP/admin surfaces are incomplete.
4. Android-native notifications, background lifecycle, and system share entry points are not productized.
5. UI feels closer to an engineering control panel than a mature mobile chat app like Grok/OpenAI.

## Current design assessment

### What is reasonable

Android has a clear product split:

- **Codex Desktop Remote**: controls an existing Codex Desktop session and inherits the desktop runtime settings.
- **VibeLink Agent**: uses the VibeLink-controlled runtime.
- **Live Call Assistant**: captures live context and routes questions into the VibeLink Agent path.

This separation matches the documented VibeLink architecture and keeps Android aligned with Web by reusing the bridge REST/SSE/WebSocket APIs rather than inventing a separate backend.

### Main design flaw: navigation state is not durable enough

`VibeLinkApp` parses a `conversationKey` in the route but still depends on an in-memory `pendingConversation`. If the process is killed, a route is restored, or a deep link/share flow enters a conversation, the route can exist while the conversation object is missing.

Required direction:

- Make `conversationKey` a real stable conversation identifier.
- Resolve the conversation from repository/API/session state when opening the message screen.
- Avoid relying on in-memory handoff for critical navigation.

## Mobile chat UX gaps versus Grok/OpenAI-style apps

### P0/P1: Dark mode

Android currently has a light-only theme. A chat app used for long sessions and code review needs system-following dark mode plus contrast checks for message bubbles, code blocks, tool cards, banners, and navigation/status bars.

Required direction:

- Add `darkColorScheme()`.
- Use `isSystemInDarkTheme()`.
- Verify accessible contrast in both themes.

### P0/P1: Voice/live entry is not integrated into the main composer

Live Call is powerful but isolated as its own control-panel-like page. In a mature mobile chat app, voice/live should also be reachable from the primary composer.

Required direction:

- Add a mic/live button to the main composer.
- Keep the dedicated Live Call page for advanced controls.
- Move diagnostics and provider-specific debug controls behind an Advanced section.

### P1: Streaming feedback is not chat-native

Android shows a global working row/progress indicator instead of an assistant bubble that streams in place.

Required direction:

- Create/update a streaming assistant placeholder bubble during a running turn.
- Attach tool cards to the active assistant turn.
- Keep global progress only as secondary status.

### P1: Touch ergonomics and information density

Several screens feel dense, with small or crowded controls. Workspace also silently truncates file/status/diff content.

Required direction:

- Ensure tappable controls are at least 48dp where practical.
- Move secondary actions into overflow menus.
- Add show-more/search/pagination where lists are truncated.
- Label truncated diffs and provide a full-diff path.

### P1/P2: Empty and error states are too plain

Empty states are currently minimal and do not guide the user.

Required direction:

- Add welcome prompts and suggested actions.
- Add context-aware prompt chips.
- Add retry/open settings/open approvals actions to error states.

## Web parity gaps

### 1. Chat/composer parity

Android has provider chips, model override, reasoning effort, cwd, send, and stop. Missing or incomplete parity includes:

- Attachments/files/images/folders.
- Slash command menu.
- Prompt history.
- Full workspace context picker.
- Mobile replacement for drag/drop via Android system share and pickers.

Required direction:

- Add Android-native file/image/share entry points.
- Add slash-command discovery or a mobile command picker.
- Add prompt history recall.
- Improve workspace context attachment flow.

### 2. Message rendering and actions

Android message bubbles currently render role/text/tool summaries. Web has richer rendering and actions.

Missing or incomplete:

- Copy message.
- Edit message.
- Regenerate response.
- Delete message.
- Collapse/expand long turns.
- Code block copy.
- Markdown/GFM/code rendering parity.
- Image gallery.
- Artifact preview/link handling.
- Locate/open referenced file.

Required direction:

- Add message overflow actions.
- Add Markdown/code/image/artifact rendering improvements.
- Add safe edit/regenerate/delete flows through existing backend contracts or add contracts where missing.

### 3. Tool events lifecycle

Android currently presents lightweight tool summaries. It needs the Web-style lifecycle reducer rather than simple appended synthetic messages.

Required direction:

- Model tool runs by stable run id.
- Track input, output, running, approval, success, failure, and cancellation states.
- Attach tool runs to the correct assistant turn.
- Fold large payloads and support expand/copy.

### 4. Workspace/Git/Terminal/Test depth

Android has workspace list/tree, preview, git status/diff, stage/unstage/restore, stage all/unstage all, and command runner. Missing or incomplete:

- Test tab/test result view.
- Commit/push/pull/PR flows.
- File search.
- File edit.
- Branch/stash/worktree controls.
- Per-hunk staging.
- Conflict guide.
- Richer terminal/PTTY behavior.
- Full diff/pagination.

Required direction:

- Add visible controls for show more/search/full diff.
- Add test execution/results surface.
- Add commit/push/pull/PR operations where backend support exists; otherwise define backend contracts first.
- Add file edit and branch/stash/worktree flows incrementally.

### 5. Settings, approvals, security, and admin surfaces

Android has runtime settings and approvals, but not the full management surface.

Missing or incomplete:

- Devices/pairing session management.
- Audit log.
- Host allowlist.
- Cloudflare guidance/config.
- Web Push/native push settings.
- MCP/browser fetch/tool retention/admin controls.

Required direction:

- Split settings into Chat, Voice, Security, Integrations, Devices, and Advanced sections.
- Add approvals as a first-class flow with clear retry/continue handling.
- Add devices/audit/allowlist/integration surfaces as backend support allows.

### 6. Live Call correctness and polish

Live Call is comparatively strong, but answer attribution risks exist if deltas/done events are attached to the latest question instead of a stable question/task/event id.

Required direction:

- Correlate transcript, question, task, delta, and done events using stable ids/cursors.
- Avoid last-item-wins reducers.
- Add clear composer-level live entry.

## Correctness and safety issues

### P0/P1: Desktop Remote should fail closed when focus fails

If Android cannot confirm/focus the intended Codex Desktop conversation, it should not continue sending the prompt. Sending after focus failure risks targeting the wrong visible desktop conversation.

Required direction:

- Treat focus failure as a send blocker.
- Show a user-facing error: unable to confirm target conversation.
- Offer refresh/rebind actions.

### P0/P1: Approval handoff needs a stable flow

When a task requires approval, Android should surface a clear approval-required state rather than a generic error.

Required direction:

- Detect approval responses explicitly.
- Append a system/status message with the approval requirement.
- Provide an Open Approvals CTA.
- After approval, allow retry/continue of the original prompt/task.

## Priority roadmap

### P0: Correctness and safety

- Desktop Remote fail-closed targeting.
- Durable conversation route resolution via `conversationKey`.
- Define and implement background/notification behavior for running tasks.

### P1: Web parity and mature chat UX

- Dark mode.
- Streaming assistant bubble.
- Composer mic/live entry.
- Message actions: copy, edit, regenerate, delete, code copy.
- Markdown/code/image/artifact rendering.
- Tool lifecycle reducer parity.
- Workspace show-more/search/full diff/test/commit/push/pull where supported.
- Stable approval handoff.
- Live Call stable event correlation.

### P2: Completion and admin polish

- Device/session management.
- Audit log and security settings.
- Cloudflare/MCP/integration settings.
- Notification preferences.
- Android system share/files/images.
- Richer terminal/PTTY/worktree/stash/per-hunk controls.
- Suggested prompts and onboarding.

## Acceptance target

The implementation effort is complete when Android can be used as the primary VibeLink client for normal work without needing Web for routine chat, message management, workspace inspection, approvals, live/voice entry, and common Git/test operations, while preserving fail-closed behavior for Desktop Remote targeting and clear mobile-native lifecycle behavior for background tasks and notifications.
