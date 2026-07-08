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
});
