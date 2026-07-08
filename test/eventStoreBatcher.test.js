import assert from "node:assert/strict";
import test from "node:test";

import { createEventStoreBatcher } from "../src/eventStoreBatcher.js";

test("event store batcher flushes grouped events in order", async () => {
  const flushed = [];
  const batcher = createEventStoreBatcher({
    delayMs: 0,
    flushBatch: async (key, events) => {
      flushed.push({ key, ids: events.map((event) => event.id) });
      return events.map((event, index) => `${key}:${event.id}:${index}`);
    }
  });

  const first = batcher.enqueue("tool:1", { id: "a" });
  const second = batcher.enqueue("tool:1", { id: "b" });
  const third = batcher.enqueue("task:1", { id: "c" });

  assert.equal(batcher.stats().pending, 3);
  await batcher.flushNow();

  assert.deepEqual(flushed, [
    { key: "tool:1", ids: ["a", "b"] },
    { key: "task:1", ids: ["c"] }
  ]);
  assert.deepEqual(await Promise.all([first, second, third]), [
    "tool:1:a:0",
    "tool:1:b:1",
    "task:1:c:0"
  ]);
  assert.equal(batcher.pendingCount(), 0);
  assert.equal(batcher.stats().flushes, 1);
  assert.equal(batcher.stats().maxBatchSize, 3);
  assert.equal(typeof batcher.stats().lastFlushAt, "string");
});

test("event store batcher flushes when max batch size is reached", async () => {
  const flushed = [];
  const batcher = createEventStoreBatcher({
    delayMs: 10000,
    maxBatchSize: 2,
    flushBatch: async (key, events) => {
      flushed.push({ key, count: events.length });
      return events.map((event) => event.id);
    }
  });

  const first = batcher.enqueue("tool:1", { id: "a" });
  const second = batcher.enqueue("tool:1", { id: "b" });

  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.deepEqual(flushed, [{ key: "tool:1", count: 2 }]);
  assert.equal(batcher.stats().maxBatchSize, 2);
});

test("event store batcher records flush latency and average batch size", async () => {
  const batcher = createEventStoreBatcher({
    delayMs: 0,
    flushBatch: async (_key, events) => events.map((event) => event.id)
  });

  const first = batcher.enqueue("tool:metrics", { id: "a" });
  const second = batcher.enqueue("tool:metrics", { id: "b" });

  await batcher.flushNow();
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);

  const stats = batcher.stats();
  assert.equal(stats.totalEvents, 2);
  assert.equal(stats.avgBatchSize, 2);
  assert.equal(typeof stats.lastFlushDurationMs, "number");
  assert.equal(typeof stats.avgFlushDurationMs, "number");
});
