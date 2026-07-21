import assert from "node:assert/strict";
import test from "node:test";
import { mapApprovalApiDecision } from "../src/approvalDecision.js";

test("approval API maps generic decisions to provider-native available decisions", () => {
  assert.deepEqual(mapApprovalApiDecision("approve", ["grant", "decline"]), { decision: "grant" });
  assert.deepEqual(mapApprovalApiDecision("deny", ["grant", "decline"]), { decision: "decline" });
  assert.deepEqual(mapApprovalApiDecision("approve", ["accept", "acceptForSession", "cancel"]), { decision: "accept" });
  assert.deepEqual(mapApprovalApiDecision("approve", ["acceptForSession", "cancel"]), { decision: "acceptForSession" });
  assert.deepEqual(mapApprovalApiDecision("deny", ["acceptForSession", "cancel"]), { decision: "cancel" });
  assert.deepEqual(mapApprovalApiDecision({ decision: "grant" }, ["grant", "decline"]), { decision: "grant" });
});
