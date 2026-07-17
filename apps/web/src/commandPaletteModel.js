function cleanText(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return cleanText(value).toLowerCase();
}

export function commandSearchText(command = {}) {
  return [
    command.id,
    command.name,
    command.description,
    command.usage,
    command.toolKind,
    command.permission,
    command.ui?.label,
    command.ui?.detail
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function commandQueryFromText(text = "") {
  const trimmed = cleanText(text);
  if (!trimmed.startsWith("/")) return "";
  const withoutSlash = trimmed.replace(/^\/+/, "").trim();
  if (!withoutSlash) return "";
  return withoutSlash.split(/\s+/)[0] || "";
}

export function commandArgumentDraft(text = "") {
  const trimmed = cleanText(text);
  if (!trimmed.startsWith("/")) return "";
  const withoutSlash = trimmed.replace(/^\/+/, "").trim();
  const firstSpace = withoutSlash.search(/\s/);
  return firstSpace >= 0 ? withoutSlash.slice(firstSpace).trim() : "";
}

export function requiredCommandArgs(command = {}) {
  return (command.args || []).filter((arg) => arg?.required);
}

export function commandNeedsArguments(command = {}) {
  return requiredCommandArgs(command).length > 0;
}

export function normalizeCommandCandidate(command = {}) {
  const requiredArgs = requiredCommandArgs(command);
  return {
    ...command,
    id: command.id || command.name || command.usage || "",
    label: command.ui?.label || command.name || command.usage || command.id || "Command",
    detail: command.ui?.detail || command.description || command.usage || "",
    insertText: commandInsertText(command),
    requiredArgs,
    needsArguments: requiredArgs.length > 0,
    requiresApproval: Boolean(command.requiresApproval || command.permission === "ask")
  };
}

export function filterCommandCandidates(commands = [], query = "") {
  const needle = lower(query).replace(/^\/+/, "");
  const items = commands.map(normalizeCommandCandidate);
  if (!needle) return items;
  return items.filter((command) => commandSearchText(command).includes(needle));
}

export function commandInsertText(command = {}) {
  const usage = cleanText(command.usage);
  if (usage) return usage.includes("<") ? `${usage.split(/\s+</)[0]} ` : `${usage} `;
  const name = cleanText(command.name || command.id);
  if (!name) return "";
  return name.startsWith("/") ? `${name} ` : `/${name} `;
}

export function paletteCommandDisabledReason(command = {}, context = {}) {
  const action = command.action || {};
  if (action.type === "thread-patch" && action.patch === "favorite" && !context.selected?.key) {
    return "Select a session first";
  }
  if (action.type === "workspace-command" && !context.workspace?.id) {
    return "No workspace available";
  }
  return "";
}

export function paletteCommandArgumentHint(command = {}) {
  const requiredArgs = requiredCommandArgs(command);
  if (!requiredArgs.length) return "";
  return requiredArgs.map((arg) => arg.hint || `<${arg.name}>`).join(" ");
}

export function resolvePaletteCommandPlan(command = {}, context = {}, inputText = "") {
  const normalized = normalizeCommandCandidate(command);
  const disabledReason = paletteCommandDisabledReason(normalized, context);
  if (disabledReason) return { kind: "disabled", command: normalized, reason: disabledReason };

  const action = normalized.action || {};
  const draft = commandArgumentDraft(inputText);
  if (action.type === "search" && !draft) {
    return { kind: "needs-argument", command: normalized, argName: "query", hint: paletteCommandArgumentHint(normalized) || "Search query" };
  }
  if (action.type === "workspace-command" && !draft) {
    return { kind: "needs-argument", command: normalized, argName: "command", hint: paletteCommandArgumentHint(normalized) || "Workspace command" };
  }
  if (!action.type && !normalized.name?.startsWith("/")) {
    return { kind: "insert", command: normalized, text: normalized.insertText };
  }
  return { kind: "execute", command: normalized, args: draft ? { text: draft } : {} };
}
