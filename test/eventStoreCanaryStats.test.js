import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeCanarySchema } from "../tools/event-store/canary.mjs";
import { evaluateLatency, summarizeLatencySamples } from "../tools/event-store/canaryStats.mjs";
import { evaluate as evaluateServerCanary, metricDelta } from "../tools/event-store/server-canary.mjs";

test("event-store canary schema includes retention and acknowledgement tables", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeCanarySchema(db);
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
    );

    assert.equal(tables.has("event_acks"), true);
    assert.equal(tables.has("retention_policies"), true);
    assert.equal(tables.has("compaction_markers"), true);
  } finally {
    db.close();
  }
});

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

test("event-store server canary evaluates only post-warm-up metric deltas", () => {
  const eventStore = {
    mode: "rust-sidecar",
    rustSidecar: {
      enabled: true,
      available: true,
      ready: true,
      failed: false,
      failures: 0,
      fallbacks: 0,
      client: { pending: 0, backpressureRejects: 0 }
    },
    metrics: {
      failures: 0,
      fallbacks: 0,
      stalls: { count: 1 },
      methods: {
        insertToolEvents: {
          count: 1,
          avgDurationMs: 600,
          failures: 0,
          fallbacks: 0,
          modeCounts: { "rust-sidecar": 1 }
        },
        insertLiveCallEvents: {
          count: 1,
          avgDurationMs: 400,
          failures: 0,
          fallbacks: 0,
          modeCounts: { "rust-sidecar": 1 }
        }
      }
    }
  };
  const baseline = { storeMode: "rust-sidecar", eventStore };
  const stats = structuredClone(baseline);
  stats.eventStore.metrics.methods.insertToolEvents = {
    count: 2,
    avgDurationMs: 310,
    failures: 0,
    fallbacks: 0,
    modeCounts: { "rust-sidecar": 2 }
  };
  stats.eventStore.metrics.methods.insertLiveCallEvents = {
    count: 3,
    avgDurationMs: 150,
    failures: 0,
    fallbacks: 0,
    modeCounts: { "rust-sidecar": 3 }
  };

  assert.deepEqual(metricDelta(baseline, stats, "insertToolEvents"), {
    count: 1,
    failures: 0,
    fallbacks: 0,
    avgDurationMs: 20,
    modeCounts: { "rust-sidecar": 1 }
  });
  assert.equal(evaluateServerCanary(stats, baseline, { maxAppendAvgMs: 500 }).passed, true);
});
