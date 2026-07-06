import crypto from "node:crypto";
import { findWorkspaceForPath } from "./db.js";
import { createObservedToolRun, finishObservedToolRun, startObservedToolRun } from "./toolRuntime.js";
import { classifyToolName } from "./toolRegistry.js";

const TASK_TOOL_RUN_PREFIX = "agent-stream";

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

function outputFromPayload(payload = {}) {
  const output = payload.output ?? payload.stdout ?? payload.stderr ?? payload.error ?? payload.result ?? payload.content ?? "";
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

function toolRunId(taskId, callId) {
  return `${TASK_TOOL_RUN_PREFIX}:${taskId}:${stableHash(callId)}`;
}

function callIdentity(payload = {}, fallback = "") {
  return payload.call_id || payload.id || payload.tool_use_id || payload.toolUseId || fallback;
}

function isToolStartType(type = "") {
  return /(?:function_call|custom_tool_call|tool_call|tool_use|server_tool_use|mcp_tool_use)$/i.test(String(type || ""));
}

function isToolResultType(type = "") {
  return /(?:function_call_output|custom_tool_call_output|tool_call_output|tool_result|server_tool_result|mcp_tool_result)$/i.test(String(type || ""));
}

function commandPreview(name, input) {
  return input.command || input.cmd || input.code || input.patch || input.raw || compact(JSON.stringify(input || {}), 160) || name;
}

function ensureWorkspace(task) {
  return task.workspaceId || findWorkspaceForPath(task.cwd || "")?.id || "";
}

function createOrStartCall(task, event, payload, sourceType) {
  const name = payload.name || payload.type || "agent.tool";
  const namespace = payload.namespace || "";
  const input = parseJson(payload.arguments || payload.input || payload.parameters || {});
  const callId = callIdentity(payload, `${event.id}:${name}`);
  if (!callId) return;

  const toolName = namespace ? `${namespace}.${name}` : name;
  const kind = classifyToolName(toolName);
  const id = toolRunId(task.id, callId);
  const title = kind === "shell" ? commandPreview(name, input) : name;
  const workspaceId = ensureWorkspace(task);
  const { run, created } = createObservedToolRun({
    id,
    taskId: task.id,
    workspaceId,
    toolName,
    title,
    input: {
      ...input,
      kind,
      name,
      namespace,
      callId,
      source: { taskEventId: event.id, payloadType: payload.type || sourceType || "" }
    },
    at: event.at
  });

  if (!run) return;
  if (created || !run.startedAt) {
    startObservedToolRun({
      toolRunId: id,
      input: run.input,
      text: title,
      at: event.at,
      eventId: `${id}:started:${event.id}`,
      payload: { callId, name, namespace, kind, sourceTaskEventId: event.id }
    });
  }
}

function finishCall(task, event, payload, sourceType) {
  const callId = callIdentity(payload, "");
  if (!callId) return false;
  const id = toolRunId(task.id, callId);
  const output = outputFromPayload(payload);
  const ok = statusOk(payload, output);
  const result = {
    output,
    stdout: payload.stdout || "",
    stderr: payload.stderr || "",
    exitCode: payload.exit_code ?? payload.exitCode ?? payload.code ?? null,
    raw: payload
  };
  finishObservedToolRun({
    toolRunId: id,
    ok,
    result,
    error: ok ? "" : output || payload.error || "Tool failed.",
    text: output || (ok ? "Tool completed." : "Tool failed."),
    at: event.at,
    eventId: `${id}:finished:${event.id}`,
    payload: { sourceTaskEventId: event.id, payloadType: payload.type || sourceType || "" }
  });
  return true;
}

function bridgeContentBlocks(task, event, payload, blocks = []) {
  for (const block of blocks) {
    if (isToolStartType(block?.type || "")) {
      createOrStartCall(
        task,
        event,
        {
          ...block,
          type: "tool_use",
          id: block.id || block.tool_use_id || block.toolUseId,
          input: block.input || block.arguments || {}
        },
        payload.type
      );
    }

    if (isToolResultType(block?.type || "")) {
      finishCall(
        task,
        event,
        {
          ...block,
          type: "tool_result",
          id: block.tool_use_id || block.toolUseId || block.id,
          output: block.content || block.text || block.output || "",
          is_error: block.is_error || block.isError
        },
        payload.type
      );
    }
  }
}

export function bridgeAgentToolEvent(task, event) {
  if (!task?.id || event?.type !== "json") return;
  const payload = event.payload || {};
  const payloadType = payload.type || payload.item?.type || "";
  const item = payload.item && typeof payload.item === "object" ? payload.item : null;
  const itemType = item?.type || "";

  if (isToolStartType(itemType) || isToolResultType(itemType)) {
    bridgeContentBlocks(task, event, payload, [item]);
  }

  if (isToolStartType(itemType)) {
    createOrStartCall(task, event, item, payloadType);
    return;
  }

  if (isToolResultType(itemType)) {
    finishCall(task, event, item, payloadType);
    return;
  }

  if (payload.type === "message" || payload.message?.content || payload.content) {
    bridgeContentBlocks(task, event, payload, payload.content || payload.message?.content || []);
  }

  if (isToolStartType(payloadType)) {
    createOrStartCall(task, event, payload, payloadType);
    return;
  }

  if (isToolResultType(payloadType)) {
    if (finishCall(task, event, payload, payloadType)) return;
    const inferredCallId = callIdentity(payload, `${payloadType}:${event.id}`);
    createOrStartCall(task, event, { ...payload, id: inferredCallId, name: payload.name || payloadType }, payloadType);
    finishCall(task, event, { ...payload, id: inferredCallId }, payloadType);
    return;
  }

  if (/patch_apply_end|mcp_tool_call_end/i.test(payloadType)) {
    if (finishCall(task, event, payload, payloadType)) return;

    const inferredCallId = callIdentity(payload, `${payloadType}:${event.id}`);
    createOrStartCall(
      task,
      event,
      {
        ...payload,
        id: inferredCallId,
        name: payloadType,
        input: payload.input || payload.arguments || {}
      },
      payloadType
    );
    finishCall(task, event, { ...payload, id: inferredCallId }, payloadType);
  }
}
