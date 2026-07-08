import assert from "node:assert/strict";
import test from "node:test";

import { compactTask, resetCompactServiceMetrics } from "../src/compactService.js";
import { insertTaskEvent, listTaskEvents, upsertTask } from "../src/db.js";

test("compactTask records dropped compactable events in summary payload", async () => {
  resetCompactServiceMetrics();
  const taskId = `compact-task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  upsertTask({
    id: taskId,
    agent: "test",
    title: "Compact task payload test",
    cwd: process.cwd(),
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  for (let index = 0; index < 6; index += 1) {
    insertTaskEvent(taskId, {
      id: `${taskId}:event-${index}`,
      at: "2026-01-01T00:00:00.000Z",
      type: "user",
      kind: "user",
      text: `event-${index}-${"x".repeat(30)}`
    });
  }

  const summary = await compactTask(taskId, "gpt-4", {
    maxInputChars: 120,
    maxBufferedLines: 2
  });
  const events = listTaskEvents(taskId, { after: 0, limit: 20 });
  const persistedSummary = events.find((event) => event.type === "summarization");

  assert.equal(summary.payload.compactableDroppedEvents, 4);
  assert.equal(persistedSummary.payload.compactableDroppedEvents, 4);
  assert.equal(persistedSummary.payload.compactableTruncated, true);
});
