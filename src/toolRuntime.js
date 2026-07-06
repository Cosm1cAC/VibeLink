import crypto from "node:crypto";
import {
  createApprovalRequest,
  createToolRun,
  getApprovalRequest,
  getToolRun,
  insertToolEvent,
  listToolEvents,
  updateApprovalRequest,
  updateToolRun
} from "./db.js";
import { getToolDefinition } from "./toolRegistry.js";

const toolEventListeners = new Set();

function nowIso() {
  return new Date().toISOString();
}

function addMinutes(minutes) {
  return new Date(Date.now() + Number(minutes || 0) * 60 * 1000).toISOString();
}

function compact(value, max = 200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function lifecycleForToolEvent(type = "") {
  const value = String(type || "").toLowerCase();
  if (value === "tool.created") return "created";
  if (value === "tool.started" || value === "tool.output") return "running";
  if (value === "tool.completed") return "completed";
  if (value === "tool.cancel_requested") return "cancelling";
  if (value === "tool.cancelled") return "cancelled";
  if (value === "tool.failed" || value === "tool.error") return "failed";
  if (value === "approval.required") return "approval_required";
  if (value === "approval.approved") return "approved";
  if (value === "approval.denied") return "rejected";
  if (value === "approval.expired") return "expired";
  if (value.startsWith("approval.")) return "approval";
  if (value.startsWith("tool.")) return "running";
  return "event";
}

export function createWorkspaceCommandToolRun({ workspaceId = "", taskId = "", kind = "terminal", command = "", timeoutMs = 120000, risk = null } = {}) {
  const toolName = kind === "test" ? "workspace.test" : "workspace.command";
  const definition = getToolDefinition(toolName);
  const title = compact(command, 120) || toolName;
  const run = createToolRun({
    taskId,
    workspaceId,
    toolName,
    status: "pending",
    title,
    input: {
      taskId,
      workspaceId,
      kind,
      command,
      timeoutMs,
      risk
    }
  });

  emitToolEvent(run.id, {
    type: "tool.created",
    text: title,
    payload: { toolName, tool: definition, taskId, workspaceId, kind: definition.kind, commandKind: kind, command, timeoutMs, risk }
  });

  return run;
}

export function createWorkspaceActionToolRun({ workspaceId = "", taskId = "", toolName = "workspace.tool", title = "", input = {} } = {}) {
  const definition = getToolDefinition(toolName);
  const run = createToolRun({
    taskId,
    workspaceId,
    toolName,
    status: "pending",
    title: compact(title || toolName, 160),
    input: {
      taskId,
      workspaceId,
      ...input
    }
  });

  emitToolEvent(run.id, {
    type: "tool.created",
    text: run.title,
    payload: { toolName, tool: definition, taskId, workspaceId, kind: definition.kind, input: run.input }
  });

  return run;
}

export function createAgentTaskToolRun({ workspaceId = "", title = "", input = {}, risk = null } = {}) {
  const definition = getToolDefinition("agent.task");
  const run = createToolRun({
    workspaceId,
    toolName: "agent.task",
    status: "pending",
    title: compact(title || input.prompt || "Agent task", 160),
    input: {
      workspaceId,
      ...input,
      risk
    }
  });

  emitToolEvent(run.id, {
    type: "tool.created",
    text: run.title,
    payload: { toolName: "agent.task", tool: definition, workspaceId, kind: definition.kind, input: run.input, risk }
  });

  return run;
}

export function createObservedToolRun({ id = "", taskId = "", workspaceId = "", toolName = "agent.tool", title = "", input = {}, at = "" } = {}) {
  if (!id) return { run: null, created: false };
  const existing = getToolRun(id);
  if (existing) return { run: existing, created: false };
  const definition = getToolDefinition(toolName);

  const run = createToolRun({
    id,
    taskId,
    workspaceId,
    toolName,
    status: "pending",
    title: compact(title || toolName, 160),
    input,
    createdAt: at || nowIso(),
    updatedAt: at || nowIso()
  });

  emitToolEvent(run.id, {
    id: `${run.id}:created`,
    at: at || run.createdAt,
    type: "tool.created",
    text: run.title,
    payload: { toolName, tool: definition, taskId, workspaceId, input, kind: definition.kind || input?.kind || "", source: input?.source || null }
  });

  return { run, created: true };
}

export function startObservedToolRun({ toolRunId = "", input = null, text = "", at = "", eventId = "", payload = {} } = {}) {
  const run = getToolRun(toolRunId);
  if (!run) return null;
  const startedAt = at || nowIso();
  updateToolRun(toolRunId, { status: "running", startedAt });
  return emitToolEvent(toolRunId, {
    id: eventId || `${toolRunId}:started`,
    at: startedAt,
    type: "tool.started",
    text: text || run.title,
    payload: { input: input ?? run.input, ...payload }
  });
}

export function finishObservedToolRun({ toolRunId = "", ok = true, result = null, error = "", text = "", at = "", eventId = "", payload = {} } = {}) {
  const run = getToolRun(toolRunId);
  if (!run) return null;
  const completedAt = at || nowIso();
  updateToolRun(toolRunId, {
    status: ok ? "completed" : "failed",
    result,
    error: ok ? "" : error || text || "Tool failed.",
    completedAt
  });
  return emitToolEvent(toolRunId, {
    id: eventId || `${toolRunId}:completed`,
    at: completedAt,
    type: ok ? "tool.completed" : "tool.failed",
    text: text || (ok ? "Tool completed." : error || "Tool failed."),
    payload: { ok, result, error, ...payload }
  });
}

export function emitToolEvent(toolRunId, event = {}) {
  const run = getToolRun(toolRunId);
  const lifecycle = event.lifecycle || event.payload?.lifecycle || lifecycleForToolEvent(event.type);
  const enriched = {
    id: event.id || crypto.randomUUID(),
    at: event.at || nowIso(),
    ...event,
    lifecycle,
    sourceConfidence: event.sourceConfidence || event.payload?.sourceConfidence || "authoritative",
    toolRunId,
    taskId: event.taskId || run?.taskId || "",
    workspaceId: event.workspaceId || run?.workspaceId || ""
  };
  const cursor = insertToolEvent(toolRunId, enriched);
  if (cursor) enriched.cursor = cursor;
  for (const listener of toolEventListeners) listener(enriched);
  return enriched;
}

export function subscribeToolEvents(response, filter = {}) {
  const after = Number(filter.after || 0);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  const send = (event) => {
    if (response.destroyed || response.writableEnded) return;
    if (filter.toolRunId && event.toolRunId !== filter.toolRunId) return;
    if (filter.workspaceId && event.workspaceId !== filter.workspaceId) return;
    if (filter.taskId && event.taskId !== filter.taskId) return;
    response.write(`id: ${event.cursor || ""}\n`);
    response.write(`event: ${event.type || "tool.event"}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  for (const event of listToolEvents({ ...filter, after })) send(event);

  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(": ping\n\n");
  }, 25000);

  toolEventListeners.add(send);
  response.on("close", () => {
    clearInterval(heartbeat);
    toolEventListeners.delete(send);
  });
  return true;
}

export function requestToolApproval({ toolRunId, workspaceId = "", taskId = "", kind = "tool", title = "", reason = "", request = null, risk = null, ttlMinutes = 30 } = {}) {
  const approval = createApprovalRequest({
    toolRunId,
    workspaceId,
    taskId,
    kind,
    title,
    reason,
    request,
    risk,
    expiresAt: addMinutes(ttlMinutes)
  });

  updateToolRun(toolRunId, { status: "approval_required" });
  emitToolEvent(toolRunId, {
    type: "approval.required",
    text: reason,
    payload: { approvalId: approval.id, kind, title, reason, risk, request }
  });

  return approval;
}

export function approveToolApproval(id, { deviceId = "", reason = "", decision = {} } = {}) {
  const approval = getApprovalRequest(id);
  if (!approval) return null;
  if (approval.status !== "pending") return approval;

  const updated = updateApprovalRequest(id, {
    status: "approved",
    decidedByDeviceId: deviceId,
    decisionReason: reason,
    decision
  });

  if (updated?.toolRunId) {
    updateToolRun(updated.toolRunId, { status: "approved" });
    emitToolEvent(updated.toolRunId, {
      type: "approval.approved",
      text: reason || "Approval granted.",
      payload: { approvalId: updated.id, deviceId, decision }
    });
  }

  return updated;
}

export function denyToolApproval(id, { deviceId = "", reason = "", decision = {} } = {}) {
  const approval = getApprovalRequest(id);
  if (!approval) return null;
  if (approval.status !== "pending") return approval;

  const updated = updateApprovalRequest(id, {
    status: "denied",
    decidedByDeviceId: deviceId,
    decisionReason: reason || "Denied by user.",
    decision
  });

  if (updated?.toolRunId) {
    updateToolRun(updated.toolRunId, {
      status: "rejected",
      error: reason || "Approval denied.",
      completedAt: nowIso()
    });
    emitToolEvent(updated.toolRunId, {
      type: "approval.denied",
      text: reason || "Approval denied.",
      payload: { approvalId: updated.id, deviceId, decision }
    });
  }

  return updated;
}

export function expireToolApproval(id, { reason = "Approval request expired." } = {}) {
  const approval = getApprovalRequest(id);
  if (!approval) return null;
  if (approval.status !== "pending" && approval.status !== "expired") return approval;

  const updated = approval.status === "expired"
    ? approval
    : updateApprovalRequest(id, {
        status: "expired",
        decisionReason: reason,
        decision: { source: "runtime", reason }
      });

  if (updated?.toolRunId) {
    const run = getToolRun(updated.toolRunId);
    if (run && !["completed", "failed", "rejected", "expired"].includes(run.status || "")) {
      updateToolRun(updated.toolRunId, {
        status: "expired",
        error: reason,
        completedAt: nowIso()
      });
      emitToolEvent(updated.toolRunId, {
        type: "approval.expired",
        text: reason,
        payload: { approvalId: updated.id, reason }
      });
    }
  }

  return updated;
}

export async function runApprovedWorkspaceCommand({ toolRunId, execute }) {
  return runWorkspaceToolAction({
    toolRunId,
    execute,
    startedText: (input, run) => input.command || run.title,
    completedText: "Command completed.",
    failedText: "Command failed."
  });
}

export async function runWorkspaceToolAction({ toolRunId, execute, startedText = "", completedText = "Tool completed.", failedText = "Tool failed." }) {
  const run = getToolRun(toolRunId);
  if (!run) {
    const error = new Error("Tool run not found.");
    error.status = 404;
    throw error;
  }

  const input = run.input || {};
  updateToolRun(toolRunId, { status: "running", startedAt: nowIso() });
  emitToolEvent(toolRunId, {
    type: "tool.started",
    text: typeof startedText === "function" ? startedText(input, run) : startedText || run.title,
    payload: { input }
  });

  try {
    const result = await execute(input);
    const completedAt = nowIso();
    const cancelled = Boolean(result?.cancelled || result?.stopped);
    const ok = Boolean(result?.ok);
    const status = cancelled ? "cancelled" : ok ? "completed" : "failed";
    const eventType = cancelled ? "tool.cancelled" : ok ? "tool.completed" : "tool.failed";
    const errorText = result?.stderr || result?.stdout || (cancelled ? "Tool stopped." : "Command failed.");
    updateToolRun(toolRunId, {
      status,
      result,
      error: ok ? "" : errorText,
      completedAt
    });
    emitToolEvent(toolRunId, {
      type: eventType,
      text: ok ? completedText : cancelled ? errorText : result?.stderr || result?.stdout || failedText,
      payload: {
        exitCode: result?.exitCode ?? 0,
        ok,
        cancelled,
        timedOut: Boolean(result?.timedOut),
        stdout: result?.stdout || "",
        stderr: result?.stderr || "",
        result
      }
    });
    return result;
  } catch (error) {
    const completedAt = nowIso();
    updateToolRun(toolRunId, {
      status: "failed",
      error: error.message,
      completedAt
    });
    emitToolEvent(toolRunId, {
      type: "tool.error",
      text: error.message,
      payload: { error: error.message }
    });
    throw error;
  }
}
