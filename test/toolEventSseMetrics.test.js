import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createToolRun, insertToolEvent } from "../src/db.js";
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

test("tool event SSE metrics record replay count and latency", () => {
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
  assert.equal(subscribeToolEvents(response, { toolRunId: run.id }), true);
  response.close();

  const metrics = getToolEventSseMetrics();
  assert.equal(metrics.replays, 1);
  assert.equal(metrics.replayEvents, 1);
  assert.equal(typeof metrics.lastReplayDurationMs, "number");
  assert.equal(typeof metrics.avgReplayDurationMs, "number");
  assert.equal(metrics.lastReplayEvents, 1);
  assert.match(response.chunks.join(""), /tool\.stdout/);
});
