import assert from "node:assert/strict";
import test from "node:test";

import { capabilityCategories, automationDraftPayload } from "../apps/web/src/capabilityCenterModel.js";

test("capability center exposes every managed category and validates automation drafts", () => {
  assert.deepEqual(capabilityCategories.map((item) => item.id), ["plugins", "hooks", "automations", "subagents", "config"]);
  assert.deepEqual(automationDraftPayload({ title: "Check", type: "cron", value: "0 * * * *", prompt: "inspect" }), {
    title: "Check", enabled: true, schedule: { type: "cron", value: "0 * * * *" }, payload: { prompt: "inspect" }
  });
  assert.throws(() => automationDraftPayload({ title: "", prompt: "" }), /title/i);
});
