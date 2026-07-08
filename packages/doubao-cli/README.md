# doubao-cli

Agent-friendly Doubao web CLI that reuses the user's existing browser login through a Chrome or Edge extension bridge.

This package does not open Chrome with `--remote-debugging-port`, does not read cookies, and does not reverse engineer Doubao private APIs.

## Quick Start

```bash
doubao configure --json
doubao daemon run --json
doubao doctor --json
doubao ask --json --prompt "写一个摘要"
```

`doubao configure --json` writes config, copies a ready-to-load extension directory, starts the local bridge daemon by default, and opens Doubao. Chrome still requires one manual security step: load the unpacked extension path returned in `extension.path`, then log into `https://www.doubao.com/chat/`.

## Agent Usage

```bash
doubao ask --json --prompt "..."
echo "..." | doubao ask --stdin --json
```

`--json` emits one object with stable fields:

```json
{
  "ok": true,
  "backend": "extension_bridge",
  "provider": "doubao",
  "model": "doubao-web",
  "text": "answer"
}
```

## Status

This is the bridge skeleton. It includes:

- CLI commands: `doctor`, `ask`, `daemon run`, `daemon status`
- setup command: `configure`
- local loopback daemon
- extension WebSocket registration
- Doubao content script adapter
- mock end-to-end tests using a fake extension
