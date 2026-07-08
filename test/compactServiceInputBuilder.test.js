import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompactSummaryInput,
  getCompactServiceMetrics,
  resetCompactServiceMetrics
} from "../src/compactService.js";

test("compact summary input builder caps compactable text", () => {
  resetCompactServiceMetrics();
  const events = [
    { type: "user", kind: "user", text: "a".repeat(40) },
    { type: "assistant", kind: "assistant", text: "b".repeat(40) },
    { type: "tool.output", kind: "tool", text: "skip me" }
  ];

  const input = buildCompactSummaryInput(events, { maxChars: 50 });

  assert.ok(input.text.length <= 50);
  assert.equal(input.sourceChars, 40 + 40);
  assert.equal(input.includedEvents, 2);
  assert.equal(input.skippedEvents, 1);
  assert.equal(input.truncated, true);
  assert.doesNotMatch(input.text, /skip me/);

  const metrics = getCompactServiceMetrics();
  assert.equal(metrics.summaryInputsBuilt, 1);
  assert.equal(metrics.summaryInputTruncations, 1);
  assert.equal(metrics.summaryInputSourceChars, 80);
  assert.equal(metrics.summaryInputChars, input.text.length);
});

test("compact summary input builder keeps recent context under cap", () => {
  const events = [
    { type: "user", kind: "user", text: `old-${"a".repeat(40)}` },
    { type: "assistant", kind: "assistant", text: `middle-${"b".repeat(40)}` },
    { type: "user", kind: "user", text: "recent-keep" }
  ];

  const input = buildCompactSummaryInput(events, { maxChars: 50 });

  assert.ok(input.text.length <= 50);
  assert.match(input.text, /recent-keep/);
  assert.doesNotMatch(input.text, /old-/);
  assert.equal(input.truncated, true);
});
