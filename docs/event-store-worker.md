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

## Rust Sidecar Opt-In And Canary

`src/eventStoreContract.js` now owns the shared JSON method allowlist, control method names, protocol version, and error envelope used by both the Node Worker and sidecar smoke fixture. `src/eventStoreSidecarClient.js` speaks the Rust-ready stdio JSONL shape:

```json
{"id":1,"method":"__health","args":[]}
{"id":1,"result":{"ok":true,"protocolVersion":1,"implementation":"node-fixture"}}
{"id":2,"method":"insertTaskEvents","args":["task-id",[{"type":"stdout","text":"hello"}]]}
{"id":2,"result":[1]}
{"id":3,"method":"stats","args":[]}
{"id":3,"result":{"pending":0,"requests":3,"failures":0}}
```

`test/eventStoreSidecarContract.test.js` runs that protocol against both `test/fixtures/event-store-json-sidecar.js` and the real Rust `vibelink event-store-sidecar` command in `apps/windows`. `src/db.js` can route async event-store append/replay calls to the Rust sidecar when explicitly enabled:

```bash
VIBELINK_EVENT_STORE_RUST_SIDECAR=1 npm start
```

It can also run in safe auto-detection mode:

```bash
VIBELINK_EVENT_STORE_RUST_SIDECAR=auto npm start
```

In `auto` mode, the Rust sidecar is attempted only when the configured command exists. A missing command skips Rust without marking the sidecar failed. If the command exists, the first routed request still has to pass the normal `__health` readiness gate before production traffic uses the sidecar.

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

## Local Canary

`npm run event-store:canary` runs an isolated local comparison against temporary SQLite databases. It seeds task, tool-run, and live-call owners, runs the sync adapter as the baseline, then runs the Rust sidecar against the same append/replay workload. The script fails if readiness is bad, direct Rust fallback is non-zero, sidecar failures occur, append averages are more than 10% slower than baseline, pending requests do not drain, or backpressure appears. The default command prefers `apps/windows/target/release/vibelink(.exe)` when present and falls back to `apps/windows/target/debug/vibelink(.exe)`.

The representative 2026-07-10 local release canary passed with:

```bash
npm run event-store:canary -- --output .tmp/event-store-canary-final.json
```

That run measured 10,800 append events across task, tool, and live-call paths. Append averages were `insertTaskEvents` sync 7.9ms vs Rust 4.2ms, `insertToolEvents` sync 10.9ms vs Rust 5.8ms, and `insertLiveCallEvents` sync 7.4ms vs Rust 4.7ms, with 0 fallback, 0 sidecar failures, 0 pending requests after drain, and 0 backpressure rejects. Run performance canaries serially; concurrent SQLite canaries can distort latency. The `.tmp` output is a local evidence artifact and is not committed.

`npm run event-store:runtime-canary` runs the same canary one layer higher through the production `src/db.js` runtime router and batchers. It sets `VIBELINK_DATA_DIR` to a temporary directory, enables `VIBELINK_EVENT_STORE_RUST_SIDECAR=auto`, enables task/tool/live-call batch append flags, preflights sidecar readiness, and then verifies `getEventStoreRuntimeStats()` rather than only direct sidecar timings.

The representative 2026-07-10 runtime canary passed with:

```bash
npm run event-store:runtime-canary -- --output .tmp/event-store-runtime-canary-final.json
```

That run queued 7,200 task/tool/live-call append events through the runtime batchers. Runtime append metrics were `insertTaskEvents` 24 Rust calls at 37.8ms average, `insertToolEvents` 24 Rust calls at 38.1ms average, and `insertLiveCallEvents` 24 Rust calls at 31.6ms average, with runtime mode `rust-sidecar`, 0 fallback, 0 failures, 0 sync stalls, 0 pending requests after drain, and 0 backpressure rejects.

`npm run event-store:server-canary` starts the bridge itself on a temporary `VIBELINK_DATA_DIR` and random local port, logs in through `/api/login`, executes a small workspace command, emits live-call transcript and audio-level events through HTTP, and validates `/api/tool-events/stats`.

The representative 2026-07-10 server canary passed with:

```bash
npm run event-store:server-canary -- --output .tmp/event-store-server-canary-final.json
```

That run verified service startup, auth, workspace command output, live-call event ingestion, runtime mode `rust-sidecar`, 2 Rust `insertToolEvents` calls at 2.6ms average, 13 Rust `insertLiveCallEvents` calls at 4.5ms average, 0 fallback, 0 failures, 0 sync stalls, 0 pending requests, and 0 backpressure rejects.

`npm run event-store:canary:all` runs the local, runtime, and server canaries serially and writes CI-friendly JSON outputs under `.tmp/`. The aggregate uses a CI-sized local workload of 24 rounds x 100 events per append path to reduce host-noise sensitivity while still measuring 7,200 direct append events before the runtime and server canaries. The local direct comparison keeps the 10% ratio threshold and adds a 5ms absolute latency margin for low-millisecond CI jitter; standalone promotion runs can omit `--latency-margin-ms` to use the strict default. The canaries are intentionally not parallelized because concurrent SQLite workloads can distort latency thresholds.

## CI Canary Gate

`.github/workflows/event-store-rust-canary.yml` runs on Windows for event-store, Rust sidecar, test, canary, package, and Rust migration document changes. The gate installs Node 22 and stable Rust, builds `apps/windows` in release mode, checks the Rust migration manifest, runs `npm run test:event-store`, then runs `npm run event-store:canary:all` serially. The workflow uploads `.tmp/event-store-*-canary-ci.json` as an artifact so failed or borderline canary runs have timing evidence attached to the status check.

## Next Slices

- Finish moving remaining append paths behind async or batch boundaries while preserving cursor ordering.
- Window large task/live-call replay paths where callers still request broad history.
- Add high-frequency event burst smoke tests around the runtime stall and batch metrics.
- Run limited human-driven real-session canaries with runtime stats capture before making the Rust sidecar default-on.

## Rollback

Use the environment switch as the first rollback lever. Restart the bridge with Rust disabled:

```bash
VIBELINK_EVENT_STORE_RUST_SIDECAR=0 npm start
```

If the Worker path also needs to be removed from the experiment, restart without the Worker/batch flags:

```bash
VIBELINK_EVENT_STORE_RUST_SIDECAR=0 VIBELINK_EVENT_STORE_WORKER=0 VIBELINK_EVENT_STORE_BATCH_APPEND=0 npm start
```

No data migration rollback is required for this slice because the Rust sidecar writes the same SQLite schema through the shared event-store contract. After rollback, confirm `GET /api/tool-events/stats` reports `storeMode` as `sync` or `worker`, `eventStore.rustSidecar.active` as `false`, and no new `rust-sidecar` mode counts.

## Canary Thresholds

Before moving the event-store sidecar beyond limited `canary`, run representative local and runtime sessions with `VIBELINK_EVENT_STORE_RUST_SIDECAR=auto` and the same Worker/batch flags planned for rollout. Use `GET /api/tool-events/stats` before and after runtime sessions.

Promotion requires all of the following:

- `eventStore.rustSidecar.ready` is `true`, `failed` is `false`, and `lastError` is empty after readiness.
- `eventStore.metrics.fallbacks / eventStore.metrics.requests` stays below 1% after readiness. Any readiness failure blocks promotion for that build.
- `eventStore.metrics.failures` is 0 for event-store methods not intentionally exercised by failure tests.
- Average `insertToolEvents`, `insertTaskEvents`, and `insertLiveCallEvents` duration is no worse than the sync or Worker baseline by more than 10%.
- `eventStore.metrics.stalls.count` is lower than the sync baseline for the same workload, or remains 0 when the baseline is already 0.
- `eventStore.rustSidecar.client.pending` returns to 0 after the workload and `backpressureRejects` remains 0.
