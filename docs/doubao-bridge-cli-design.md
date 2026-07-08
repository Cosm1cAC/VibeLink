# Doubao Bridge CLI Design

This document designs the next Doubao CLI as a standalone project that VibeLink can consume, Agent Reach can document, and mainstream coding agents can call from a shell or MCP server.

## Goal

Build a `doubao` CLI that uses an already-running Chrome or Edge session, without starting a new remote-debugging browser process and without extracting cookies.

The default backend is a browser extension bridge:

```text
agent / VibeLink / shell
  -> doubao CLI
  -> local bridge daemon on 127.0.0.1
  -> Chrome extension service worker
  -> Doubao content script in an existing doubao.com tab
  -> page DOM adapter
```

This is deliberately different from the current CDP prototype in `tools/doubao-cli.mjs`. The current prototype controls a dedicated DevTools-enabled Chrome process. The bridge CLI controls the user's normal browser through an installed extension and a local bridge.

## Product Requirements

- No `--remote-debugging-port` requirement.
- No dedicated Chrome profile requirement.
- Reuse the user's existing `doubao.com` login state.
- Work when the browser window is backgrounded or minimized whenever Chrome keeps the tab alive.
- Never read, export, or persist browser cookies.
- Provide agent-friendly output: stable exit codes, `--json`, optional JSONL streaming, and `doctor --json`.
- Be usable as a standalone GitHub/npm project.
- Be callable by VibeLink through a normal executable path.
- Be easy to add to Agent Reach references in the same style as OpenCLI-backed platforms.

## Non-Goals

- Running while Chrome is fully closed.
- Bypassing Doubao login, CAPTCHA, rate limits, or account restrictions.
- Reverse engineering Doubao private Web APIs for a first release.
- Guaranteeing work in a discarded/suspended tab. The CLI should detect and recover when possible.

## Repository Shape

Recommended standalone repo name: `doubao-cli`.

```text
doubao-cli/
  package.json
  pnpm-workspace.yaml
  README.md
  docs/
    protocol.md
    agent-reach.md
    security.md
    troubleshooting.md
  packages/
    protocol/
      src/schemas.ts
      src/messages.ts
    cli/
      src/bin/doubao.ts
      src/commands/ask.ts
      src/commands/doctor.ts
      src/commands/login.ts
      src/commands/daemon.ts
      src/commands/mcp.ts
    bridge/
      src/daemon.ts
      src/http.ts
      src/ws.ts
      src/extension-registry.ts
      src/request-queue.ts
    doubao-adapter/
      src/dom-adapter.ts
      src/selectors.ts
      src/extract-answer.ts
    mcp/
      src/server.ts
  apps/
    extension/
      manifest.json
      src/service-worker.ts
      src/content/doubao-content.ts
      src/options.ts
  agent-reach/
    references/doubao.md
  test/
    protocol/
    cli/
    bridge/
    adapter-fixtures/
```

Use TypeScript, ESM, Node 22+, Zod schemas, and the Spec/Handler pattern for command internals.

## Command Surface

The binary name should be `doubao`.

```bash
doubao configure --json
doubao doctor --json
doubao login
doubao ask "写一个摘要"
doubao ask --prompt "写一个摘要" --json
echo "写一个摘要" | doubao ask --stdin --json
doubao ask "写一个摘要" --stream --jsonl
doubao daemon start
doubao daemon status --json
doubao daemon stop
doubao mcp serve
```

Recommended options:

```text
--json                  Emit one JSON object.
--jsonl                 Emit JSON Lines events.
--format text|json|yaml Output format, Agent Reach friendly.
--stdin                 Read prompt from stdin.
--timeout-ms <ms>       Default 120000.
--conversation current|new
--url <url>             Default https://www.doubao.com/chat/
--bridge-url <url>      Default from config.
--token <token>         Usually read from config/env.
--no-fallback           Disable CDP fallback if VibeLink wires one.
```

Plain text remains the default for human shell use. Agents should use `--json` or `--jsonl`.

## JSON Contracts

### `doubao ask --json`

```json
{
  "ok": true,
  "provider": "doubao",
  "backend": "extension_bridge",
  "model": "doubao-web",
  "text": "answer text",
  "url": "https://www.doubao.com/chat/...",
  "conversation": {
    "mode": "current"
  },
  "elapsedMs": 8421
}
```

### `doubao ask --stream --jsonl`

```jsonl
{"type":"status","stage":"bridge_connected"}
{"type":"status","stage":"tab_ready"}
{"type":"status","stage":"prompt_submitted"}
{"type":"delta","text":"partial answer"}
{"type":"final","text":"complete answer","elapsedMs":8421}
```

### Errors

All JSON errors should be values, not stack traces:

```json
{
  "ok": false,
  "error": {
    "code": "LOGIN_REQUIRED",
    "message": "Doubao is open but the page is not authenticated.",
    "recoverable": true,
    "suggestion": "Run doubao login, sign in in Chrome, then retry."
  }
}
```

Stable error codes:

```text
BRIDGE_OFFLINE
EXTENSION_OFFLINE
EXTENSION_NOT_INSTALLED
DOUBAO_TAB_MISSING
TAB_DISCARDED
LOGIN_REQUIRED
EDITOR_NOT_FOUND
SEND_FAILED
ANSWER_TIMEOUT
ANSWER_EMPTY
RATE_LIMITED
UNSUPPORTED_UI
PERMISSION_DENIED
UNKNOWN_ERROR
```

## Bridge Protocol

The local daemon binds to `127.0.0.1` only and stores a random bearer token in config. The extension connects outbound to the daemon by WebSocket.

CLI request:

```json
{
  "id": "req_01",
  "method": "doubao.ask",
  "params": {
    "prompt": "hello",
    "timeoutMs": 120000,
    "conversation": "current",
    "stream": false
  }
}
```

Daemon routes the request to the active extension connection:

```json
{
  "id": "req_01",
  "type": "rpc",
  "method": "doubao.ask",
  "params": {
    "prompt": "hello",
    "timeoutMs": 120000,
    "conversation": "current"
  }
}
```

Extension returns:

```json
{
  "id": "req_01",
  "ok": true,
  "result": {
    "text": "answer",
    "url": "https://www.doubao.com/chat/..."
  }
}
```

Only one active write request should run per Doubao tab. The daemon should queue or reject concurrent `ask` requests with a recoverable `BUSY` error.

## Extension Design

Manifest V3 extension permissions:

```json
{
  "permissions": ["tabs", "scripting", "storage"],
  "host_permissions": [
    "https://www.doubao.com/*",
    "http://127.0.0.1/*",
    "ws://127.0.0.1/*"
  ]
}
```

Responsibilities:

- Maintain a WebSocket connection to the local daemon.
- Find or open a `doubao.com/chat` tab in the existing browser.
- Inject or message the Doubao content script.
- Keep adapter code origin-scoped to Doubao.
- Report login/page/readiness status for `doctor`.
- Recover from discarded tabs by reloading or reopening the Doubao tab when allowed.

Manifest V3 service workers are not persistent background pages. Chrome documentation says active WebSocket traffic can extend the service worker lifetime, but the design should still tolerate worker restarts. The daemon should treat extension disconnects as normal and let the extension re-register.

## Doubao Content Adapter

The adapter is the only Doubao-specific part. It should expose these operations:

```ts
interface DoubaoPageAdapter {
  diagnose(): Promise<PageDiagnosis>;
  sendPrompt(input: SendPromptInput): Promise<SendPromptResult>;
  readLatestAnswer(input: ReadAnswerInput): Promise<ReadAnswerResult>;
  waitForStableAnswer(input: WaitForAnswerInput): Promise<WaitForAnswerResult>;
}
```

The adapter should avoid brittle single selectors. Use layered detection:

- visible text editor candidates: `textarea`, `[contenteditable=true]`, `[role=textbox]`, known Doubao editor classes
- send button candidates: explicit selector, accessible label, icon button near editor
- answer candidates: assistant/message/markdown containers, then body delta fallback
- generation state: stop button, loading indicator, answer text stability window

The adapter should not use arbitrary remote code execution. The service worker sends typed commands; the content script owns all DOM logic.

## Background and Minimized Behavior

This route can work while Chrome is minimized or the Doubao tab is not focused, because the extension can message content scripts in background tabs. It cannot promise success if Chrome discards the tab under memory pressure.

Mitigations:

- Set the Doubao tab as non-auto-discardable when the API supports it.
- Keep a heartbeat from content script to extension while a request is active.
- Detect `tab.discarded` and reload before sending a prompt.
- Return `TAB_DISCARDED` or `DOUBAO_TAB_MISSING` with a clear suggestion if recovery fails.
- Provide `doubao login` and `doubao open` to focus the page only when user interaction is required.

## Local State

Default config directory:

```text
Windows: %APPDATA%\doubao-cli\
macOS:   ~/Library/Application Support/doubao-cli/
Linux:   ~/.config/doubao-cli/
```

Config contents:

```json
{
  "bridge": {
    "port": 45771,
    "token": "random-256-bit-secret",
    "autoStart": true
  },
  "browser": {
    "preferred": "chrome",
    "extensionId": ""
  },
  "doubao": {
    "url": "https://www.doubao.com/chat/",
    "conversation": "current",
    "timeoutMs": 120000
  }
}
```

No cookies, session tokens, localStorage dumps, or Doubao credentials are stored.

## Security Model

- Local daemon binds only to loopback.
- Every CLI-to-daemon and extension-to-daemon request must include the bridge token.
- The extension only has host permissions for Doubao and local loopback bridge endpoints.
- The daemon accepts a strict method allowlist.
- Content scripts run only on Doubao origins.
- Logs must redact prompts by default unless `--verbose` or debug logging is enabled.
- `doctor --json` should report configuration and readiness, not secrets.

Native Messaging can be added later for better autostart and enterprise install flows. Chrome's native messaging model starts a registered host process and communicates over stdio, so it is useful for a polished installer but not required for the first bridge release.

## VibeLink Integration

VibeLink should treat the standalone CLI as the primary backend:

```text
DOUBAO_COMMAND=auto
auto resolution:
  1. external `doubao` from PATH
  2. configured absolute command
  3. bundled CDP fallback `tools/doubao-cli.mjs`
```

VibeLink task mapping:

```bash
doubao ask --json --prompt "<task prompt>" --timeout-ms 120000
```

VibeLink status mapping:

```bash
doubao doctor --json
```

The existing `/api/doubao/status`, `/api/doubao/ask`, and `agent: "doubao"` surfaces can remain stable. Only `src/doubaoRuntime.js` needs to learn the external CLI command before falling back to the current bundled CDP script.

## Agent Reach Integration

Add `agent-reach/references/doubao.md` to the standalone repo, then copy or install it into Agent Reach.

Recommended reference content:

````md
## Doubao / 豆包

Doubao uses `doubao-cli` with a Chrome extension bridge. It reuses the user's existing doubao.com browser login state and does not require `--remote-debugging-port`.

Run diagnosis first:

```bash
doubao doctor --json
```

If login is required:

```bash
doubao login
```

Ask:

```bash
doubao ask "写一个摘要" --json
echo "写一个摘要" | doubao ask --stdin --json
```

For long answers:

```bash
doubao ask "..." --stream --jsonl
```

Requires Chrome or Edge to be running with the Doubao Bridge extension installed and a logged-in doubao.com tab/session.
````

Agent Reach doctor can classify this as:

```json
{
  "doubao": {
    "active_backend": "doubao-cli",
    "backend_type": "extension_bridge",
    "requires_browser": true,
    "requires_extension": true,
    "requires_login": true
  }
}
```

## Mainstream Agent Compatibility

Shell-first:

```bash
doubao ask --json --prompt "..."
```

MCP:

```bash
doubao mcp serve
```

Suggested MCP tools:

- `doubao_ask`
- `doubao_status`
- `doubao_open`
- `doubao_configure`

This gives Codex, Claude Code, Gemini CLI, Continue, and custom MCP clients a stable interface without embedding VibeLink.

## Implementation Plan

1. Protocol and CLI shell
   - Add Zod schemas for request/result/error contracts.
   - Implement `ask`, `doctor`, and `daemon status` against a mocked bridge.
   - Tests prove JSON contracts and exit codes.

2. Bridge daemon
   - Add local HTTP and WebSocket endpoints.
   - Add token auth, extension registry, and single-request queue.
   - Tests use a fake extension WebSocket.

3. Chrome extension
   - Add MV3 service worker, WebSocket registration, tab discovery, and content script messaging.
   - Add `doctor` status reporting.

4. Doubao adapter
   - Implement DOM diagnosis, prompt insertion, send action, and stable answer extraction.
   - Add DOM fixture tests for selectors and answer extraction.

5. VibeLink adapter
   - Prefer external `doubao` command in `src/doubaoRuntime.js`.
   - Keep bundled CDP fallback for users without the extension.

6. Agent Reach packaging
   - Add `agent-reach/references/doubao.md`.
   - Document install, doctor, ask, and troubleshooting paths.

## Key Tradeoff

This bridge is the best match for "no new Chrome process" and "reuse existing browser login". The cost is installation complexity: users need a Chrome extension and a local daemon. That cost is acceptable because the same bridge pattern can later support other login-backed web CLIs.

## References

- Chrome Extensions native messaging: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- Chrome extension service worker lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Chrome extension tabs API: https://developer.chrome.com/docs/extensions/reference/api/tabs
