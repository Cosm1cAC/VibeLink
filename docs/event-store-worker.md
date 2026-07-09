# Event Store Worker

## Goal

Stage 2 of the Rust migration isolates the event-store hot path before replacing any internals with Rust. The stable contract lives in `src/eventStore.js` and covers:

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

## Rust Sidecar Contract Smoke

`src/eventStoreContract.js` now owns the shared JSON method allowlist, control method names, protocol version, and error envelope used by both the Node Worker and sidecar smoke fixture. `src/eventStoreSidecarClient.js` speaks the Rust-ready stdio JSONL shape:

```json
{"id":1,"method":"__health","args":[]}
{"id":1,"result":{"ok":true,"protocolVersion":1,"implementation":"node-fixture"}}
{"id":2,"method":"insertTaskEvents","args":["task-id",[{"type":"stdout","text":"hello"}]]}
{"id":2,"result":[1]}
{"id":3,"method":"stats","args":[]}
{"id":3,"result":{"pending":0,"requests":3,"failures":0}}
```

`test/eventStoreSidecarContract.test.js` runs that protocol against `test/fixtures/event-store-json-sidecar.js`, which reuses the SQLite event-store adapter as a stand-in for the future Rust process. This keeps the production path unchanged while locking the compatibility surface for append, replay, health/status reporting, error envelopes, close, invalid JSON handling, timeout handling, and pending-request accounting.

`GET /api/tasks/:id/events/catch-up` and `GET /api/live-calls/:id/events/catch-up` return the existing `items` array plus `nextCursor`, `hasMore`, and `limit`. Each route fetches `limit + 1` events internally to expose a cheap next-page signal without changing the item contract.

`GET /api/events/unified` uses the bounded `replayWindow` contract. It returns the existing `items` array plus `nextCursor`, `hasMore`, and `limit` so callers can page through a recent replay window instead of forcing one large cross-table JSON replay. The cursor is opaque to clients and remains compatible with task, tool, and live-call filters.

`GET /api/tool-events/stats` includes `storeMode`:

- `sync`: default main-thread adapter
- `worker`: worker flag is enabled and no failure has occurred
- `sync-fallback`: worker flag is enabled but a worker request failed

It also includes `eventStore.metrics`, grouped by contract method, with request counts, failures, fallback counts, average/max/last duration, mode counts, and slow sync-call stalls. Set `VIBELINK_EVENT_STORE_STALL_THRESHOLD_MS` to tune the stall threshold for local hardware or CI; the default is 50ms. The same response includes task-event batch metrics, tool-event batch metrics, live-call event batch metrics, and tool-event SSE replay metrics. These numbers are intentionally runtime-local; they reset when the bridge restarts and are meant for before/after comparisons during worker, batch, and Rust sidecar experiments.

## Next Slices

- Finish moving remaining append paths behind async or batch boundaries while preserving cursor ordering.
- Window large task/live-call replay paths where callers still request broad history.
- Add high-frequency event burst smoke tests around the runtime stall and batch metrics.
- Wire the JSONL sidecar client to a real Rust sidecar/native module once the Worker boundary is stable.
