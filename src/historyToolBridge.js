import crypto from "node:crypto";
import { findWorkspaceForPath } from "./db.js";
import { createObservedToolRun, finishObservedToolRun, startObservedToolRun } from "./toolRuntime.js";
import { classifyToolName } from "./toolRegistry.js";

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

function compact(value, max = 200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function firstTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content?.text === "string") return content.text;
  return "";
}

function outputFromPayload(payload = {}) {
  const output = payload.output ?? payload.stdout ?? payload.stderr ?? payload.error ?? payload.result ?? firstTextFromContent(payload.content) ?? "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output || "");
  }
}

function statusOk(payload = {}, output = "") {
  const explicit = payload.exit_code ?? payload.exitCode ?? payload.code;
  if (Number.isFinite(Number(explicit))) return Number(explicit) === 0;
  if (payload.is_error === true || payload.error || payload.success === false || payload.status === "failed") return false;
  if (/Exit code:\s*(-?\d+)\b/i.test(output)) return Number(output.match(/Exit code:\s*(-?\d+)\b/i)?.[1]) === 0;
  return true;
}

function isToolStartType(type = "") {
  return /(?:function_call|custom_tool_call|tool_call|tool_use|server_tool_use|mcp_tool_use)$/i.test(String(type || ""));
}

function isToolResultType(type = "") {
  return /(?:function_call_output|custom_tool_call_output|tool_call_output|tool_result|server_tool_result|mcp_tool_result)$/i.test(String(type || ""));
}

function callIdentity(payload = {}, fallback = "") {
  return payload.call_id || payload.id || payload.tool_use_id || payload.toolUseId || fallback;
}

function historyToolTaskId(provider, sessionId) {
  return `history:${provider}:${sessionId}`;
}

function historyToolRunId(provider, sessionId, callId) {
  return `history-tool:${provider}:${stableHash(sessionId)}:${stableHash(callId)}`;
}

function commandPreview(name, input) {
  return input.command || input.cmd || input.code || input.patch || input.raw || compact(JSON.stringify(input || {}), 160) || name;
}

function entryTimestamp(entry, fallback = "") {
  return entry.timestamp || entry.payload?.timestamp || entry.created_at || entry.at || fallback || new Date().toISOString();
}

function entryId(entry, index) {
  return entry.uuid || entry.id || entry.message?.id || entry.payload?.id || `entry-${index}`;
}

function bridgeStart(context, entry, index, payload, sourceType) {
  const name = payload.name || payload.type || "agent.tool";
  const namespace = payload.namespace || "";
  const input = parseJson(payload.arguments || payload.input || payload.parameters || {});
  const callId = callIdentity(payload, `${entryId(entry, index)}:${name}`);
  if (!callId) return;
  const toolName = namespace ? `${namespace}.${name}` : name;
  const kind = classifyToolName(toolName);
  const toolRunId = historyToolRunId(context.provider, context.sessionId, callId);
  const title = kind === "shell" ? commandPreview(name, input) : name;
  const { run, created } = createObservedToolRun({
    id: toolRunId,
    taskId: context.taskId,
    workspaceId: context.workspaceId,
    toolName,
    title,
    input: {
      ...input,
      kind,
      name,
      namespace,
      callId,
      source: {
        provider: context.provider,
        sessionId: context.sessionId,
        filePath: context.filePath,
        entryId: entryId(entry, index),
        payloadType: payload.type || sourceType || ""
      }
    },
    at: entryTimestamp(entry)
  });
  if (!run) return;
  if (created || !run.startedAt) {
    startObservedToolRun({
      toolRunId,
      input: run.input,
      text: title,
      at: entryTimestamp(entry),
      eventId: `${toolRunId}:started:${entryId(entry, index)}`,
      payload: { callId, name, namespace, kind, sourceEntryId: entryId(entry, index) }
    });
  }
}

function bridgeFinish(context, entry, index, payload, sourceType) {
  const callId = callIdentity(payload, "");
  if (!callId) return false;
  const toolRunId = historyToolRunId(context.provider, context.sessionId, callId);
  const output = outputFromPayload(payload);
  const ok = statusOk(payload, output);
  finishObservedToolRun({
    toolRunId,
    ok,
    result: {
      output,
      stdout: payload.stdout || "",
      stderr: payload.stderr || "",
      exitCode: payload.exit_code ?? payload.exitCode ?? payload.code ?? null,
      raw: payload
    },
    error: ok ? "" : output || payload.error || "Tool failed.",
    text: output || (ok ? "Tool completed." : "Tool failed."),
    at: entryTimestamp(entry),
    eventId: `${toolRunId}:finished:${entryId(entry, index)}`,
    payload: { sourceEntryId: entryId(entry, index), payloadType: payload.type || sourceType || "" }
  });
  return true;
}

function bridgeBlocks(context, entry, index, blocks = [], sourceType = "") {
  for (const block of blocks || []) {
    if (!block || typeof block !== "object") continue;
    if (isToolStartType(block.type || "")) {
      bridgeStart(
        context,
        entry,
        index,
        {
          ...block,
          id: block.id || block.tool_use_id || block.toolUseId,
          input: block.input || block.arguments || {}
        },
        sourceType
      );
    }
    if (isToolResultType(block.type || "")) {
      bridgeFinish(
        context,
        entry,
        index,
        {
          ...block,
          id: block.tool_use_id || block.toolUseId || block.id,
          output: block.content || block.text || block.output || "",
          is_error: block.is_error || block.isError
        },
        sourceType
      );
    }
  }
}

function bridgeEntry(context, entry, index) {
  const payload = entry.payload || {};
  const item = payload.item && typeof payload.item === "object" ? payload.item : null;
  const message = entry.message || payload.message || entry;
  const payloadType = payload.type || item?.type || "";
  const itemType = item?.type || "";

  if (item) bridgeBlocks(context, entry, index, [item], payloadType);
  bridgeBlocks(context, entry, index, payload.content || message.content || entry.content || [], payloadType);

  if (isToolStartType(itemType)) {
    bridgeStart(context, entry, index, item, payloadType);
    return;
  }
  if (isToolResultType(itemType)) {
    bridgeFinish(context, entry, index, item, payloadType);
    return;
  }

  if (isToolStartType(payloadType)) {
    bridgeStart(context, entry, index, payload, payloadType);
    return;
  }

  if (isToolResultType(payloadType)) {
    if (bridgeFinish(context, entry, index, payload, payloadType)) return;
    const inferredCallId = callIdentity(payload, `${payloadType}:${entryId(entry, index)}`);
    bridgeStart(context, entry, index, { ...payload, id: inferredCallId, name: payload.name || payloadType }, payloadType);
    bridgeFinish(context, entry, index, { ...payload, id: inferredCallId }, payloadType);
    return;
  }

  if (/patch_apply_end|mcp_tool_call_end/i.test(payloadType)) {
    if (bridgeFinish(context, entry, index, payload, payloadType)) return;
    const inferredCallId = callIdentity(payload, `${payloadType}:${entryId(entry, index)}`);
    bridgeStart(context, entry, index, { ...payload, id: inferredCallId, name: payloadType, input: payload.input || payload.arguments || {} }, payloadType);
    bridgeFinish(context, entry, index, { ...payload, id: inferredCallId }, payloadType);
  }
}

export function backfillHistoryToolEvents({ provider = "", sessionId = "", filePath = "", projectPath = "", entries = [] } = {}) {
  if (!provider || !sessionId || !Array.isArray(entries) || !entries.length) {
    return { taskId: provider && sessionId ? historyToolTaskId(provider, sessionId) : "", count: 0 };
  }
  const context = {
    provider,
    sessionId,
    filePath,
    taskId: historyToolTaskId(provider, sessionId),
    workspaceId: findWorkspaceForPath(projectPath || "")?.id || ""
  };
  let count = 0;
  entries.forEach((entry, index) => {
    try {
      bridgeEntry(context, entry, index);
      count += 1;
    } catch {
      // A malformed history entry should not break history rendering.
    }
  });
  return { taskId: context.taskId, count };
}

export { historyToolTaskId };
