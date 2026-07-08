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

Tool event appends can also be queued and flushed in batches when `VIBELINK_EVENT_STORE_BATCH_APPEND=1` is enabled. The batcher records flush duration and batch-size metrics so high-frequency stdout writes can be compared before and after worker or Rust-sidecar experiments.

The worker client applies a pending-request cap before posting work to the thread. Set `VIBELINK_EVENT_STORE_WORKER_MAX_PENDING_REQUESTS` to tune the limit; rejected requests fail fast with `EEVENTSTOREBACKPRESSURE` so callers can fall back or surface overload clearly.

Task and tool event append paths still preserve the existing immediate cursor behavior unless their specific async or batch flags are enabled. If the worker fails, VibeLink logs one warning and falls back to the synchronous SQLite adapter.

`GET /api/events/unified` uses the bounded `replayWindow` contract. It returns the existing `items` array plus `nextCursor`, `hasMore`, and `limit` so callers can page through a recent replay window instead of forcing one large cross-table JSON replay. The cursor is opaque to clients and remains compatible with task, tool, and live-call filters.

`GET /api/tool-events/stats` includes `storeMode`:

- `sync`: default main-thread adapter
- `worker`: worker flag is enabled and no failure has occurred
- `sync-fallback`: worker flag is enabled but a worker request failed

It also includes `eventStore.metrics`, grouped by contract method, with request counts, failures, fallback counts, average/max/last duration, and mode counts. The same response includes event batch flush metrics and tool-event SSE replay metrics. These numbers are intentionally runtime-local; they reset when the bridge restarts and are meant for before/after comparisons during worker, batch, and Rust sidecar experiments.

## Next Slices

- Finish moving remaining append paths behind async or batch boundaries while preserving cursor ordering.
- Window large task/live-call replay paths where callers still request broad history.
- Add main-thread stall measurements around high-frequency event bursts.
- Reuse the same JSON method contract for a Rust sidecar/native module once the Worker boundary is stable.
