import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSqliteEventStore } from "../src/eventStore.js";

test("event ack repository is monotonic and retention is ack-aware", () => {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteEventStore({ database: () => db });
  assert.equal(store.upsertEventAck("device-1", "task:1", 12).cursor, 12);
  assert.equal(store.upsertEventAck("device-1", "task:1", 4).cursor, 12);
  assert.equal(store.getEventAck("device-1", "task:1").cursor, 12);
  assert.equal(store.planRetention({ streamId: "task:1", retentionDays: 7 }).ackCursor, 12);
  store.recordCompactionMarker({ markerId: "m1", streamId: "task:1", fromCursor: 1, toCursor: 10 });
  assert.equal(store.listCompactionMarkers({ streamId: "task:1" })[0].markerId, "m1");
  assert.equal(store.deleteDeviceEventAcks("device-1"), 1);
  assert.equal(store.getEventAck("device-1", "task:1"), null);
  db.close();
});
