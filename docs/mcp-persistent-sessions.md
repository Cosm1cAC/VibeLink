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

The Rust sidecar now runs stdio work behind a bounded sidecar request scheduler instead of blocking the JSONL reader on every MCP call. It keeps per-session stdio access serialized, but allows control calls such as `stats` to return while a long `tools/call` is in flight and rejects excess global work with a backpressure error when the active-request cap is reached. It implements initialize reuse, cached `tools/list`, `tools/call`, per-request timeout handling, crashed-session replacement, idle close, close-all, and per-session plus aggregate stats.

When `VIBELINK_MCP_RUST_SIDECAR=1` is enabled, stdio MCP probe and tool-call paths route through `src/mcpSessionSidecarClient.js`. `VIBELINK_MCP_RUST_SIDECAR=auto` enables safe detection: the runtime attempts Rust only when the configured command exists, and it runs a `stats` readiness probe before the first routed MCP request. A missing command in auto mode skips Rust without marking failure. A failed readiness probe, sidecar timeout, invalid response, or request failure records fallback stats, closes the failed sidecar client, and falls back to the existing Node stdio path.

The client exposes local queue/backpressure counters through runtime status, including mode, auto/available/ready/failed state, command/args, pending requests, max pending observed, request/response/failure counts, timeout counts, and backpressure rejections.

Optional runtime overrides:

- `VIBELINK_MCP_RUST_SIDECAR`: set to `1` for explicit opt-in or `auto` for command-exists plus readiness detection.
- `VIBELINK_MCP_RUST_SIDECAR_COMMAND`: sidecar executable path.
- `VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON`: JSON array of sidecar arguments. Defaults to `["mcp-session-sidecar"]`.
- `VIBELINK_MCP_SESSION_SIDECAR_MAX_ACTIVE_REQUESTS`: global active Rust sidecar request cap. Defaults to `64`; excess probe/list/call requests are rejected with a backpressure error while control calls still run.

The Windows Rust launcher resolves packaged commands without relying on the repository layout. Before launching the Node bridge, it uses its own current executable path as the default `VIBELINK_MCP_RUST_SIDECAR_COMMAND`. The same mechanism supplies the event-store and workspace-tree command paths. Existing environment overrides are inherited unchanged, so rollback and custom deployments retain priority.

## Canary Gates

Before moving this slice beyond `opt-in`, run representative probe and tool-call sessions with `VIBELINK_MCP_RUST_SIDECAR=auto` and compare `GET /api/mcp/status` before and after the session:

- `rustSidecar.ready` is `true`, `failed` is `false`, and `lastError` is empty after readiness.
- `rustSidecar.fallbacks` stays at 0 after readiness; any readiness fallback blocks canary for that build.
- `rustSidecar.client.backpressureRejects` and remote `sidecarBackpressureRejects` remain 0 under the representative workload.
- MCP server process spawns are reduced versus the non-persistent Node path for repeated probe/call traffic; cached `tools/list` should avoid repeated tool-list calls for the same server.
- Runtime closes idle sessions cleanly and leaves no pending sidecar requests after drain.

Run the representative production-router canary with:

```bash
npm run mcp-session:canary -- --calls 12 --output .tmp/mcp-session-canary-final.json
```

The 2026-07-11 current-source release run passed all checks. For one probe plus 12 tool calls, the non-persistent Node baseline spawned 13 MCP server processes while Rust auto mode spawned one, a 92.3% reduction. Rust cached `tools/list` after one request, completed all 12 `tools/call` requests, averaged 8.3ms per request versus 74ms for the baseline, recorded zero runtime failures, fallbacks, and client backpressure rejects, drained with zero pending requests, closed one idle session, and left the sidecar inactive.

Run a read-only real-session canary against an installed MCP server and an existing indexed project:

```bash
npm run mcp-session:real-canary -- --calls 3 --output .tmp/mcp-session-real-canary-final.json
```

The 2026-07-11 `codebase-memory-mcp` run discovered 8 graph tools and completed 3 `get_architecture` calls against the repository's indexed project. Calls averaged 32.6ms with a 45.5ms maximum. Auto mode started one Rust sidecar, recorded zero failures, fallbacks, backpressure rejections, and pending requests, then closed the single real MCP session and terminated the sidecar cleanly. The output records counts and timings but does not persist tool response content.

The same harness accepts an explicit stdio MCP implementation. Use repeatable `--server-arg` options on Windows; `--server-args-json` remains available for programmatic callers. Explicit servers default to an empty tool-arguments object, while `--arguments-json` can provide a non-empty object. Artifacts record only argument keys, never argument values or tool response content.

```powershell
node tools/mcp-session/real-canary.mjs `
  --server headroom `
  --server-command "$HOME\.local\bin\headroom.exe" `
  --server-arg mcp --server-arg serve `
  --tool headroom_stats --calls 3 `
  --output .tmp/mcp-session-headroom-real-canary.json
```

The 2026-07-11 Headroom run discovered `headroom_compress`, `headroom_retrieve`, and `headroom_stats`, then completed 3/3 read-only stats calls. Calls averaged 1462.3ms with a 1567ms maximum. The Rust route started one sidecar, recorded zero failures, fallbacks, backpressure rejections, and pending requests, closed one session, and left no active sidecar. This satisfies the second real MCP implementation gate without exercising compression mutations.

Run repeated independent auto-mode lifecycles with:

```bash
npm run mcp-session:soak -- --sessions 5 --calls 12 --output .tmp/mcp-session-soak.json
```

The 2026-07-11 final soak passed 5/5 sessions. The baseline spawned 65 MCP server processes while Rust spawned 5 servers and 5 sidecars, a 92.3% reduction. All sessions recorded zero failures, fallbacks, backpressure rejections, and pending requests; all 5 drained cleanly, and the maximum observed Rust request was 170.6ms against a 1000ms soak ceiling. The MCP workflow runs this soak on relevant changes and every Monday at 03:17 UTC, uploading both single-session and soak JSON artifacts.

`.github/workflows/mcp-session-rust-canary.yml` rebuilds the release sidecar on Windows, runs contract/runtime/canary tests, executes the 12-call workload plus five-session soak, and uploads both JSON artifacts.

## Next Slices

- Keep the weekly Windows soak green and collect representative production auto-mode evidence before considering default-on; packaged-command resolution and explicit override precedence are covered by the Rust launcher test.
- Decide whether to keep the sidecar process model or replace it with a native module after Windows packaging costs are known.
