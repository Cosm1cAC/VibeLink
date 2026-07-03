# SQLite State Layer Requirements

## Background

VibeLink currently keeps important runtime state in memory, JSON files, and JSONL logs:

- Task events live in memory and are appended to `.agent-mobile-terminal/tasks/*.jsonl`.
- Thread metadata lives in `.agent-mobile-terminal/thread-state.json`.
- Codex Desktop UI observations are exposed only as the latest `/api/desktop-remote/status` response.
- Codex and Claude historical context still comes from their native JSONL stores.

This is enough for a prototype, but it makes reconnect, restart recovery, device/session management, and Desktop UI observation history fragile.

## Goal

Introduce a lightweight SQLite state layer at:

```text
.agent-mobile-terminal/mobile-agent.sqlite
```

SQLite is the source of truth for product state and event cursors. Native Codex/Claude JSONL files remain the source of truth for raw agent history.

## Non-Goals

- Do not import full `.codex` or `.claude` JSONL bodies into SQLite.
- Do not store images, attachments, or large diff blobs in SQLite.
- Do not replace Codex Desktop internals or claim complete Desktop state reconstruction.
- Do not switch the product architecture to an MCP-first server.

## Phase 1 Scope

### State Tables

- `workspaces`: local project directories and display names.
- `devices`: future device/session token tracking.
- `threads`: thread metadata such as title, group, pin, archive.
- `thread_forks`: local fork metadata.
- `tasks`: task summaries.
- `task_events`: append-only task event stream with numeric cursors.
- `desktop_observations`: Codex Desktop UI observer snapshots/deltas.
- `settings_kv`: future small durable settings.

### Required Behavior

1. Service startup creates/migrates the SQLite schema automatically.
2. Existing `thread-state.json` is imported into SQLite without changing the public `/api/thread-state` response shape.
3. Existing task JSONL logs are imported into SQLite during task restore.
4. New task events are written to SQLite and keep their current JSONL append behavior as a compatibility log.
5. Task SSE emits numeric event ids based on SQLite cursors so reconnect can resume with `Last-Event-ID` or `?after=`.
6. Codex Desktop live status writes change-based observations into `desktop_observations`.
7. Existing frontend behavior continues to work without a required UI migration.

## Planned Follow-Ups

### Completed P0 Extensions

- Added allowed roots and workspace path validation on top of `workspaces`.
- Added first-pairing device tokens, device listing, and token revocation on top of `devices`.
- Added Host allowlist checks and public tunnel warnings.
- Added a durable Desktop observer SSE stream based on `desktop_observations.cursor`.
- Added workspace Git status/diff endpoints and task change summaries.

### Remaining P1

- Add git status/diff/change cards keyed by workspace and task.
- Add workspace management UI.
- Add task event compaction and retention policy controls.

## Acceptance Checks

- `npm run build` passes.
- Server starts and creates `.agent-mobile-terminal/mobile-agent.sqlite`.
- `/api/thread-state` still returns existing metadata and forks.
- `/api/tasks/:id` returns task events with `cursor`.
- `/api/tasks/:id/events?after=<cursor>` skips already-seen events.
- `/api/desktop-remote/status?fresh=1` records a Desktop observation when visible state changes.
