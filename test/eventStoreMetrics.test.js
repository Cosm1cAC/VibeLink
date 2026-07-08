import assert from "node:assert/strict";
import test from "node:test";

import { createEventStoreMetrics } from "../src/eventStoreMetrics.js";

test("event store metrics aggregate latency and fallback counts", () => {
  const metrics = createEventStoreMetrics({ now: () => "2026-01-01T00:00:00.000Z" });

  metrics.record({ method: "listToolEvents", mode: "worker", ok: true, durationMs: 12.4 });
  metrics.record({ method: "listToolEvents", mode: "worker", ok: false, durationMs: 20.2, fallback: true });
  metrics.record({ method: "listToolEvents", mode: "sync-fallback", ok: true, durationMs: 3.1 });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.requests, 3);
  assert.equal(snapshot.failures, 1);
  assert.equal(snapshot.fallbacks, 1);
  assert.equal(snapshot.methods.listToolEvents.count, 3);
  assert.equal(snapshot.methods.listToolEvents.failures, 1);
  assert.equal(snapshot.methods.listToolEvents.fallbacks, 1);
  assert.equal(snapshot.methods.listToolEvents.avgDurationMs, 11.9);
  assert.equal(snapshot.methods.listToolEvents.maxDurationMs, 20.2);
  assert.deepEqual(snapshot.methods.listToolEvents.modeCounts, {
    worker: 2,
    "sync-fallback": 1
  });
});
