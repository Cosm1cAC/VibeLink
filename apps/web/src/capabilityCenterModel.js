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
