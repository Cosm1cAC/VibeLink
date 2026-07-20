import test from "node:test";
import assert from "node:assert/strict";

import { enrichApprovalProductState } from "../src/approvalProductState.js";

test("joins approval delivery with execution attachment and provider fidelity", () => {
  const [approval] = enrichApprovalProductState(
    [{ id: "approval-1", taskId: "task-1", toolRunId: "run-1", provider: "codex", deliveryStatus: "applied" }],
    [
      { id: "wrong-binding", taskId: "task-1", toolRunId: "run-2", attachState: "lost", owner: "node" },
      { id: "binding-1", taskId: "task-1", toolRunId: "run-1", attachState: "attached", owner: "rust" }
    ],
    { providers: [{ id: "codex", fidelity: { level: "native", approvals: true } }] }
  );

  assert.equal(approval.execution.attachState, "attached");
  assert.equal(approval.execution.owner, "rust");
  assert.deepEqual(approval.providerFidelity, { level: "native", approvals: true });
});

test("does not attach an unrelated execution", () => {
  const [approval] = enrichApprovalProductState(
    [{ id: "approval-1", taskId: "task-1", toolRunId: "", provider: "claude" }],
    [{ id: "binding-2", taskId: "task-2", toolRunId: "run-2", attachState: "lost" }],
    { providers: [] }
  );
  assert.equal(approval.execution, null);
  assert.equal(approval.providerFidelity, null);
});
