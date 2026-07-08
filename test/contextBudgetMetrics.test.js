import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateEventsTokenCount,
  getContextBudgetMetrics,
  resetContextBudgetMetrics
} from "../src/contextBudget.js";

test("context budget metrics count event token estimation work", () => {
  resetContextBudgetMetrics();
  const events = [
    { type: "user", text: "hello" },
    { type: "tool.result", payload: { text: "world", input: { command: "npm test" } } }
  ];

  const tokens = estimateEventsTokenCount(events, "gpt-5");
  const metrics = getContextBudgetMetrics();

  assert.ok(tokens > 0);
  assert.equal(metrics.eventEstimateCalls, 1);
  assert.equal(metrics.eventsEstimated, 2);
  assert.ok(metrics.charsEstimated > 0);
  assert.ok(metrics.totalEstimateMs >= 0);
  assert.equal(typeof metrics.avgEstimateMs, "number");
  assert.equal(typeof metrics.maxEstimateMs, "number");
});
