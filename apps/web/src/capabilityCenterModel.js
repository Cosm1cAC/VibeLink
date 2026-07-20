export const capabilityCategories = [
  { id: "plugins", label: "Plugins" },
  { id: "hooks", label: "Hooks" },
  { id: "automations", label: "Automations" },
  { id: "subagents", label: "Subagents" },
  { id: "config", label: "AGENTS / config" }
];

export function automationDraftPayload(draft = {}) {
  const title = String(draft.title || "").trim();
  const prompt = String(draft.prompt || "").trim();
  if (!title) throw new Error("Automation title is required.");
  if (!prompt) throw new Error("Automation prompt is required.");
  return { title, enabled: true, schedule: { type: draft.type || "interval", value: String(draft.value || "3600000") }, payload: { prompt } };
}

export function capabilityOperationMessage(error, successText = "Operation completed.") {
  if (!error) return { tone: "success", text: successText };
  if (error.status === 428) {
    const id = error.data?.approvalId || error.data?.approval?.id || "";
    const reason = error.data?.error || error.message || "Explicit approval required.";
    return { tone: "approval", text: `${reason}${id ? ` Approval ${id} is pending in Settings > Approvals.` : " Open Settings > Approvals."}` };
  }
  return { tone: "error", text: error.message || "Operation failed." };
}
