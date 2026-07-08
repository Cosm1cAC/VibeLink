import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createToolRun, drainEventStoreRuntime, getEventStoreRuntimeStats, insertToolEvent } from "../src/db.js";
import { getToolEventSseMetrics, resetToolEventSseMetrics, subscribeToolEvents } from "../src/toolRuntime.js";

class FakeSseResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.chunks = [];
    this.headers = null;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  close() {
    this.writableEnded = true;
    this.emit("close");
  }
}

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

test("tool event SSE metrics record replay count and latency", async () => {
  resetToolEventSseMetrics();
  const run = createToolRun({
    id: `sse-metrics-${Date.now()}`,
    toolName: "test.tool",
    status: "running"
  });
  insertToolEvent(run.id, {
    id: `${run.id}:event-1`,
    type: "tool.stdout",
    text: "one"
  });

  const response = new FakeSseResponse();
  assert.equal(await subscribeToolEvents(response, { toolRunId: run.id }), true);
  response.close();

  const metrics = getToolEventSseMetrics();
  assert.equal(metrics.replays, 1);
  assert.equal(metrics.replayEvents, 1);
  assert.equal(typeof metrics.lastReplayDurationMs, "number");
  assert.equal(typeof metrics.avgReplayDurationMs, "number");
  assert.equal(metrics.lastReplayEvents, 1);
  assert.match(response.chunks.join(""), /tool\.stdout/);
});

test("tool event SSE replay uses worker query when enabled", async () => {
  const previousWorkerFlag = process.env.VIBELINK_EVENT_STORE_WORKER;
  process.env.VIBELINK_EVENT_STORE_WORKER = "1";
  resetToolEventSseMetrics();

  try {
    const run = createToolRun({
      id: `sse-worker-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });
    insertToolEvent(run.id, {
      id: `${run.id}:event-1`,
      type: "tool.stdout",
      text: "worker"
    });

    const response = new FakeSseResponse();
    assert.equal(await subscribeToolEvents(response, { toolRunId: run.id }), true);
    response.close();

    const stats = getEventStoreRuntimeStats();
    assert.equal(stats.metrics.methods.listToolEvents.modeCounts.worker >= 1, true);
    assert.match(response.chunks.join(""), /worker/);
  } finally {
    await drainEventStoreRuntime();
    restoreEnv("VIBELINK_EVENT_STORE_WORKER", previousWorkerFlag);
  }
});
