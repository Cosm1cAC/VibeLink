import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createApprovalOutboxPersistence } from "../src/approvalOutbox.js";
import { createApprovalDispatcher } from "../src/approvalDispatcher.js";
import { ensureExecutionPersistenceSchema } from "../src/executionPersistence.js";

function fixture(kind = "provider.command", availableDecisions = ["accept", "acceptForSession", "decline", "cancel"]) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE approval_requests (
      id TEXT PRIMARY KEY, tool_run_id TEXT, task_id TEXT, workspace_id TEXT,
      kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, expires_at TEXT, decided_at TEXT,
      decided_by_device_id TEXT, decision_reason TEXT, decision_json TEXT,
      request_json TEXT, provider TEXT
    );
    CREATE TABLE approval_decisions (
      id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, tool_run_id TEXT,
      task_id TEXT, workspace_id TEXT, decision TEXT NOT NULL, reason TEXT,
      device_id TEXT, payload_json TEXT, created_at TEXT NOT NULL
    );
  `);
  ensureExecutionPersistenceSchema(db);
  db.prepare(`
    INSERT INTO approval_requests (
      id, kind, status, created_at, updated_at, expires_at, provider, request_json,
      continuation_ref, decision_version, delivery_status, available_decisions_json
    ) VALUES ('approval-1', ?, 'pending', ?, ?, ?, 'codex', ?, 'continuation-1', 0, 'pending', ?)
  `).run(
    kind,
    "2026-07-19T00:00:00.000Z",
    "2026-07-19T00:00:00.000Z",
    "2026-07-20T00:00:00.000Z",
    JSON.stringify({ executionId: "execution-1" }),
    JSON.stringify(availableDecisions)
  );
  let sequence = 0;
  const store = createApprovalOutboxPersistence({
    database: () => db,
    now: () => "2026-07-19T00:00:00.000Z",
    uuid: () => `id-${++sequence}`
  });
  return { db, store };
}

test("Codex approval decisions expose expected version and settle delivered then applied", () => {
  const { store } = fixture();
  const recorded = store.recordApprovalDecision({
    approvalId: "approval-1",
    operationId: "operation-1",
    continuationRef: "continuation-1",
    expectedDecisionVersion: 0,
    decision: { decision: "acceptForSession" }
  });
  assert.equal(recorded.approval.expectedVersion, 1);
  assert.deepEqual(recorded.approval.availableDecisions, ["accept", "acceptForSession", "decline", "cancel"]);

  store.claimApprovalOutbox();
  assert.equal(store.settleApprovalContinuation("continuation-1", "delivered").status, "delivered");
  assert.equal(store.settleApprovalContinuation("continuation-1", "applied").status, "applied");
  assert.equal(store.settleApprovalContinuation("continuation-1", "applied").status, "applied");
});

test("duplicate decisions are idempotent while opposite and unavailable decisions are rejected", () => {
  const { store } = fixture("provider.fileChange", ["accept", "decline"]);
  const input = {
    approvalId: "approval-1",
    operationId: "operation-1",
    continuationRef: "continuation-1",
    expectedDecisionVersion: 0,
    decision: { decision: "accept" }
  };
  assert.equal(store.recordApprovalDecision(input).duplicate, false);
  assert.equal(store.recordApprovalDecision(input).duplicate, true);
  assert.throws(
    () => store.recordApprovalDecision({ ...input, operationId: "operation-2", decision: { decision: "decline" } }),
    (error) => error.code === "APPROVAL_ALREADY_DECIDED"
  );

  const second = fixture("provider.permissions", ["grant", "decline"]).store;
  assert.throws(
    () => second.recordApprovalDecision({ ...input, decision: { decision: "accept" } }),
    (error) => error.code === "APPROVAL_DECISION_INVALID"
  );
});

test("a delivered continuation becomes stale when the upstream turn ends", () => {
  const { store } = fixture();
  store.recordApprovalDecision({
    approvalId: "approval-1",
    operationId: "operation-1",
    continuationRef: "continuation-1",
    expectedDecisionVersion: 0,
    decision: { decision: "decline" }
  });
  store.claimApprovalOutbox();
  store.settleApprovalContinuation("continuation-1", "delivered");
  const stale = store.settleApprovalContinuation("continuation-1", "stale", { reason: "turn completed" });
  assert.equal(stale.status, "stale");
  assert.equal(stale.lastError, "turn completed");
});

test("a new Bridge dispatcher delivers a recorded outbox decision to the surviving execution", async () => {
  const command = {
    id: "outbox-1",
    approvalId: "approval-1",
    operationId: "operation-1",
    continuationRef: "continuation-1",
    expectedVersion: 0,
    decision: { decision: "accept" }
  };
  const calls = [];
  const persistence = {
    claim: () => [command],
    getApproval: () => ({
      id: "approval-1",
      request: { executionId: "execution-1" },
      continuationRef: "continuation-1",
      decisionVersion: 1
    }),
    delivered: (item) => ({ ...item, status: "delivered" }),
    applied: (item) => ({ ...item, status: "applied" }),
    stale: () => assert.fail("continuation must not become stale"),
    outcomeUnknown: () => assert.fail("outcome must be known"),
    retry: () => assert.fail("surviving worker must be reachable")
  };
  const restartedBridge = createApprovalDispatcher({
    persistence,
    resolveApproval: async (input) => {
      calls.push(input);
      return { delivered: true };
    }
  });

  const result = await restartedBridge.dispatchOnce();
  assert.equal(result.status, "delivered");
  assert.deepEqual(calls, [{
    executionId: "execution-1",
    approvalId: "approval-1",
    continuationRef: "continuation-1",
    expectedVersion: 0,
    decision: { decision: "accept" },
    operationId: "operation-1",
    afterHostSeq: 0
  }]);
});
