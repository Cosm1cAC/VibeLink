import assert from "node:assert/strict";
import test from "node:test";

import { buildCompactSummaryInput } from "../src/compactService.js";

test("compact summary input builder caps compactable text", () => {
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
});
