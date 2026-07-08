import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolRun,
  flushToolEventBatches,
  getEventStoreRuntimeStats,
  insertToolEventBatchedAsync,
  isEventStoreBatchAppendEnabled,
  listToolEvents
} from "../src/db.js";
import { emitToolEventBatched } from "../src/toolRuntime.js";

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

test("tool event batch append falls back to sync when disabled", async () => {
  const previousFlag = process.env.VIBELINK_EVENT_STORE_BATCH_APPEND;
  delete process.env.VIBELINK_EVENT_STORE_BATCH_APPEND;
  try {
    const run = createToolRun({
      id: `batch-disabled-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    assert.equal(isEventStoreBatchAppendEnabled(), false);
    const cursor = await insertToolEventBatchedAsync(run.id, {
      id: `${run.id}:event-1`,
      type: "tool.stdout",
      text: "sync"
    });

    assert.equal(typeof cursor, "number");
    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((event) => event.text), ["sync"]);
  } finally {
    restoreEnv("VIBELINK_EVENT_STORE_BATCH_APPEND", previousFlag);
  }
});

test("tool event batch append queues until explicit flush when enabled", async () => {
  const previousFlag = process.env.VIBELINK_EVENT_STORE_BATCH_APPEND;
  process.env.VIBELINK_EVENT_STORE_BATCH_APPEND = "1";
  try {
    const run = createToolRun({
      id: `batch-enabled-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    assert.equal(isEventStoreBatchAppendEnabled(), true);
    const first = insertToolEventBatchedAsync(run.id, {
      id: `${run.id}:event-1`,
      type: "tool.stdout",
      text: "one"
    });
    const second = insertToolEventBatchedAsync(run.id, {
      id: `${run.id}:event-2`,
      type: "tool.stdout",
      text: "two"
    });

    assert.deepEqual(listToolEvents({ toolRunId: run.id }), []);
    assert.equal(getEventStoreRuntimeStats().batchAppend.pending, 2);

    await flushToolEventBatches();

    const cursors = await Promise.all([first, second]);
    assert.equal(cursors.length, 2);
    assert.ok(cursors[0] < cursors[1]);
    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((event) => event.text), ["one", "two"]);
    assert.equal(getEventStoreRuntimeStats().batchAppend.flushes >= 1, true);
  } finally {
    await flushToolEventBatches();
    restoreEnv("VIBELINK_EVENT_STORE_BATCH_APPEND", previousFlag);
  }
});

test("runtime batched tool event emitter preserves sync behavior when disabled", () => {
  const previousFlag = process.env.VIBELINK_EVENT_STORE_BATCH_APPEND;
  delete process.env.VIBELINK_EVENT_STORE_BATCH_APPEND;
  try {
    const run = createToolRun({
      id: `runtime-batch-disabled-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    const event = emitToolEventBatched(run.id, {
      id: `${run.id}:event-1`,
      type: "tool.output",
      text: "sync-runtime"
    });

    assert.equal(typeof event.cursor, "number");
    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((item) => item.text), ["sync-runtime"]);
  } finally {
    restoreEnv("VIBELINK_EVENT_STORE_BATCH_APPEND", previousFlag);
  }
});

test("runtime batched tool event emitter queues when enabled", async () => {
  const previousFlag = process.env.VIBELINK_EVENT_STORE_BATCH_APPEND;
  process.env.VIBELINK_EVENT_STORE_BATCH_APPEND = "1";
  try {
    const run = createToolRun({
      id: `runtime-batch-enabled-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    const event = emitToolEventBatched(run.id, {
      id: `${run.id}:event-1`,
      type: "tool.output",
      text: "async-runtime"
    });

    assert.equal(event.cursor, undefined);
    assert.deepEqual(listToolEvents({ toolRunId: run.id }), []);
    await flushToolEventBatches();
    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((item) => item.text), ["async-runtime"]);
  } finally {
    await flushToolEventBatches();
    restoreEnv("VIBELINK_EVENT_STORE_BATCH_APPEND", previousFlag);
  }
});
