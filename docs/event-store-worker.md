# Event Store Worker

## Goal

Stage 2 of the Rust migration isolates the event-store hot path behind a shared Node Worker/Rust sidecar contract. The stable contract lives in `src/eventStore.js` and covers:

- `insertTaskEvent` / `insertTaskEvents`
- `insertToolEvent` / `insertToolEvents`
- `insertLiveCallEvent` / `insertLiveCallEvents`
- `listTaskEvents`
- `listToolEvents`
- `listLiveCallEvents`
- `listUnifiedEvents`
- `replayWindow`
- `getToolEventStats`
- `pruneToolEvents`
- `pruneLiveCallEvents`

## Current Slice

`src/eventStoreWorker.js` runs the same SQLite contract inside a Node Worker Thread. The HTTP API can opt into worker-backed query, append, replay, and retention paths with:

```bash
VIBELINK_EVENT_STORE_WORKER=1 npm start
```

Current worker-backed API paths:

- `GET /api/tool-events`
- `GET /api/tool-events?stream=1`
- `GET /api/tool-runs/:id`
- `GET /api/tasks/:id/events/catch-up`
- `GET /api/tasks/:id/events/stream`
- `GET /api/events/unified`
- `GET /api/tool-events/stats`
- live call SSE initial replay and catch-up replay
- live call event appends
- `POST /api/tool-events/prune`
- scheduled tool-event auto-prune

Tool event appends can also be queued and flushed in batches when `VIBELINK_EVENT_STORE_BATCH_APPEND=1` is enabled. Live-call event persistence has a separate opt-in batcher behind `VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND=1`; it preserves the in-memory live-call cursor and SSE fan-out path while delaying only SQLite persistence until flush. Task event persistence also has a lower-level experiment switch, `VIBELINK_EVENT_STORE_BATCH_TASK_APPEND=1`, for DB contract and worker/Rust-sidecar comparisons; the live agent SSE path still uses synchronous task-event persistence so event cursors remain immediate. All batchers record flush duration and batch-size metrics so high-frequency stdout, transcript, audio-level, and task-event writes can be compared before and after worker or Rust-sidecar experiments.

The worker client applies a pending-request cap before posting work to the thread. Set `VIBELINK_EVENT_STORE_WORKER_MAX_PENDING_REQUESTS` to tune the limit; rejected requests fail fast with `EEVENTSTOREBACKPRESSURE` so callers can fall back or surface overload clearly.

Task and tool event append paths still preserve the existing immediate cursor behavior unless their specific async or batch flags are enabled. If the worker fails, VibeLink logs one warning and falls back to the synchronous SQLite adapter.

## Rust Sidecar Opt-In

`src/eventStoreContract.js` now owns the shared JSON method allowlist, control method names, protocol version, and error envelope used by both the Node Worker and sidecar smoke fixture. `src/eventStoreSidecarClient.js` speaks the Rust-ready stdio JSONL shape:

```json
{"id":1,"method":"__health","args":[]}
{"id":1,"result":{"ok":true,"protocolVersion":1,"implementation":"node-fixture"}}
{"id":2,"method":"insertTaskEvents","args":["task-id",[{"type":"stdout","text":"hello"}]]}
{"id":2,"result":[1]}
{"id":3,"method":"stats","args":[]}
{"id":3,"result":{"pending":0,"requests":3,"failures":0}}
```

`test/eventStoreSidecarContract.test.js` runs that protocol against both `test/fixtures/event-store-json-sidecar.js` and the real Rust `vibelink event-store-sidecar` command in `apps/windows`. `src/db.js` can route async event-store append/replay calls to the Rust sidecar only when explicitly enabled:

```bash
VIBELINK_EVENT_STORE_RUST_SIDECAR=1 npm start
```

By default the command is `apps/windows/target/debug/vibelink(.exe)` with `event-store-sidecar <db-path>` appended. Tests and local experiments can override the command and leading args with:

```bash
VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND=node
VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON='["test/fixtures/event-store-json-sidecar.js"]'
```

Before the first routed request, `src/db.js` calls `__health` and verifies `ok`, protocol version, schema readiness, and support for every event-store contract method. Missing binaries, failed health, timeouts, sidecar request errors, invalid responses, or process exits close the Rust client, mark the sidecar failed, record fallback stats, and continue through the existing Node Worker or sync SQLite fallback path.

`GET /api/tasks/:id/events/catch-up` and `GET /api/live-calls/:id/events/catch-up` return the existing `items` array plus `nextCursor`, `hasMore`, and `limit`. Each route fetches `limit + 1` events internally to expose a cheap next-page signal without changing the item contract.

`GET /api/events/unified` uses the bounded `replayWindow` contract. It returns the existing `items` array plus `nextCursor`, `hasMore`, and `limit` so callers can page through a recent replay window instead of forcing one large cross-table JSON replay. The cursor is opaque to clients and remains compatible with task, tool, and live-call filters.

`GET /api/tool-events/stats` includes `storeMode`:

- `sync`: default main-thread adapter
- `rust-sidecar`: Rust sidecar flag is enabled and the sidecar has not failed
- `worker`: worker flag is enabled and no failure has occurred
- `worker-fallback`: Rust sidecar flag is enabled, Rust failed, and the Node Worker is handling requests
- `sync-fallback`: Rust or Worker routing failed and sync SQLite is handling requests

It also includes `eventStore.rustSidecar`, `eventStore.metrics`, grouped by contract method, with request counts, failures, fallback counts, average/max/last duration, mode counts, and slow sync-call stalls. Set `VIBELINK_EVENT_STORE_STALL_THRESHOLD_MS` to tune the stall threshold for local hardware or CI; the default is 50ms. The same response includes task-event batch metrics, tool-event batch metrics, live-call event batch metrics, and tool-event SSE replay metrics. These numbers are intentionally runtime-local; they reset when the bridge restarts and are meant for before/after comparisons during worker, batch, and Rust sidecar experiments.

## Next Slices

- Finish moving remaining append paths behind async or batch boundaries while preserving cursor ordering.
- Window large task/live-call replay paths where callers still request broad history.
- Add high-frequency event burst smoke tests around the runtime stall and batch metrics.
- Add `auto` readiness mode, rollback docs, invalid JSON/sidecar-exit db.js fallback tests, and latency/fallback-rate canary thresholds before making the Rust sidecar broader than manual opt-in.
