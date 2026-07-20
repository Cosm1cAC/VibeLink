import assert from "node:assert/strict";
import test from "node:test";

import { capabilityCategories, automationDraftPayload, capabilityOperationMessage } from "../apps/web/src/capabilityCenterModel.js";

test("capability center exposes every managed category and validates automation drafts", () => {
  assert.deepEqual(capabilityCategories.map((item) => item.id), ["plugins", "hooks", "automations", "subagents", "config"]);
  assert.deepEqual(automationDraftPayload({ title: "Check", type: "cron", value: "0 * * * *", prompt: "inspect" }), {
    title: "Check", enabled: true, schedule: { type: "cron", value: "0 * * * *" }, payload: { prompt: "inspect" }
  });
  assert.throws(() => automationDraftPayload({ title: "", prompt: "" }), /title/i);
});

test("capability operations surface success, approval, and server errors consistently", () => {
  assert.deepEqual(capabilityOperationMessage(null, "Plugin installed."), { tone: "success", text: "Plugin installed." });
  assert.deepEqual(capabilityOperationMessage({ status: 428, data: { approvalId: "approval-1", error: "Explicit approval required." } }), { tone: "approval", text: "Explicit approval required. Approval approval-1 is pending in Settings > Approvals." });
  assert.deepEqual(capabilityOperationMessage(new Error("Offline")), { tone: "error", text: "Offline" });
});
