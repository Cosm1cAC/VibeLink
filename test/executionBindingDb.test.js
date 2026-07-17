import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  EXECUTION_PERSISTENCE_SCHEMA_VERSION,
  createExecutionPersistence,
  ensureExecutionPersistenceSchema
} from "../src/executionPersistence.js";

function createLegacyDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE approval_requests (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO approval_requests (id, kind, status, created_at, updated_at)
    VALUES ('legacy-approval', 'tool', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  return db;
}

test("execution persistence migration is repeatable and preserves legacy approvals", () => {
  const db = createLegacyDb();

  ensureExecutionPersistenceSchema(db);
  ensureExecutionPersistenceSchema(db);

  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?")
      .get(EXECUTION_PERSISTENCE_SCHEMA_VERSION).count,
    1
  );
  assert.equal(db.prepare("SELECT status FROM approval_requests WHERE id = ?").get("legacy-approval").status, "pending");
  const approvalColumns = new Set(db.prepare("PRAGMA table_info(approval_requests)").all().map((row) => row.name));
  for (const name of [
    "provider",
    "thread_id",
    "turn_id",
    "item_id",
    "continuation_ref",
    "decision_version",
    "delivery_status",
    "requested_permissions_json",
    "available_decisions_json"
  ]) {
    assert.ok(approvalColumns.has(name), `missing approval_requests.${name}`);
  }
});

test("execution event ingest advances the host cursor atomically and deduplicates replay", () => {
  const db = createLegacyDb();
  ensureExecutionPersistenceSchema(db);
  const store = createExecutionPersistence({
    database: () => db,
    now: () => "2026-01-01T00:00:00.000Z"
  });
  store.upsertExecutionBinding({
    id: "execution-1",
    kind: "command",
    owner: "execution-host",
    status: "running",
    attachState: "attached",
    workerInstanceId: "worker-1",
    protocolVersion: 1
  });
  assert.throws(
    () => store.upsertExecutionBinding({
      id: "invalid-cursors",
      kind: "command",
      status: "running",
      attachState: "attached",
      lastSeenHostSeq: 1,
      lastIngestedHostSeq: 2,
      lastAckedHostSeq: 1
    }),
    (error) => error.code === "EXECUTION_CURSOR_INVALID"
  );

  const event = {
    eventId: "execution-1:1",
    hostSeq: 1,
    type: "stream.stdout",
    at: "2026-01-01T00:00:01.000Z",
    payload: { text: "hello" }
  };
  const first = store.ingestExecutionEvent("execution-1", event);
  const duplicate = store.ingestExecutionEvent("execution-1", event);

  assert.deepEqual(first, { inserted: true, duplicate: false, hostSeq: 1 });
  assert.deepEqual(duplicate, { inserted: false, duplicate: true, hostSeq: 1 });
  assert.equal(store.getExecutionBinding("execution-1").lastIngestedHostSeq, 1);
  assert.equal(store.listExecutionEvents("execution-1").length, 1);
  assert.equal(store.ackExecutionEvents("execution-1", 1).lastAckedHostSeq, 1);
  assert.throws(
    () => store.ackExecutionEvents("execution-1", 2),
    (error) => error.code === "HOST_ACK_AHEAD" && error.lastIngestedHostSeq === 1
  );

  assert.throws(
    () => store.ingestExecutionEvent("execution-1", { ...event, eventId: "different" }),
    (error) => error.code === "HOST_EVENT_CONFLICT"
  );
  assert.throws(
    () => store.ingestExecutionEvent("execution-1", { ...event, eventId: "execution-1:3", hostSeq: 3 }),
    (error) => error.code === "HOST_SEQUENCE_GAP" && error.expectedHostSeq === 2
  );
  assert.equal(store.getExecutionBinding("execution-1").lastIngestedHostSeq, 1);
  assert.equal(store.listExecutionEvents("execution-1").length, 1);
});
