# Doubao Web CLI

VibeLink can use Doubao through the free web chat by controlling a browser tab that you have already logged into. The implementation does not reverse engineer private Doubao APIs and does not store web cookies in VibeLink.

This file documents the current CDP-based fallback. The next standalone extension-bridge CLI design is in [doubao-bridge-cli-design.md](doubao-bridge-cli-design.md).

## Start Browser Session

On Windows, start a dedicated Chrome profile with DevTools enabled:

```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir=$env:USERPROFILE\.vibelink\doubao-chrome https://www.doubao.com/chat/
```

Log into Doubao in that browser window once. Keep the window open while using VibeLink.

## Use From VibeLink

- In the web UI, choose `豆包` from the Agent selector.
- Through HTTP, call `POST /api/tasks` with `agent: "doubao"`.
- For direct tool use, call `POST /api/doubao/ask` with `{ "prompt": "..." }`.
- Check setup with `GET /api/doubao/status`.

Default settings:

- `doubaoCommand`: `auto`
- `doubaoCdpEndpoint`: `http://127.0.0.1:9222`
- `doubaoUrl`: `https://www.doubao.com/chat/`

If the Doubao web UI changes, configure selectors with environment variables:

- `DOUBAO_EDITOR_SELECTOR`
- `DOUBAO_SEND_SELECTOR`
- `DOUBAO_RESPONSE_SELECTOR`
