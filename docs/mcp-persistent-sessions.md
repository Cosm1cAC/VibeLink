# MCP Persistent Sessions

## Goal

The Rust migration for MCP keeps the existing MCP JSON-RPC semantics while moving the stdio process pool, request queue, timeout handling, restart behavior, and backpressure into a lower-latency data plane.

## Current Node Slice

`src/mcpSessionManager.js` owns the current Node implementation. When `VIBELINK_MCP_PERSISTENT_SESSIONS=1` is enabled, `src/mcpRuntime.js` reuses long-lived stdio sessions for probe and tool-call paths instead of spawning a fresh MCP server per request.

The Node manager already covers:

- session reuse keyed by server command, args, cwd, and env
- one-time initialize plus cached `tools/list`
- `tools/call`
- pending-request backpressure
- request timeout shutdown
- closed/crashed session replacement
- idle session pruning
- runtime health counters exposed through MCP status

## Rust Sidecar Contract

`src/mcpSessionContract.js` owns the shared method allowlist and error envelope for the Rust-ready sidecar contract. `src/mcpSessionSidecarClient.js` speaks a stdio JSONL shape:

```json
{"id":1,"method":"probeStdioServer","args":[{"id":"server","command":"node","args":["mcp-server.js"]},{"timeoutMs":5000}]}
{"id":1,"result":{"ok":true,"transport":"stdio","tools":[{"name":"echo"}]}}
```

The current contract methods are:

- `probeStdioServer`
- `listTools`
- `callTool`
- `closeIdleSessions`
- `closeAll`
- `stats`

`test/mcpSessionSidecarContract.test.js` runs that protocol against both `test/fixtures/mcp-session-json-sidecar.js`, which adapts the existing Node session manager, and the real Rust `apps/windows` `mcp-session-sidecar` subcommand. This keeps the production MCP path unchanged while locking compatibility for session reuse, tool-cache behavior, tool calls, stats, error envelopes, close, multi-server burst behavior, in-flight stats, and sidecar pending-request backpressure.

The Rust sidecar now runs stdio work behind a bounded sidecar request scheduler instead of blocking the JSONL reader on every MCP call. It keeps per-session stdio access serialized, but allows control calls such as `stats` to return while a long `tools/call` is in flight and rejects excess global work with a backpressure error when the active-request cap is reached. It implements initialize reuse, cached `tools/list`, `tools/call`, per-request timeout handling, crashed-session replacement, idle close, close-all, and per-session plus aggregate stats. When `VIBELINK_MCP_RUST_SIDECAR=1` is enabled, stdio MCP probe and tool-call paths route through `src/mcpSessionSidecarClient.js`. The client exposes local queue/backpressure counters through runtime status, including pending requests, max pending observed, request/response/failure counts, timeout counts, and backpressure rejections. If the sidecar fails to start or reply, the runtime records a fallback counter, closes the failed sidecar client, and falls back to the existing Node stdio path.

Optional runtime overrides:

- `VIBELINK_MCP_RUST_SIDECAR_COMMAND`: sidecar executable path.
- `VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON`: JSON array of sidecar arguments. Defaults to `["mcp-session-sidecar"]`.
- `VIBELINK_MCP_SESSION_SIDECAR_MAX_ACTIVE_REQUESTS`: global active Rust sidecar request cap. Defaults to `64`; excess probe/list/call requests are rejected with a backpressure error while control calls still run.

## Next Slices

- Add runtime metrics comparisons before turning the sidecar on by default.
- Decide whether to keep the sidecar process model or replace it with a native module after Windows packaging costs are known.
