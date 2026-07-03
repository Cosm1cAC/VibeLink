# Codex App Server Spike

Date: 2026-07-01

## Goal

Verify whether the mobile/web terminal can use Codex app-server instead of `codex exec resume`, so multiple clients can join the same Codex thread and receive live updates.

## Result

`codex remote-control start --json` does not work on this Windows machine:

```text
codex app-server daemon lifecycle is only supported on Unix platforms
```

Manual app-server over WebSocket does work:

```text
codex app-server --listen ws://127.0.0.1:<port>
```

Generated protocol files show app-server exposes first-party thread, turn, item, approval, process, filesystem, model, plugin, MCP, and remote-control methods. Key methods tested:

- `initialize`
- `thread/start`
- `thread/resume`
- `turn/start`

Key notifications observed:

- `thread/started`
- `thread/status/changed`
- `turn/started`
- `item/started`
- `item/agentMessage/delta`
- `item/completed`
- `thread/tokenUsage/updated`
- `turn/completed`

## Tests

### Passive second client

Two WebSocket clients connected to the same app-server. Client A created a thread and started a turn. Client B did not explicitly resume the thread.

Result: B saw `thread/started` and status changes, but did not receive turn deltas or completion events.

Summary file:

```text
.agent-mobile-terminal/app-server-broadcast-summary.json
```

### Resume before first rollout

Client A created a new thread. Client B immediately called `thread/resume`.

Result: resume failed because the rollout file was not yet available:

```text
no rollout found for thread id ...
```

Summary file:

```text
.agent-mobile-terminal/app-server-resume-broadcast-summary.json
```

### Resume existing rollout, then receive later turn

Client A created a thread and completed the first turn. Client B called `thread/resume` on that thread. Client A then started a second turn.

Result: B received the live second-turn stream:

- `turn/started`: yes
- `item/agentMessage/delta`: yes
- `turn/completed`: yes
- expected text `SECOND_LIVE_OK`: yes

Summary file:

```text
.agent-mobile-terminal/app-server-resume-second-turn-summary.json
```

Test thread:

```text
019f19b5-d02d-78d2-ab1c-df8e992dc853
```

## Conclusion

The current CLI wrapper path cannot truly take over an already-running OS process from Codex App or a terminal. It can only read history and start a new `codex exec resume` process.

The app-server path is better: clients that connect to the same app-server and explicitly `thread/resume` an existing rollout can receive subsequent live turn events. This supports a richer architecture where the local server becomes a Codex app-server client/proxy instead of reimplementing agent behavior from scratch.

Open question: whether the desktop Codex App itself can be pointed at the same manually started Windows app-server. The daemon lifecycle helper is Unix-only on this machine, so Windows needs a manual app-server process or a custom local broker.
