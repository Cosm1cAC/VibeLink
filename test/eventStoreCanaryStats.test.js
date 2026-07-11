import assert from "node:assert/strict";
import test from "node:test";

import { evaluateLatency, summarizeLatencySamples } from "../tools/event-store/canaryStats.mjs";

test("event-store canary latency summary keeps raw evidence and trims host outliers", () => {
  const values = [
    9, 9, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
    10, 10, 10, 10, 10, 10, 10, 10, 11, 11, 160, 220
  ];
  const summary = summarizeLatencySamples(values, 50);

  assert.equal(summary.count, 24);
  assert.equal(summary.avgMs, 25);
  assert.equal(summary.trimmedCount, 20);
  assert.equal(summary.trimmedAvgMs, 10.1);
  assert.equal(summary.maxMs, 220);
  assert.equal(summary.stalls, 2);
});

test("event-store canary latency gate compares trimmed means", () => {
  const baseline = summarizeLatencySamples(Array(24).fill(15), 50);
  const candidate = summarizeLatencySamples([
    ...Array(22).fill(16),
    180,
    240
  ], 50);
  const result = evaluateLatency({ baseline, candidate, latencyMarginMs: 10 });

  assert.equal(result.pass, true);
  assert.equal(result.baselineMs, 15);
  assert.equal(result.candidateMs, 16);
  assert.equal(result.limitMs, 25);
});
