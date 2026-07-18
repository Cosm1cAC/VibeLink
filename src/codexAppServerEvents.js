const PROVIDER = "codex";
const PROTOCOL = "codex-app-server";
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageGeneration"
]);

function protocolError(message, details = {}) {
  const error = new Error(message);
  error.code = "CODEX_APP_SERVER_MESSAGE_INVALID";
  Object.assign(error, details);
  return error;
}

function objectValue(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError(`${field} must be an object.`, { field });
  }
  return value;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value) {
    throw protocolError(`${field} must be a non-empty string.`, { field });
  }
  return value;
}

function timestamp(value, unit, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const date = new Date(unit === "seconds" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function baseEvent(type, { threadId = null, turnId = null, itemId = null, at, payload = {} }) {
  return {
    type,
    provider: PROVIDER,
    protocol: PROTOCOL,
    threadId,
    turnId,
    itemId,
    at,
    payload
  };
}

function itemStatus(item) {
  return typeof item.status === "string" ? item.status : null;
}

function toolIdentity(item) {
  switch (item.type) {
    case "commandExecution":
      return { kind: item.type, name: item.command || "command" };
    case "fileChange":
      return { kind: item.type, name: "apply_patch" };
    case "mcpToolCall":
      return { kind: item.type, name: item.tool || "", namespace: item.server || null };
    case "dynamicToolCall":
      return { kind: item.type, name: item.tool || "", namespace: item.namespace || null };
    case "collabAgentToolCall":
      return { kind: item.type, name: item.tool || "collaboration" };
    case "webSearch":
      return { kind: item.type, name: "web_search" };
    case "imageGeneration":
      return { kind: item.type, name: "image_generation" };
    default:
      return null;
  }
}

function normalizeItemLifecycle(method, params, receivedAt) {
  const item = objectValue(params.item, "params.item");
  const threadId = requiredString(params.threadId, "params.threadId");
  const turnId = requiredString(params.turnId, "params.turnId");
  const itemId = requiredString(item.id, "params.item.id");
  const completed = method === "item/completed";
  const at = timestamp(params[completed ? "completedAtMs" : "startedAtMs"], "milliseconds", receivedAt);
  const phase = completed ? "completed" : "started";
  const common = { threadId, turnId, itemId, at };
  const events = [baseEvent(`provider.item.${phase}`, {
    ...common,
    payload: { itemType: requiredString(item.type, "params.item.type"), status: itemStatus(item), item }
  })];
  const tool = TOOL_ITEM_TYPES.has(item.type) ? toolIdentity(item) : null;
  if (tool) {
    events.push(baseEvent(`provider.tool.${phase}`, {
      ...common,
      payload: { ...tool, status: itemStatus(item), item }
    }));
  }
  return events;
}

function normalizeOutput(method, params, receivedAt) {
  const threadId = requiredString(params.threadId, "params.threadId");
  const turnId = requiredString(params.turnId, "params.turnId");
  const itemId = requiredString(params.itemId, "params.itemId");
  const progress = method === "item/mcpToolCall/progress";
  const delta = progress ? params.message : params.delta;
  if (typeof delta !== "string") throw protocolError("Output delta must be a string.", { method });
  const channel = method === "item/agentMessage/delta" ? "assistant" : "tool";
  return [baseEvent("provider.output.delta", {
    threadId,
    turnId,
    itemId,
    at: receivedAt,
    payload: { channel, delta, progress, sourceMethod: method }
  })];
}

function approvalKind(method) {
  if (method === "item/commandExecution/requestApproval") return "commandExecution";
  if (method === "item/fileChange/requestApproval") return "fileChange";
  return "permissions";
}

function normalizeApproval(message, params, receivedAt) {
  if (!(typeof message.id === "string" || typeof message.id === "number")) {
    throw protocolError("Approval request id must be a string or number.", { method: message.method });
  }
  const threadId = requiredString(params.threadId, "params.threadId");
  const turnId = requiredString(params.turnId, "params.turnId");
  const itemId = requiredString(params.itemId, "params.itemId");
  const requestId = message.id;
  return [baseEvent("provider.approval.required", {
    threadId,
    turnId,
    itemId,
    at: timestamp(params.startedAtMs, "milliseconds", receivedAt),
    payload: {
      kind: approvalKind(message.method),
      requestId,
      requestIdType: typeof requestId,
      connectionScoped: true,
      approvalId: params.approvalId ?? null,
      reason: params.reason ?? null,
      availableDecisions: params.availableDecisions ?? null,
      requestedPermissions: params.permissions ?? params.additionalPermissions ?? null,
      request: params
    }
  })];
}

export function normalizeCodexAppServerMessage(rawMessage, { receivedAt = new Date().toISOString() } = {}) {
  let message = rawMessage;
  if (typeof rawMessage === "string") {
    try {
      message = JSON.parse(rawMessage);
    } catch (error) {
      throw protocolError(`Invalid JSON-RPC JSON: ${error.message}`);
    }
  }
  objectValue(message, "message");

  if (typeof message.method !== "string") return [];
  const params = objectValue(message.params, "message.params");

  if (message.method === "thread/started") {
    const thread = objectValue(params.thread, "params.thread");
    const threadId = requiredString(thread.id, "params.thread.id");
    return [baseEvent("provider.thread.started", {
      threadId,
      at: timestamp(thread.createdAt, "seconds", receivedAt),
      payload: { thread }
    })];
  }

  if (message.method === "turn/started" || message.method === "turn/completed") {
    const threadId = requiredString(params.threadId, "params.threadId");
    const turn = objectValue(params.turn, "params.turn");
    const turnId = requiredString(turn.id, "params.turn.id");
    const completed = message.method === "turn/completed";
    return [baseEvent(`provider.turn.${completed ? "completed" : "started"}`, {
      threadId,
      turnId,
      at: timestamp(turn[completed ? "completedAt" : "startedAt"], "seconds", receivedAt),
      payload: { status: turn.status ?? null, error: turn.error ?? null, turn }
    })];
  }

  if (message.method === "item/started" || message.method === "item/completed") {
    return normalizeItemLifecycle(message.method, params, receivedAt);
  }

  if ([
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/mcpToolCall/progress"
  ].includes(message.method)) {
    return normalizeOutput(message.method, params, receivedAt);
  }

  if ([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval"
  ].includes(message.method)) {
    return normalizeApproval(message, params, receivedAt);
  }

  return [];
}
