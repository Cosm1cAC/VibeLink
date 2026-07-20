import assert from "node:assert/strict";
import test from "node:test";
import { createEventSyncHttpHandler } from "../src/eventSyncHttp.js";

function responseRecorder() {
  return { status: 0, payload: null };
}

test("ack API binds writes to the authenticated device and detects stale writers", async () => {
  let ack = { deviceId: "device-1", streamId: "task:task-1", cursor: 4 };
  const handler = createEventSyncHttpHandler({
    readBody: async () => ({ deviceId: "spoofed", streamId: "task:task-1", cursor: 8, expectedCursor: 3 }),
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    getEventAck: () => ack,
    upsertEventAck: (deviceId, streamId, cursor) => (ack = { deviceId, streamId, cursor }),
    listEventAcks: () => [],
    planRetention: () => ({}),
    compactEvents: () => ({}),
    listCompactionMarkers: () => []
  });
  const response = responseRecorder();
  const handled = await handler(
    { method: "POST" },
    response,
    new URL("http://bridge/api/events/ack"),
    { device: { id: "device-1" } }
  );

  assert.equal(handled, true);
  assert.equal(response.status, 409);
  assert.equal(response.payload.code, "EVENT_ACK_CONFLICT");
  assert.equal(ack.cursor, 4);
});

test("ack API accepts a compare-and-set update and exposes compaction markers", async () => {
  const calls = [];
  const handler = createEventSyncHttpHandler({
    readBody: async () => ({ streamId: "live-call:call-1", cursor: 9, expectedCursor: 4 }),
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    getEventAck: () => ({ deviceId: "device-1", streamId: "live-call:call-1", cursor: 4 }),
    upsertEventAck: (...args) => {
      calls.push(args);
      return { deviceId: args[0], streamId: args[1], cursor: args[2] };
    },
    listEventAcks: () => [],
    planRetention: () => ({}),
    compactEvents: () => ({}),
    listCompactionMarkers: () => [{ markerId: "marker-1" }]
  });
  const response = responseRecorder();
  await handler(
    { method: "POST" },
    response,
    new URL("http://bridge/api/events/ack"),
    { device: { id: "device-1" } }
  );
  assert.equal(response.status, 200);
  assert.equal(calls[0][0], "device-1");

  const markers = responseRecorder();
  await handler(
    { method: "GET" },
    markers,
    new URL("http://bridge/api/events/compaction-markers?streamId=live-call%3Acall-1"),
    { device: { id: "device-1" } }
  );
  assert.deepEqual(markers.payload.items, [{ markerId: "marker-1" }]);
});

test("event mutations are rate limited and audited", async () => {
  const audits = [];
  const handler = createEventSyncHttpHandler({
    readBody: async () => ({ streamId: "tool-event:run-1", dryRun: false }),
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    getEventAck: () => null,
    upsertEventAck: () => ({}),
    listEventAcks: () => [],
    planRetention: () => ({}),
    compactEvents: () => ({ deleted: 2 }),
    listCompactionMarkers: () => [],
    enforceRateLimit: () => true,
    audit: (...args) => audits.push(args)
  });
  const response = responseRecorder();
  await handler(
    { method: "POST" },
    response,
    new URL("http://bridge/api/events/compact"),
    { device: { id: "device-1" } }
  );
  assert.equal(response.status, 200);
  assert.equal(audits[0][3].type, "events.compact");
  assert.equal(audits[0][3].meta.deleted, 2);
});

test("ack list exposes every device for multi-device retention visibility", async () => {
  let filters = null;
  const handler = createEventSyncHttpHandler({
    readBody: async () => ({}),
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    getEventAck: () => null,
    upsertEventAck: () => ({}),
    listEventAcks: (value) => {
      filters = value;
      return [{ deviceId: "browser" }, { deviceId: "phone" }];
    },
    planRetention: () => ({}),
    compactEvents: () => ({}),
    listCompactionMarkers: () => []
  });
  const response = responseRecorder();
  await handler(
    { method: "GET" },
    response,
    new URL("http://bridge/api/events/acks?streamId=task:task-1"),
    { device: { id: "browser" } }
  );
  assert.deepEqual(filters, { streamId: "task:task-1" });
  assert.equal(response.payload.items.length, 2);
});
