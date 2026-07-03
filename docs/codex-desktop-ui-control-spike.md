# Codex Desktop UI Control Spike

Date: 2026-07-01

## Goal

Check whether the mobile/web terminal can drive the real Codex Desktop App UI by desktop automation, instead of relying on CLI `resume` or app-server-only clients.

## Target

Detected real Codex Desktop window:

```text
Process: Codex.exe
PID: 41144
HWND: 0xCD00BA8
Title: Codex
ClassName: Chrome_WidgetWin_1
```

The window is Electron/Chromium-based, but Windows UI Automation exposes its accessibility tree.

## Findings

UI Automation can enumerate Codex Desktop UI content and controls. The target composer is visible as an Edit control:

```text
Name: 向 Agent 发送消息
ControlType: Edit
Bounds: 1635,1252,690,56
```

The send button is visible as a Button control:

```text
Name: 发送
ControlType: Button
Bounds: 2334,1253,53,54
Pattern: InvokePattern
```

## Tests

### ValuePattern draft write

Using UIA `ValuePattern.SetValue(...)` can set and read the edit value:

```text
Draft: DESKTOP_UIA_DRAFT_PROBE_025128
ReadBack: DESKTOP_UIA_DRAFT_PROBE_025128
Result: pass
```

However, this does not trigger the Codex front-end input event. The send button remains disabled after `SetValue`, so `ValuePattern` alone is not enough for real sending.

### Keyboard SendKeys

Trying to focus the UIA Edit and send text with `SendKeys` did not reliably enter text:

```text
ReadBack: empty
SendEnabledAfterKeyboardInput: false
Result: fail
```

This suggests UIA focus is not necessarily the same as the active DOM editor focus inside Electron.

### Mouse click + clipboard paste

Clicking the composer center, setting the clipboard, and sending `Ctrl+V` worked:

```text
Draft: DESKTOP_CLIPBOARD_PROBE_025346
ReadBack: DESKTOP_CLIPBOARD_PROBE_025346
SendEnabledAfterPaste: true
SendHasInvokePattern: true
ReadAfterClear: empty
ClickPoint: 1980,1280
Result: pass
```

This proves the practical automation route:

1. Find Codex Desktop window by process/title.
2. Find composer Edit by UIA name `向 Agent 发送消息`.
3. Bring window to foreground.
4. Click the composer center.
5. Paste text through the clipboard.
6. Invoke or click the `发送` button.

## Conclusion

Forcing input into Codex Desktop App is feasible on this machine, but the reliable path is not pure UIA `SetValue`. It should use UIA for discovery and coordinates, then clipboard paste for real DOM input events.

This route can make Codex Desktop itself visibly receive the message, because it literally drives the Desktop App UI.

Risks:

- It requires the Codex Desktop window to be present and unlocked.
- It steals foreground focus while sending.
- Clipboard contents are temporarily overwritten unless the bridge saves and restores them.
- UI labels and layout may change with Codex updates or localization.
- Sending should include guardrails to avoid injecting into the wrong window or the browser tab.

Recommended next POC:

- Add a local-only endpoint that runs the discovery and draft-paste verification.
- Add a separate guarded endpoint to actually send a prompt into Codex Desktop.
- Before sending, require the detected window title, process path, input name, and send button state to match expected values.
- Save and restore clipboard contents.
- Return a screenshot-free audit record with detected bounds, action status, and any UIA mismatch.
