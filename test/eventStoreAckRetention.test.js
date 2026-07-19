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

test("retention waits for every active device and compacts each event stream safely", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, revoked_at TEXT, expires_at TEXT
    );
    CREATE TABLE task_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      event_id TEXT NOT NULL, event_type TEXT, event_kind TEXT, turn_id TEXT,
      block_id TEXT, event_at TEXT NOT NULL, text TEXT
    );
    CREATE TABLE tool_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, tool_run_id TEXT NOT NULL,
      event_id TEXT NOT NULL, event_type TEXT, event_at TEXT NOT NULL, text TEXT
    );
    CREATE TABLE live_call_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      event_id TEXT NOT NULL, event_type TEXT, event_at TEXT NOT NULL, text TEXT
    );
    INSERT INTO devices VALUES ('device-1', NULL, NULL), ('device-2', NULL, NULL),
      ('revoked', '2026-07-01T00:00:00.000Z', NULL);
    INSERT INTO task_events (task_id, event_id, event_at) VALUES
      ('task-1', 't1', '2026-01-01T00:00:00.000Z'),
      ('task-1', 't2', '2026-01-02T00:00:00.000Z'),
      ('task-1', 't3', '2026-01-03T00:00:00.000Z');
  `);
  const store = createSqliteEventStore({ database: () => db });

  store.upsertEventAck("device-1", "task:task-1", 3);
  const blocked = store.planRetention({
    streamId: "task:task-1",
    retentionDays: 1,
    keepLatest: 1,
    now: Date.parse("2026-07-20T00:00:00.000Z")
  });
  assert.equal(blocked.safeCursor, null);
  assert.deepEqual(blocked.blockedByDeviceIds, ["device-2"]);

  store.upsertEventAck("device-2", "task:task-1", 2);
  const result = store.compactEvents({
    streamId: "task:task-1",
    retentionDays: 1,
    keepLatest: 1,
    now: Date.parse("2026-07-20T00:00:00.000Z"),
    dryRun: false
  });
  assert.equal(result.safeCursor, 2);
  assert.equal(result.deleted, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_events").get().count, 1);
  assert.equal(store.listCompactionMarkers({ streamId: "task:task-1" })[0].toCursor, 2);
  db.close();
});

test("quota compaction emits a durable spool quota marker", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tool_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, tool_run_id TEXT NOT NULL,
      event_id TEXT NOT NULL, event_type TEXT, event_at TEXT NOT NULL, text TEXT,
      payload_json TEXT, event_json TEXT
    );
    INSERT INTO tool_events (tool_run_id, event_id, event_at, text, event_json) VALUES
      ('run-1', 'e1', '2026-07-20T00:00:00.000Z', 'aaaaaaaaaa', '{}'),
      ('run-1', 'e2', '2026-07-20T00:00:01.000Z', 'bbbbbbbbbb', '{}');
  `);
  const store = createSqliteEventStore({ database: () => db });
  store.upsertEventAck("device-1", "tool-event:run-1", 2);

  const result = store.compactEvents({
    streamId: "tool-event:run-1",
    retentionDays: 365,
    keepLatest: 2,
    spoolQuotaBytes: 1,
    now: Date.parse("2026-07-20T00:00:02.000Z"),
    dryRun: false
  });
  assert.equal(result.deleted, 2);
  assert.equal(result.marker.metadata.reason, "spool_quota");
  db.close();
});

test("retention never deletes the protected latest window", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE task_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      event_id TEXT NOT NULL, event_at TEXT NOT NULL, text TEXT,
      payload_json TEXT, event_json TEXT
    );
    INSERT INTO task_events (task_id, event_id, event_at) VALUES
      ('task-1', 't1', '2026-01-01T00:00:00.000Z'),
      ('task-1', 't2', '2026-01-02T00:00:00.000Z');
  `);
  const store = createSqliteEventStore({ database: () => db });
  store.upsertEventAck("device-1", "task:task-1", 2);
  const result = store.compactEvents({
    streamId: "task:task-1",
    retentionDays: 1,
    keepLatest: 10,
    now: Date.parse("2026-07-20T00:00:00.000Z"),
    dryRun: false
  });
  assert.equal(result.deleted, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_events").get().count, 2);
  db.close();
});
