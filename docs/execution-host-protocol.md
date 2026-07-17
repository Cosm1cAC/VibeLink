# VibeLink Execution Host Protocol v1

## Status

Contract defined; implementation is feature-gated and incomplete until the P0 execution-host checkpoints pass.

## Scope

Protocol v1 connects the VibeLink control plane to local Rust execution infrastructure. It covers managed terminal, workspace command, and provider executions; event replay; input and control operations; and delivery of provider approval decisions.

It does not attach arbitrary external processes, recover a process after its worker loses the owning handles, or turn Desktop UI Automation into a process protocol.

## Ownership Model

```text
HTTP control plane -> execd -> execution worker -> business child/provider
```

- The control plane owns product state, authentication, policy, task/tool records, approval records, and public cursors.
- `execd` owns discovery, worker routing, and health reporting.
- A worker owns exactly one execution, its OS handles, Job Object, provider connection, operation dedupe state, and event spool.
- The business child never inherits a remote client credential or public device token.

An attachment is valid only when all of these match the manifest: worker PID, process creation time, worker instance ID, and named-pipe handshake nonce. PID alone is not an identity.

## Transport

Windows uses local named pipes with an ACL restricted to the current VibeLink user and SYSTEM. The transport is length-bounded JSON. Network listeners are not allowed.

Every request has this envelope:

```json
{
  "protocolVersion": 1,
  "requestId": "01J...",
  "method": "execution.input",
  "params": {}
}
```

Successful response:

```json
{
  "protocolVersion": 1,
  "requestId": "01J...",
  "result": {}
}
```

Error response:

```json
{
  "protocolVersion": 1,
  "requestId": "01J...",
  "error": {
    "code": "EXECUTION_NOT_ATTACHED",
    "message": "Execution worker is not reachable.",
    "retryable": true,
    "details": {}
  }
}
```

Unknown protocol versions, methods, fields that violate a strict boundary schema, oversized messages, and unauthenticated pipes fail closed.

## Methods

| Method | Purpose | Mutation |
| --- | --- | --- |
| `host.hello` | Negotiate protocol and host capabilities | No |
| `host.health` | Return daemon/worker health and queue depths | No |
| `execution.start` | Create a managed worker and child | Yes |
| `execution.get` | Return one execution snapshot | No |
| `execution.list` | Return bounded, cursor-paginated snapshots | No |
| `execution.events` | Replay bounded events after `hostSeq` | No |
| `execution.ack` | Acknowledge durable control-plane ingestion | Yes |
| `execution.input` | Write terminal/provider input when supported | Yes |
| `execution.resize` | Resize a PTY when supported | Yes |
| `execution.signal` | Interrupt, terminate, or stop an execution | Yes |
| `approval.resolve` | Respond to a pending provider continuation | Yes |

Every mutation includes an `operationId`. A live worker returns the recorded result for a duplicate operation ID. A conflicting payload for an existing operation ID returns `OPERATION_CONFLICT`.

No cross-process exactly-once guarantee is claimed. If a worker exits after an external side effect but before recording an acknowledgement, reconciliation returns `OUTCOME_UNKNOWN`; the control plane must not retry automatically.

## Execution Snapshot

Required fields:

```json
{
  "executionId": "uuid",
  "kind": "terminal",
  "owner": "execution-host",
  "status": "running",
  "attachState": "attached",
  "workerInstanceId": "uuid",
  "workerPid": 1234,
  "processPid": 5678,
  "processStartedAt": "2026-07-17T00:00:00.000Z",
  "lastHostSeq": 42,
  "capabilities": {},
  "startedAt": "2026-07-17T00:00:00.000Z",
  "endedAt": "",
  "exitCode": null,
  "signal": ""
}
```

`kind` is `terminal`, `command`, `provider.cli`, or `provider.appServer` in v1.

`status` is one of:

- `starting`
- `running`
- `awaiting_approval`
- `stopping`
- `completed`
- `failed`
- `cancelled`
- `lost`
- `outcome_unknown`

`attachState` is one of:

- `attached`
- `reconnecting`
- `unreachable`
- `lost`
- `external`

## Event Contract

Each worker event has a strictly increasing sequence scoped to its execution:

```json
{
  "executionId": "uuid",
  "hostSeq": 42,
  "eventId": "uuid:42",
  "type": "stream.stdout",
  "at": "2026-07-17T00:00:00.000Z",
  "payload": {}
}
```

Control event types in v1 include:

- `execution.started`
- `stream.stdout`
- `stream.stderr`
- `stream.pty`
- `provider.event`
- `approval.required`
- `approval.resolved`
- `approval.applied`
- `execution.exited`
- `execution.lost`
- `output.truncated`
- `operation.outcome_unknown`

The control plane maps worker events to existing task/tool events. It writes the event and `last_ingested_host_seq` in one SQLite transaction, then sends `execution.ack`. Replayed `eventId` values are idempotent. Public SQLite cursors remain the REST/SSE catch-up contract.

Spool retention is bounded. Exceeding the quota emits `output.truncated`; state, approval, loss, and exit events cannot be silently removed. Large retained output may be moved to an artifact and referenced by an event.

## Provider Capabilities

Provider workers report explicit fidelity:

```json
{
  "executionOwnership": "vibelink-host",
  "reattach": true,
  "structuredToolEvents": "authoritative",
  "toolOutput": "complete",
  "exitStatus": "authoritative",
  "approvalContinuation": true,
  "liveInput": false,
  "protocol": "codex-app-server",
  "protocolVersion": "probed"
}
```

Allowed fidelity values are `authoritative`, `observed`, `sampled`, and `unavailable`. A consumer must not render `observed` or `sampled` data as authoritative.

The Codex app-server adapter is enabled only when `npm run codex-app-server:contract` succeeds for a reviewed CLI minor. The v1 allowlist initially contains `0.117`. Any missing method, response field, params-schema drift, invalid generator output, or unreviewed minor disables the complete adapter.

CLI JSONL has `approvalContinuation=false`. A message sent while a non-interactive CLI turn is running is queued and starts a new resume turn after completion; it is not written to stdin unless the Provider explicitly reports `liveInput=true`.

Desktop UIA reports `executionOwnership=external`, `reattach=false`, `structuredToolEvents=sampled`, `toolOutput=sampled`, `exitStatus=unavailable`, and `approvalContinuation=false`.

## Approval Continuation

Provider approval identity includes provider, thread ID, turn ID, item ID, upstream approval ID when present, worker instance ID, and an opaque `continuationRef`.

State progression:

```text
pending -> decision_recorded -> delivering -> applied
                                  |
                                  +-> decision_recorded (retryable transport failure)
pending -> expired
decision_recorded -> stale
```

- The API records an approval decision and outbox command in one transaction.
- `approval.resolve` validates the continuation, decision version, available decisions, and current turn before responding once to the original provider request.
- Approval is `applied` only after the provider accepts the response and continuation evidence is observed.
- Duplicate identical decisions return the original outcome. Opposite decisions return `APPROVAL_ALREADY_DECIDED`.
- Missing or completed upstream requests return `APPROVAL_STALE`; the tool must not be recreated.
- Legacy boolean approval maps only to a single-use accept/decline. Session or policy expansion requires an explicit typed decision.

## Stable Error Codes

- `PROTOCOL_VERSION_UNSUPPORTED`
- `MESSAGE_INVALID`
- `MESSAGE_TOO_LARGE`
- `AUTHENTICATION_FAILED`
- `EXECUTION_NOT_FOUND`
- `EXECUTION_NOT_ATTACHED`
- `EXECUTION_STATE_CONFLICT`
- `OPERATION_CONFLICT`
- `CAPABILITY_UNSUPPORTED`
- `APPROVAL_NOT_FOUND`
- `APPROVAL_ALREADY_DECIDED`
- `APPROVAL_STALE`
- `OUTCOME_UNKNOWN`
- `INTERNAL_ERROR`

Internal errors never include credentials, complete environment variables, pipe secrets, or unredacted provider tokens.

## Versioning

Protocol changes are additive within v1. Removing a method, changing an existing field type, reusing an error code with different semantics, or changing operation replay behavior requires a new protocol version and an explicit migration path.
