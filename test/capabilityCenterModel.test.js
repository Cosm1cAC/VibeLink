import assert from "node:assert/strict";
import test from "node:test";

import { capabilityCategories, capabilityCenterCopy, automationDraftPayload, capabilityOperationMessage } from "../apps/web/src/capabilityCenterModel.js";

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

test("capability operations localize default validation and approval copy", () => {
  const chinese = capabilityCenterCopy("zh-CN");
  assert.throws(() => automationDraftPayload({ title: "", prompt: "" }, chinese), /请输入自动化标题/);
  assert.deepEqual(capabilityOperationMessage({ status: 428, data: { approvalId: "approval-1" } }, chinese.operationCompleted, chinese), {
    tone: "approval",
    text: "需要显式批准。 批准 approval-1 正在设置 > 批准中等待处理。"
  });
  assert.deepEqual(capabilityOperationMessage({}, chinese.operationCompleted, chinese), { tone: "error", text: "操作失败。" });
});

test("capability center runtime copy follows the selected language", () => {
  const chinese = capabilityCenterCopy("zh-CN");
  const english = capabilityCenterCopy("en-US");
  assert.equal(chinese.heading, "能力中心");
  assert.equal(chinese.category.plugins, "插件");
  assert.equal(chinese.empty(chinese.category.plugins), "暂无插件。");
  assert.equal(english.heading, "Capability center");
  assert.equal(english.category.plugins, "Plugins");
  assert.equal(english.empty(english.category.plugins), "No Plugins found.");
});
