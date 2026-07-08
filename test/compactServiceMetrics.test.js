import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompactedContext,
  getCompactServiceMetrics,
  resetCompactServiceMetrics
} from "../src/compactService.js";

test("compact service metrics count compacted context builds", () => {
  resetCompactServiceMetrics();
  const events = [
    { type: "user", kind: "user", text: "x".repeat(300_000) },
    {
      type: "summarization",
      kind: "summary",
      text: "Prior work summary",
      payload: { trigger: "manual" }
    }
  ];

  const compacted = buildCompactedContext("task-compact-metrics", events, "gpt-4");
  const metrics = getCompactServiceMetrics();

  assert.equal(compacted.type, "compacted_context");
  assert.equal(metrics.buildContextCalls, 1);
  assert.equal(metrics.eventsChecked, 2);
  assert.equal(metrics.compactedContextsReturned, 1);
  assert.ok(metrics.totalMs >= 0);
});
