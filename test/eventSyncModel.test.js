import test from "node:test";
import assert from "node:assert/strict";

import {
  approvalDeliveryPresentation,
  buildEventAck,
  eventStreamId,
  retentionPresentation
} from "../apps/web/src/eventSyncModel.js";

test("builds stable stream ids and monotonic ack payloads", () => {
  assert.equal(eventStreamId("task", "task-1"), "task:task-1");
  assert.equal(eventStreamId("live-call", "call-1"), "live-call:call-1");
  assert.equal(eventStreamId("tool-event", "run-1"), "tool-event:run-1");

  assert.deepEqual(buildEventAck("task:task-1", 12, 8, "event-12"), {
    streamId: "task:task-1",
    cursor: 12,
    expectedCursor: 8,
    eventId: "event-12"
  });
  assert.equal(buildEventAck("task:task-1", 8, 8), null);
  assert.throws(() => eventStreamId("task", ""), /stream id/i);
});

test("presents approval delivery and runtime attachment outcomes", () => {
  assert.deepEqual(
    approvalDeliveryPresentation({ deliveryStatus: "applied", execution: { attachState: "attached" } }),
    { tone: "ok", label: "Applied", detail: "Runtime attached" }
  );
  assert.equal(approvalDeliveryPresentation({ deliveryStatus: "stale" }).label, "Stale after reconnect");
  assert.equal(approvalDeliveryPresentation({ deliveryStatus: "outcome_unknown" }).tone, "warning");
  assert.equal(approvalDeliveryPresentation({ status: "pending" }).label, "Awaiting decision");
});

test("makes multi-device retention blockers visible", () => {
  assert.deepEqual(
    retentionPresentation({ safe: false, blockedByDeviceIds: ["phone", "browser"] }),
    { tone: "warning", label: "Blocked by 2 devices", blockedByDeviceIds: ["phone", "browser"] }
  );
  assert.equal(retentionPresentation({ safe: true, compactThroughCursor: 42 }).label, "Safe through cursor 42");
});
