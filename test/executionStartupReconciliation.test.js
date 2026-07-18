import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createExecutionPersistence, ensureExecutionPersistenceSchema } from "../src/executionPersistence.js";
import { createExecutionStartupReconciler } from "../src/executionReconciliation.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE approval_requests (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureExecutionPersistenceSchema(db);
  const persistence = createExecutionPersistence({ database: () => db });
  return { db, persistence };
}

function binding(persistence, input = {}) {
  return persistence.upsertExecutionBinding({
    id: input.id || "execution-1",
    kind: input.kind || "terminal",
    owner: input.owner || "execution-host",
    status: input.status || "running",
    attachState: input.attachState || "attached",
    taskId: input.taskId || "",
    toolRunId: input.toolRunId || "",
    ...input
  });
}

test("startup reconciliation replays, transactionally projects, acknowledges, and restores", async () => {
  const { db, persistence } = fixture();
  binding(persistence, { toolRunId: "tool-1" });
  db.exec("CREATE TABLE projected_events (event_id TEXT PRIMARY KEY)");
  const calls = [];
  const events = [1, 2].map((hostSeq) => ({
    executionId: "execution-1",
    hostSeq,
    eventId: `execution-1:${hostSeq}`,
    type: "stream.pty",
    at: "2026-07-19T00:00:00.000Z",
    payload: { text: String(hostSeq) }
  }));
  const host = {
    async get() {
      return { executionId: "execution-1", status: "running", attachState: "attached", lastHostSeq: 2, lastAckedHostSeq: 0 };
    },
    async events(id, after) {
      calls.push(["events", id, after]);
      return { events: events.filter((event) => event.hostSeq > after), lastHostSeq: 2 };
    },
    async ack(id, seq, operationId) {
      calls.push(["ack", id, seq, operationId]);
      return { ackedHostSeq: seq };
    }
  };
  let restored;
  const reconciler = createExecutionStartupReconciler({
    persistence,
    host,
    projectEvent(_binding, event, database) {
      database.prepare("INSERT INTO projected_events (event_id) VALUES (?)").run(event.eventId);
    },
    async restoreSubscription(current, snapshot) {
      restored = { current, snapshot };
    }
  });

  const results = await reconciler.reconcile();
  assert.equal(results[0].error, undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM projected_events").get().count, 2);
  assert.equal(persistence.getExecutionBinding("execution-1").lastAckedHostSeq, 2);
  assert.deepEqual(calls.slice(0, 2).map((call) => call[0]), ["events", "ack"]);
  assert.equal(restored.current.attachState, "attached");
  assert.equal(restored.snapshot.lastAckedHostSeq, 2);
});

test("projection failure rolls back ingest and prevents host acknowledgement", async () => {
  const { persistence } = fixture();
  binding(persistence);
  let acknowledged = false;
  const reconciler = createExecutionStartupReconciler({
    persistence,
    host: {
      async get() { return { status: "running", attachState: "attached", lastHostSeq: 1 }; },
      async events() {
        return { events: [{ hostSeq: 1, eventId: "event-1", type: "stream.pty", payload: null }] };
      },
      async ack() { acknowledged = true; }
    },
    projectEvent() { throw new Error("projection failed"); }
  });

  const [result] = await reconciler.reconcile();
  assert.match(result.error.message, /projection failed/);
  assert.equal(persistence.getExecutionBinding("execution-1").lastIngestedHostSeq, 0);
  assert.equal(acknowledged, false);
});

test("startup reconciliation converges external, unreachable, and missing bindings", async () => {
  const { persistence } = fixture();
  binding(persistence, { id: "external-1", owner: "external", attachState: "external" });
  binding(persistence, { id: "unreachable-1" });
  binding(persistence, { id: "missing-1" });
  const restored = [];
  const reconciler = createExecutionStartupReconciler({
    persistence,
    host: {
      async get(id) {
        const error = new Error(id);
        error.code = id === "missing-1" ? "EXECUTION_NOT_FOUND" : "EXECUTION_HOST_UNAVAILABLE";
        throw error;
      }
    },
    async restoreSubscription(current) { restored.push(current.id); }
  });

  await reconciler.reconcile();
  assert.equal(persistence.getExecutionBinding("external-1").attachState, "external");
  assert.equal(persistence.getExecutionBinding("unreachable-1").attachState, "unreachable");
  assert.equal(persistence.getExecutionBinding("unreachable-1").status, "running");
  assert.equal(persistence.getExecutionBinding("missing-1").attachState, "lost");
  assert.equal(persistence.getExecutionBinding("missing-1").status, "lost");
  assert.deepEqual(restored, ["external-1"]);
});
