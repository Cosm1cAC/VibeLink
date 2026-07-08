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
- `getToolEventStats`
- `pruneToolEvents`
- `pruneLiveCallEvents`

## Current Slice

`src/eventStoreWorker.js` runs the same SQLite contract inside a Node Worker Thread. The HTTP API can opt into worker-backed query and retention paths with:

```bash
VIBELINK_EVENT_STORE_WORKER=1 npm start
```

Current worker-backed API paths:

- `GET /api/tool-events`
- `GET /api/tool-runs/:id`
- `GET /api/tasks/:id/events/catch-up`
- `GET /api/events/unified`
- `GET /api/tool-events/stats`
- `POST /api/tool-events/prune`
- scheduled tool-event auto-prune

Synchronous append paths remain on the main thread for now so existing callers keep immediate SQLite cursors for SSE event ids. If the worker fails, VibeLink logs one warning and falls back to the synchronous SQLite adapter.

`GET /api/tool-events/stats` includes `storeMode`:

- `sync`: default main-thread adapter
- `worker`: worker flag is enabled and no failure has occurred
- `sync-fallback`: worker flag is enabled but a worker request failed

It also includes `eventStore.metrics`, grouped by contract method, with request counts, failures, fallback counts, average/max/last duration, and mode counts. These numbers are intentionally runtime-local; they reset when the bridge restarts and are meant for before/after comparisons during worker, batch, and Rust sidecar experiments.

## Next Slices

- Move append paths behind a queue while preserving cursor ordering.
- Add a 20-100 ms batch flush for high-frequency tool output.
- Add append latency, batch size, and SSE replay time metrics.
- Reuse the same JSON method contract for a Rust sidecar/native module once the Worker boundary is stable.
