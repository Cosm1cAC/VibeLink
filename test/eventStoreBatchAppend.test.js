import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolRun,
  createLiveCall,
  drainEventStoreRuntime,
  flushLiveCallEventBatches,
  flushTaskEventBatches,
  flushToolEventBatches,
  getEventStoreRuntimeStats,
  insertLiveCallEventBatchedAsync,
  insertTaskEventBatchedAsync,
  insertToolEventBatchedAsync,
  isEventStoreBatchAppendEnabled,
  isLiveCallEventBatchAppendEnabled,
  isTaskEventBatchAppendEnabled,
  listLiveCallEvents,
  listTaskEvents,
  listToolEvents,
  upsertTask
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

test("event store runtime drain flushes pending batched tool events", async () => {
  const previousFlag = process.env.VIBELINK_EVENT_STORE_BATCH_APPEND;
  process.env.VIBELINK_EVENT_STORE_BATCH_APPEND = "1";
  try {
    const run = createToolRun({
      id: `runtime-drain-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    emitToolEventBatched(run.id, {
      id: `${run.id}:event-1`,
      type: "tool.output",
      text: "drained"
    });

    assert.deepEqual(listToolEvents({ toolRunId: run.id }), []);
    await drainEventStoreRuntime();
    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((item) => item.text), ["drained"]);
  } finally {
    await flushToolEventBatches();
    restoreEnv("VIBELINK_EVENT_STORE_BATCH_APPEND", previousFlag);
  }
});

test("live call event batch append queues until explicit flush when enabled", async () => {
  const previousFlag = process.env.VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND;
  process.env.VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND = "1";
  try {
    const sessionId = `live-batch-enabled-${Date.now()}`;
    createLiveCall({ id: sessionId, title: "Live batch append smoke" });

    assert.equal(isLiveCallEventBatchAppendEnabled(), true);
    const first = insertLiveCallEventBatchedAsync(sessionId, {
      id: `${sessionId}:event-1`,
      cursor: 1,
      type: "live_call.transcript.partial",
      text: "one"
    });
    const second = insertLiveCallEventBatchedAsync(sessionId, {
      id: `${sessionId}:event-2`,
      cursor: 2,
      type: "live_call.transcript.final",
      text: "two"
    });

    assert.deepEqual(listLiveCallEvents({ sessionId }), []);
    assert.equal(getEventStoreRuntimeStats().liveCallBatchAppend.pending, 2);

    await flushLiveCallEventBatches();

    const cursors = await Promise.all([first, second]);
    assert.equal(cursors.length, 2);
    assert.ok(cursors[0] < cursors[1]);
    assert.deepEqual(listLiveCallEvents({ sessionId }).map((event) => event.text), ["one", "two"]);
    assert.equal(getEventStoreRuntimeStats().liveCallBatchAppend.flushes >= 1, true);
  } finally {
    await flushLiveCallEventBatches();
    restoreEnv("VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND", previousFlag);
  }
});

test("task event batch append queues until explicit flush when enabled", async () => {
  const previousFlag = process.env.VIBELINK_EVENT_STORE_BATCH_TASK_APPEND;
  process.env.VIBELINK_EVENT_STORE_BATCH_TASK_APPEND = "1";
  try {
    const taskId = `task-batch-enabled-${Date.now()}`;
    upsertTask({
      id: taskId,
      agent: "test",
      title: "Task batch append smoke",
      cwd: process.cwd(),
      status: "running"
    });

    assert.equal(isTaskEventBatchAppendEnabled(), true);
    const first = insertTaskEventBatchedAsync(taskId, {
      id: `${taskId}:event-1`,
      type: "stdout",
      text: "one"
    });
    const second = insertTaskEventBatchedAsync(taskId, {
      id: `${taskId}:event-2`,
      type: "assistant",
      text: "two"
    });

    assert.deepEqual(listTaskEvents(taskId), []);
    assert.equal(getEventStoreRuntimeStats().taskBatchAppend.pending, 2);

    await flushTaskEventBatches();

    const cursors = await Promise.all([first, second]);
    assert.equal(cursors.length, 2);
    assert.ok(cursors[0] < cursors[1]);
    assert.deepEqual(listTaskEvents(taskId).map((event) => event.text), ["one", "two"]);
    assert.equal(getEventStoreRuntimeStats().taskBatchAppend.flushes >= 1, true);
  } finally {
    await flushTaskEventBatches();
    restoreEnv("VIBELINK_EVENT_STORE_BATCH_TASK_APPEND", previousFlag);
  }
});
