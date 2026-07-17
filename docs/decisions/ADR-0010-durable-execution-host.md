# ADR-0010: Durable execution workers own managed processes

## Status

Accepted

## Date

2026-07-17

## Context

VibeLink currently launches terminals, workspace commands, and agent providers from the Node control plane. Their process and PTY handles live only in memory. Restarting the bridge can restore SQLite events and JSONL history, but it cannot resume reading output, writing input, resizing a PTY, stopping the child, or observing its final exit status.

Attaching to an arbitrary process after it has already started does not solve this. Windows does not provide a general mechanism to transfer stdin, stdout, stderr, or an existing ConPTY from an unrelated owner. Codex Desktop also does not expose a stable public protocol for its internal process handles, complete tool output, or approval continuations. Windows UI Automation can only provide fail-closed, best-effort interaction with the visible Desktop UI.

Codex CLI 0.117 exposes an experimental app-server schema generator. The reviewed schema includes structured command, file-change, permission approval requests, dynamic tool calls, command output deltas, item completion, and turn completion. The protocol is useful, but its experimental status requires explicit compatibility gating.

## Decision

1. VibeLink will guarantee reconnection only for executions that VibeLink starts and owns. External processes and Codex Desktop sessions remain `external` and are never presented as attachable.
2. A Rust `execd` process will discover and route execution traffic. Each execution will have an independent worker that owns the business child, ConPTY or stdio handles, Windows Job Object, provider connection, and durable event spool.
3. Workers will outlive the HTTP bridge, Rust front door, and `execd`. A restarted `execd` will rediscover workers from manifests and verify PID, process creation time, worker instance nonce, and named-pipe proof before attaching.
4. A worker crash is a hard ownership boundary. Its Job Object terminates the child, and reconciliation records `lost`. VibeLink will not pretend that a surviving process can be rebound after its handle owner is gone.
5. Provider adapters will publish capability and fidelity. Only a schema-gated app-server adapter may report authoritative tool events and approval continuation. CLI JSONL remains `observed`; Desktop UIA remains `sampled` or `unavailable`.
6. Approval decisions will use a transactional outbox. A decision is not `applied` until the worker responds to the same upstream request and observes continuation evidence.
7. Operation IDs deduplicate requests while a worker has an unambiguous result. If a worker crashes between an external side effect and durable acknowledgement, the operation becomes `OUTCOME_UNKNOWN` and is never replayed automatically.

## Alternatives Considered

### Reattach arbitrary Windows processes

Rejected. PID discovery does not grant ownership of inherited pipes or ConPTY handles. Injecting into another process or scraping its console would be unsafe, incomplete, and dependent on undocumented behavior.

### Keep process ownership in Node

Rejected. The Node process is also the HTTP control plane and is routinely restarted during development, configuration changes, and migration. Persisting metadata cannot recreate lost OS handles.

### Let one central daemon own every child directly

Rejected for the P0 design. It survives bridge restarts but loses every handle during a daemon restart. Per-execution workers isolate failures and permit `execd` upgrades without interrupting active work.

### Make Desktop UIA the primary protocol

Rejected. UIA depends on foreground-window state, localized labels, Electron control structure, coordinates, and clipboard behavior. It cannot provide authoritative tool identity, output, exit status, or approval continuation.

### Enable every app-server version with best-effort parsing

Rejected. A partial protocol match is more dangerous than a clear downgrade because approvals could be routed to the wrong item or applied with the wrong scope. Unknown versions fail closed to the CLI adapter.

## Consequences

- New execution-host code must be additive and feature-gated until restart, crash, security, and rollback canaries pass.
- Existing Terminal and tool-run HTTP IDs remain stable; internal `executionId` and ownership fields are additive.
- A worker per execution uses more memory and handles than a shared host. Resource use must be measured before considering safe pooling.
- Event spools need quotas and explicit truncation markers. Control events and final status must never be silently discarded.
- Codex upgrades require running the contract probe and reviewing any new minor before enabling the app-server adapter.
- Rollback changes ownership only for new executions. Existing worker-owned executions continue with their original owner until completion or explicit stop.

