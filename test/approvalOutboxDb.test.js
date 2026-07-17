import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createApprovalOutboxPersistence } from "../src/approvalOutbox.js";
import { ensureExecutionPersistenceSchema } from "../src/executionPersistence.js";

const START = "2026-01-01T00:00:00.000Z";

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE approval_requests (
      id TEXT PRIMARY KEY,
      tool_run_id TEXT,
      task_id TEXT,
      workspace_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      decided_at TEXT,
      decided_by_device_id TEXT,
      decision_reason TEXT,
      decision_json TEXT
    );
    CREATE TABLE approval_decisions (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      tool_run_id TEXT,
      task_id TEXT,
      workspace_id TEXT,
      decision TEXT NOT NULL,
      reason TEXT,
      device_id TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE CASCADE
    );
  `);
  ensureExecutionPersistenceSchema(db);
  return db;
}

function insertApproval(db, overrides = {}) {
  const input = {
    id: "approval-1",
    status: "pending",
    expiresAt: "2026-01-02T00:00:00.000Z",
    continuationRef: "continuation-1",
    decisionVersion: 0,
    ...overrides
  };
  db.prepare(`
    INSERT INTO approval_requests (
      id, kind, status, created_at, updated_at, expires_at, continuation_ref,
      decision_version, delivery_status, available_decisions_json
    ) VALUES (?, 'provider.command', ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    input.id,
    input.status,
    START,
    START,
    input.expiresAt,
    input.continuationRef,
    input.decisionVersion,
    JSON.stringify(["approved", "denied"])
  );
}

function createStore(db) {
  let uuid = 0;
  return createApprovalOutboxPersistence({
    database: () => db,
    now: () => START,
    uuid: () => `generated-${++uuid}`
  });
}

test("approval decision and outbox command commit once for duplicate operations", () => {
  const db = createDb();
  insertApproval(db);
  const store = createStore(db);
  const command = {
    approvalId: "approval-1",
    operationId: "operation-1",
    continuationRef: "continuation-1",
    expectedDecisionVersion: 0,
    decision: { decision: "approved", scope: "single" },
    reason: "Reviewed",
    deviceId: "device-1"
  };

  const first = store.recordApprovalDecision(command);
  const duplicate = store.recordApprovalDecision(command);

  assert.equal(first.duplicate, false);
  assert.equal(first.approval.status, "approved");
  assert.equal(first.approval.deliveryStatus, "decision_recorded");
  assert.equal(first.approval.decisionVersion, 1);
  assert.equal(first.outbox.status, "decision_recorded");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.outbox.id, first.outbox.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM approval_outbox").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM approval_decisions").get().count, 1);

  assert.throws(
    () => store.recordApprovalDecision({
      ...command,
      operationId: "operation-2",
      decision: { decision: "denied" }
    }),
    (error) => error.code === "APPROVAL_ALREADY_DECIDED"
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM approval_outbox").get().count, 1);
});

test("approval outbox retries transport failures and marks the original approval applied", () => {
  const db = createDb();
  insertApproval(db);
  const store = createStore(db);
  const recorded = store.recordApprovalDecision({
    approvalId: "approval-1",
    operationId: "operation-1",
    continuationRef: "continuation-1",
    expectedDecisionVersion: 0,
    decision: { decision: "approved" }
  });

  const [firstAttempt] = store.claimApprovalOutbox({ at: START, limit: 10 });
  assert.equal(firstAttempt.id, recorded.outbox.id);
  assert.equal(firstAttempt.status, "delivering");
  assert.equal(firstAttempt.attempts, 1);
  assert.equal(store.getApproval("approval-1").deliveryStatus, "delivering");

  store.retryApprovalOutbox(firstAttempt.id, {
    error: "worker unavailable",
    nextAttemptAt: "2026-01-01T00:01:00.000Z"
  });
  assert.equal(store.getApproval("approval-1").deliveryStatus, "decision_recorded");
  assert.deepEqual(store.claimApprovalOutbox({ at: "2026-01-01T00:00:59.000Z" }), []);
  const [secondAttempt] = store.claimApprovalOutbox({ at: "2026-01-01T00:01:00.000Z" });
  assert.equal(secondAttempt.attempts, 2);
  assert.equal(secondAttempt.lastError, "worker unavailable");

  const applied = store.markApprovalOutboxApplied(secondAttempt.id, {
    deliveredAt: "2026-01-01T00:01:01.000Z",
    appliedAt: "2026-01-01T00:01:02.000Z"
  });
  assert.equal(applied.status, "applied");
  assert.equal(store.getApproval("approval-1").deliveryStatus, "applied");
  assert.deepEqual(store.claimApprovalOutbox({ at: "2026-01-01T00:02:00.000Z" }), []);
});

test("approval outbox reclaims an expired delivery lease after a dispatcher crash", () => {
  const db = createDb();
  insertApproval(db);
  const store = createStore(db);
  store.recordApprovalDecision({
    approvalId: "approval-1",
    operationId: "operation-1",
    continuationRef: "continuation-1",
    expectedDecisionVersion: 0,
    decision: { decision: "approved" }
  });

  const [firstAttempt] = store.claimApprovalOutbox({ at: START, leaseMs: 30_000 });
  assert.equal(firstAttempt.attempts, 1);
  assert.deepEqual(
    store.claimApprovalOutbox({ at: "2026-01-01T00:00:29.999Z", leaseMs: 30_000 }),
    []
  );
  const [reclaimed] = store.claimApprovalOutbox({
    at: "2026-01-01T00:00:30.000Z",
    leaseMs: 30_000
  });
  assert.equal(reclaimed.id, firstAttempt.id);
  assert.equal(reclaimed.status, "delivering");
  assert.equal(reclaimed.attempts, 2);
});

test("stale approval decisions fail without creating an outbox command", () => {
  const db = createDb();
  insertApproval(db, { expiresAt: "2025-12-31T23:59:59.000Z" });
  const store = createStore(db);

  assert.throws(
    () => store.recordApprovalDecision({
      approvalId: "approval-1",
      operationId: "operation-1",
      continuationRef: "continuation-1",
      expectedDecisionVersion: 0,
      decision: { decision: "approved" }
    }),
    (error) => error.code === "APPROVAL_STALE"
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM approval_outbox").get().count, 0);
  assert.equal(db.prepare("SELECT status FROM approval_requests WHERE id = 'approval-1'").get().status, "pending");
});
