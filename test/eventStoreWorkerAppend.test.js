import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolRun,
  drainEventStoreRuntime,
  getEventStoreRuntimeStats,
  insertToolEventsAsync,
  listToolEvents
} from "../src/db.js";
import { emitToolEventBatched } from "../src/toolRuntime.js";

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

test("db async tool event append uses worker when enabled", async () => {
  const previousWorkerFlag = process.env.VIBELINK_EVENT_STORE_WORKER;
  process.env.VIBELINK_EVENT_STORE_WORKER = "1";
  try {
    const run = createToolRun({
      id: `worker-append-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    const cursors = await insertToolEventsAsync(run.id, [
      { id: `${run.id}:event-1`, type: "tool.stdout", text: "one" },
      { id: `${run.id}:event-2`, type: "tool.stdout", text: "two" }
    ]);

    assert.equal(cursors.length, 2);
    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((event) => event.text), ["one", "two"]);
    assert.equal(getEventStoreRuntimeStats().metrics.methods.insertToolEvents.modeCounts.worker >= 1, true);
  } finally {
    await drainEventStoreRuntime();
    restoreEnv("VIBELINK_EVENT_STORE_WORKER", previousWorkerFlag);
  }
});

test("event store runtime stats expose worker pending capacity", async () => {
  const previousWorkerFlag = process.env.VIBELINK_EVENT_STORE_WORKER;
  const previousMaxPending = process.env.VIBELINK_EVENT_STORE_WORKER_MAX_PENDING_REQUESTS;
  process.env.VIBELINK_EVENT_STORE_WORKER = "1";
  process.env.VIBELINK_EVENT_STORE_WORKER_MAX_PENDING_REQUESTS = "7";
  try {
    const run = createToolRun({
      id: `worker-stats-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    await insertToolEventsAsync(run.id, [
      { id: `${run.id}:event-1`, type: "tool.stdout", text: "one" }
    ]);

    const stats = getEventStoreRuntimeStats();
    assert.equal(stats.worker.enabled, true);
    assert.equal(stats.worker.active, true);
    assert.equal(stats.worker.maxPendingRequests, 7);
    assert.equal(stats.worker.pending, 0);
  } finally {
    await drainEventStoreRuntime();
    restoreEnv("VIBELINK_EVENT_STORE_WORKER", previousWorkerFlag);
    restoreEnv("VIBELINK_EVENT_STORE_WORKER_MAX_PENDING_REQUESTS", previousMaxPending);
  }
});

test("batched tool event flush uses worker append when both flags are enabled", async () => {
  const previousWorkerFlag = process.env.VIBELINK_EVENT_STORE_WORKER;
  const previousBatchFlag = process.env.VIBELINK_EVENT_STORE_BATCH_APPEND;
  process.env.VIBELINK_EVENT_STORE_WORKER = "1";
  process.env.VIBELINK_EVENT_STORE_BATCH_APPEND = "1";
  try {
    const run = createToolRun({
      id: `worker-batch-append-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    emitToolEventBatched(run.id, {
      id: `${run.id}:event-1`,
      type: "tool.output",
      text: "batched-worker"
    });

    assert.deepEqual(listToolEvents({ toolRunId: run.id }), []);
    await drainEventStoreRuntime();
    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((event) => event.text), ["batched-worker"]);
    assert.equal(getEventStoreRuntimeStats().metrics.methods.insertToolEvents.modeCounts.worker >= 1, true);
  } finally {
    await drainEventStoreRuntime();
    restoreEnv("VIBELINK_EVENT_STORE_WORKER", previousWorkerFlag);
    restoreEnv("VIBELINK_EVENT_STORE_BATCH_APPEND", previousBatchFlag);
  }
});
