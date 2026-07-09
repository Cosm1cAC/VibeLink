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

`test/mcpSessionSidecarContract.test.js` runs that protocol against both `test/fixtures/mcp-session-json-sidecar.js`, which adapts the existing Node session manager, and the real Rust `apps/windows` `mcp-session-sidecar` subcommand. This keeps the production MCP path unchanged while locking compatibility for session reuse, tool-cache behavior, tool calls, stats, error envelopes, close, and sidecar pending-request backpressure.

The Rust sidecar currently implements a synchronous stdio session pool with initialize reuse, cached `tools/list`, `tools/call`, idle close, close-all, and stats. It is ready for opt-in runtime routing but is not yet the default MCP data plane.

## Next Slices

- Add an opt-in runtime flag that routes stdio MCP probe/call paths through the sidecar client with Node fallback.
- Expand Rust-side timeout, restart, and backpressure counters to match the Node manager under high concurrency.
- Add high-concurrency smoke tests for multiple MCP servers and slow tool calls before turning the sidecar on by default.
