import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import QRCode from "qrcode";
import { agentReachInstallInfo, getAgentReachStatus, runAgentReachCommand, withAgentReachPath } from "./agentReachRuntime.js";
import { codebaseMemoryInstallInfo } from "./codebaseMemoryRuntime.js";
import { getDoubaoStatus, runDoubaoCommand } from "./doubaoRuntime.js";
import { attachmentsDir, getNetworkAddresses, publicDir } from "./config.js";
import {
  attachToolRunToTask,
  approvePairingSession,
  claimPairingSession,
  createPairingSession,
  denyPairingSession,
  getDbPath,
  getApprovalRequest,
  getCachedMcpTools,
  getPairingSession,
  getToolRun,
  findWorkspaceForPath,
  listApprovalRequests,
  listAuditLogs,
  listDesktopObservations,
  listDevices,
  listPairingSessions,
  listTaskEvents,
  listToolEvents,
  listToolRuns,
  getToolEventStats,
  pruneToolEvents,
  recordAuditLog,
  revokeDevice,
  revokePushSubscription,
  rotateDeviceToken,
  updateToolRun,
  upsertPushSubscription
} from "./db.js";
import { appendExternalTaskEvent, createTask, getTask, getTasks, restoreTasks, setTaskNotificationHandler, stopTask, subscribeTask, writeTaskInput } from "./agents.js";
import { runCodexAppServerProbe } from "./codexAppServerProbe.js";
import { browserFetchRisk, fetchBrowserPage } from "./browserRuntime.js";
import { getCodexDesktopStatus, probeCodexDesktopDraft, sendToCodexDesktop } from "./codexDesktopControl.js";
import { commandApprovalRequired } from "./commandSafety.js";
import { subscribeDesktopObserver } from "./desktopObserver.js";
import { clearDesktopRemoteQueue, enqueueDesktopRemoteMessage, focusDesktopRemoteConversation, getDesktopRemoteState, retryDesktopRemoteQueue, setDesktopRemoteNotificationHandler } from "./desktopRemote.js";
import { filterArchivedCodexTasks, getHistory, listHistories } from "./history.js";
import {
  createLiveCallSession,
  getLiveCallSession,
  listLiveCallEvents,
  listLiveCallSessions,
  pauseLiveCallSession,
  recordLiveCallAnswer,
  recordLiveCallLevel,
  recordLiveCallTranscript,
  resumeLiveCallSession,
  restoreLiveCallSessions,
  setLiveCallQuestionHook,
  stopLiveCallSession,
  subscribeLiveCallEvents
} from "./liveCall.js";
import { getLiveCallAsrCheckpoints, listAsrProviders, recoverLiveCallAsrFromCheckpoints } from "./liveCallAsr.js";
import { listUnifiedEvents } from "./db.js";
import { getCommands, getCommand, refreshSkills } from "./commandRegistry.js";
import { dispatchLiveCallQuestion, stopLiveCallAgentTask } from "./liveCallAgent.js";
import {
  authenticateRequest,
  checkRateLimit,
  cleanHost,
  cloudflareGuide,
  ensureDefaultWorkspaces,
  isHostAllowed,
  isPublicHost,
  pairDevice,
  publicAccessWarnings,
  rateLimitKey,
  requestIp,
  requestUserAgent,
  resolveAllowedPath
} from "./security.js";
import { ensureNotificationSettings, sendCriticalNotification } from "./notifications.js";
import { buildProviderRegistry } from "./providerRegistry.js";
import { loadSettings, mergeMcpSettings, publicSettings, sanitizeSettingsPatch, saveSettings, settingsWithSecrets } from "./store.js";
import { writeApiKeys } from "./credentialStore.js";
import { getTerminalSession, listTerminalSessions, resizeTerminalSession, startTerminalSession, stopTerminalSession, terminalCapabilityReport, writeTerminalSession } from "./terminalRuntime.js";
import { createThreadFork, getThreadState, updateThreadState } from "./threadState.js";
import { applyWorkspaceGitAction, applyWorkspaceGitFileAction, createPermanentWorktree, createWorkspace, getTaskChanges, getWorkspaceContext, getWorkspaceFile, getWorkspaceGitDiff, getWorkspaceGitStatus, getWorkspaces, getWorkspaceTree, openWorkspaceInExplorer, resolveWorkspacePath, runWorkspaceCommand } from "./workspaces.js";
import { callMcpTool, mcpStatus, probeMcpServers } from "./mcpRuntime.js";
import { mcpCallApprovalRisk } from "./mcpCallRisk.js";
import {
  approveToolApproval,
  createAgentTaskToolRun,
  createWorkspaceActionToolRun,
  createWorkspaceCommandToolRun,
  denyToolApproval,
  expireToolApproval,
  emitToolEvent,
  requestToolApproval,
  runApprovedWorkspaceCommand,
  runWorkspaceToolAction,
  subscribeToolEvents
} from "./toolRuntime.js";
import { listToolRegistry } from "./toolRegistry.js";
import { validate, CommandInputSchema, TaskInputSchema, SettingsPatchSchema, BrowserFetchSchema, AgentReachStatusSchema, AgentReachSkillSchema, AgentReachFormatSchema, AgentReachTranscribeSchema, DoubaoStatusSchema, DoubaoAskSchema, DoubaoConfigureSchema } from "./validation.js";

let settings = ensureNotificationSettings(await loadSettings());
await saveSettings(settings);
ensureDefaultWorkspaces(settings);
restoreTasks();
const restoredLiveCallSessions = restoreLiveCallSessions();
for (const sessionId of restoredLiveCallSessions) {
  setLiveCallQuestionHook(sessionId, (question, sess) => {
    dispatchLiveCallQuestion({
      sessionId: sess.id,
      question,
      history: collectLiveCallHistory(sess),
      settings
    }).catch((error) => console.error("[liveCallAgent] dispatch failed:", error.message));
  });
}
if (restoredLiveCallSessions.length) {
  console.log(`[liveCall] restored ${restoredLiveCallSessions.length} active sessions from SQLite`);
}
setTaskNotificationHandler((payload) => {
  sendCriticalNotification(settings, payload).catch((error) => {
    recordAuditLog({ type: "notification.error", success: false, reason: error.message, meta: payload });
  });
});
setDesktopRemoteNotificationHandler((payload) => {
  sendCriticalNotification(settings, payload).catch((error) => {
    recordAuditLog({ type: "notification.error", success: false, reason: error.message, meta: payload });
  });
});

let toolEventsPruneTimer = null;
let toolEventsPruneState = {
  lastRunAt: "",
  nextRunAt: "",
  result: null,
  error: ""
};
const activeWorkspaceCommands = new Map();

function mirrorWorkspaceCommandTaskEvent(toolRunId, type, text, payload = {}, eventId = "", source = "workspace.command") {
  const run = getToolRun(toolRunId);
  const taskId = run?.taskId || run?.input?.taskId || "";
  if (!taskId) return null;
  return appendExternalTaskEvent(taskId, {
    id: `workspace-command:${toolRunId}:${eventId || crypto.randomUUID()}`,
    type,
    text,
    payload: {
      source,
      toolRunId,
      ...payload
    }
  });
}

const runtimeLogDir = path.join(attachmentsDir, "..", "logs");
const crashLogPath = path.join(runtimeLogDir, "server-crash.log");

function appendRuntimeLog(label, error) {
  try {
    fs.mkdirSync(runtimeLogDir, { recursive: true });
    const text = error?.stack || error?.message || String(error || "");
    fs.appendFileSync(crashLogPath, `[${new Date().toISOString()}] ${label}\n${text}\n\n`, "utf8");
  } catch {
    // Logging must never bring down the bridge.
  }
}

process.on("uncaughtException", (error) => {
  appendRuntimeLog("uncaughtException", error);
  console.error(error?.stack || error?.message || error);
});

process.on("unhandledRejection", (error) => {
  appendRuntimeLog("unhandledRejection", error);
  console.error(error?.stack || error?.message || error);
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".zip": "application/zip"
};

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"]);
const servableFileExtensions = new Set([
  ...imageExtensions,
  ".pdf",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".ps1",
  ".sh",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip"
]);
const uploadMimeToExt = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
  ["text/markdown", ".md"],
  ["text/csv", ".csv"],
  ["application/json", ".json"],
  ["application/zip", ".zip"]
]);

function sendJson(response, status, value) {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  if (response.headersSent || response.writableEnded || response.destroyed) {
    console.error(message);
    return;
  }
  sendJson(response, status, { error: message });
}

/**
 * Pick a subset of fields from an object based on a comma-separated list.
 * Supports dot-notation for nested fields: "id,events.type,events.status"
 */
function pickFields(obj, fieldsStr) {
  if (!fieldsStr || typeof obj !== "object" || obj === null) return obj;
  const fields = fieldsStr.split(",").map((f) => f.trim()).filter(Boolean);
  if (!fields.length) return obj;
  const result = {};
  for (const field of fields) {
    const parts = field.split(".");
    let val = obj;
    for (const part of parts) {
      if (val == null || typeof val !== "object") { val = undefined; break; }
      val = val[part];
    }
    if (val !== undefined) {
      // Build nested structure: "events.status" -> { events: { status } }
      let target = result;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!target[parts[i]] || typeof target[parts[i]] !== "object") target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = val;
    }
  }
  return result;
}

/**
 * Apply ?fields= query parameter filtering to an array of items.
 * If fields is not specified, returns items as-is.
 */
function applyFields(items, url) {
  const fields = url.searchParams.get("fields");
  if (!fields || !Array.isArray(items)) return items;
  return items.map((item) => pickFields(item, fields));
}

function conversationTasks() {
  return filterArchivedCodexTasks(getTasks());
}

/**
 * Check if a request has ?dryRun=1 or ?dryRun=true.
 */
function isDryRun(url) {
  const v = url.searchParams.get("dryRun");
  return v === "1" || v === "true";
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

async function readRawBody(request, limitBytes = 15 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) {
      const error = new Error("Upload is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function auditContext(request, url, auth = null) {
  return {
    deviceId: auth?.device?.id || "",
    ip: requestIp(request),
    userAgent: requestUserAgent(request),
    method: request.method || "",
    path: url?.pathname || request.url || ""
  };
}

function audit(request, url, auth, event) {
  return recordAuditLog({
    ...auditContext(request, url, auth),
    ...event
  });
}

function enforceRateLimit(request, response, url, scope, options = {}, auth = null, extra = "") {
  const result = checkRateLimit(rateLimitKey(request, scope, extra), options);
  // Always set rate limit headers
  response.setHeader("X-RateLimit-Limit", String(result.limit));
  response.setHeader("X-RateLimit-Remaining", String(Math.max(0, result.limit - result.count)));
  response.setHeader("X-RateLimit-Reset", String(new Date(result.resetAt).getTime()));
  if (result.ok) return true;
  response.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)),
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify({ error: "Rate limit exceeded.", retryAfterMs: result.retryAfterMs }));
  audit(request, url, auth, {
    type: "rate_limit",
    success: false,
    reason: scope,
    meta: result
  });
  return false;
}

function authForRequest(request, url) {
  return authenticateRequest(request, url, settings);
}

function publicUrlFor(request, pathValue) {
  const host = request.headers.host || `localhost:${settings.port}`;
  const proto = request.headers["x-forwarded-proto"] || (cleanHost(host).endsWith(".trycloudflare.com") ? "https" : "http");
  return `${proto}://${host}${pathValue}`;
}

function isLoopbackIp(value) {
  const ip = String(value || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

function toolEventsRetention(settingsValue = settings) {
  const config = settingsValue.toolEvents || {};
  const retentionDays = Math.min(3650, Math.max(1, Number(config.retentionDays || 30)));
  const keepLatest = Math.min(500000, Math.max(0, Number(config.keepLatest ?? 5000)));
  const autoPruneIntervalMinutes = Math.min(10080, Math.max(15, Number(config.autoPruneIntervalMinutes || 360)));
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return {
    retentionDays,
    keepLatest,
    autoPrune: config.autoPrune !== false,
    autoPruneIntervalMinutes,
    cutoff
  };
}

function toolEventStatsPayload() {
  return {
    ...getToolEventStats(),
    retention: toolEventsRetention(settings),
    autoPrune: toolEventsPruneState
  };
}

function runToolEventsPrune({ dryRun = true } = {}) {
  const retention = toolEventsRetention(settings);
  return pruneToolEvents({
    before: retention.cutoff,
    keepLatest: retention.keepLatest,
    dryRun
  });
}

function collectLiveCallHistory(session, limit = 6) {
  if (!session?.events) return [];
  const transcripts = session.events
    .filter((event) => event.type === "live_call.transcript.final" || event.type === "live_call.transcript.partial")
    .map((event) => ({
      speaker: event.speaker || "remote",
      text: event.text || "",
      at: event.at,
      final: event.type === "live_call.transcript.final"
    }))
    .filter((entry) => entry.text);
  if (transcripts.length <= limit) return transcripts;
  return transcripts.slice(transcripts.length - limit);
}

function scheduleToolEventsPrune() {
  if (toolEventsPruneTimer) {
    clearInterval(toolEventsPruneTimer);
    toolEventsPruneTimer = null;
  }
  const retention = toolEventsRetention(settings);
  const intervalMs = retention.autoPruneIntervalMinutes * 60 * 1000;
  toolEventsPruneState = {
    ...toolEventsPruneState,
    nextRunAt: retention.autoPrune ? new Date(Date.now() + intervalMs).toISOString() : "",
    error: ""
  };
  if (!retention.autoPrune) return;

  const run = () => {
    try {
      const result = runToolEventsPrune({ dryRun: false });
      toolEventsPruneState = {
        lastRunAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
        result,
        error: ""
      };
      if (result.deleted > 0) {
        recordAuditLog({
          type: "tool_events.auto_prune",
          success: true,
          target: result.cutoff,
          meta: { keepLatest: result.keepLatest, deleted: result.deleted, prunable: result.prunable }
        });
      }
    } catch (error) {
      toolEventsPruneState = {
        ...toolEventsPruneState,
        lastRunAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
        error: error.message
      };
      recordAuditLog({ type: "tool_events.auto_prune", success: false, reason: error.message });
    }
  };

  toolEventsPruneTimer = setInterval(run, intervalMs);
  toolEventsPruneTimer.unref?.();
}

function taskSecurityPolicy(body = {}) {
  return {
    ...(settings.security || {}),
    ...(body.security || {})
  };
}

function normalizedPath(value = "") {
  return path.resolve(String(value || "")).toLowerCase();
}

function isTrustedWorkspace(cwd, policy = {}) {
  if (!policy.requireTrustedWorkspace) return true;
  const target = normalizedPath(cwd || settings.defaultCwd || process.cwd());
  const trusted = Array.isArray(policy.trustedWorkspaces) ? policy.trustedWorkspaces : [];
  return trusted.some((item) => {
    const root = normalizedPath(item);
    return root && (target === root || target.startsWith(`${root}${path.sep}`));
  });
}

function taskRiskReasons(body = {}, policy = {}) {
  const reasons = [];
  if (policy.sandboxMode === "danger-full-access") reasons.push("danger-full-access sandbox");
  if (policy.approvalPolicy === "never") reasons.push("approval policy never");
  if (policy.networkAccess) reasons.push("network access enabled");
  if (!isTrustedWorkspace(body.cwd || settings.defaultCwd || process.cwd(), policy)) reasons.push("workspace is not trusted");
  return reasons;
}

function taskApprovalRequired(body = {}, policy = {}) {
  if (!policy.requireDangerousCommandApproval) return false;
  return taskRiskReasons(body, policy).length > 0;
}

function workspaceCommandApprovalRisk(command = "", workspacePath = "", policy = {}) {
  const risk = commandApprovalRequired(command, policy);
  const trusted = isTrustedWorkspace(workspacePath || settings.defaultCwd || process.cwd(), policy);
  const trustedRequired = Boolean(policy.requireTrustedWorkspace !== false && !trusted);
  const reasons = [
    ...(risk.reasons || []),
    ...(trustedRequired ? ["workspace is not trusted"] : [])
  ];
  const matches = [
    ...(risk.matches || []),
    ...(trustedRequired
      ? [{ code: "untrusted_workspace", severity: "high", reason: "workspace is not trusted", policy: "requireTrustedWorkspace=true" }]
      : [])
  ];
  return {
    ...risk,
    trustedWorkspace: trusted,
    trustedWorkspaceRequired: trustedRequired,
    risky: Boolean(risk.risky || trustedRequired),
    required: Boolean(risk.required || trustedRequired),
    reasons: [...new Set(reasons)],
    matches
  };
}

function terminalSessionApprovalRisk(workspacePath = "", policy = {}) {
  const trusted = isTrustedWorkspace(workspacePath || settings.defaultCwd || process.cwd(), policy);
  const trustedRequired = Boolean(policy.requireTrustedWorkspace !== false && !trusted);
  const interactiveRequired = policy.requireDangerousCommandApproval !== false;
  const reasons = [
    ...(interactiveRequired ? ["interactive terminal session"] : []),
    ...(trustedRequired ? ["workspace is not trusted"] : [])
  ];
  const matches = [
    ...(interactiveRequired ? [{ code: "interactive_terminal", severity: "high", reason: "interactive terminal session", policy: "requireDangerousCommandApproval=true" }] : []),
    ...(trustedRequired ? [{ code: "untrusted_workspace", severity: "high", reason: "workspace is not trusted", policy: "requireTrustedWorkspace=true" }] : [])
  ];
  return {
    risky: Boolean(interactiveRequired || trustedRequired),
    required: Boolean(interactiveRequired || trustedRequired),
    trustedWorkspace: trusted,
    trustedWorkspaceRequired: trustedRequired,
    reasons: [...new Set(reasons)],
    matches
  };
}

async function startWorkspaceTerminalSessionToolRun(toolRunId, settingsValue) {
  const run = getToolRun(toolRunId);
  if (!run) {
    const error = new Error("Tool run not found.");
    error.status = 404;
    throw error;
  }
  const input = run.input || {};
  const cwd = resolveWorkspacePath(input.workspaceId, settingsValue);
  updateToolRun(toolRunId, { status: "running", startedAt: new Date().toISOString() });
  emitToolEvent(toolRunId, {
    type: "tool.started",
    text: `Terminal session started in ${cwd}`,
    payload: { input, cwd }
  });
  mirrorWorkspaceCommandTaskEvent(toolRunId, "system", `Terminal session started in ${cwd}`, { cwd, workspaceId: input.workspaceId || "" }, "terminal-started", "workspace.terminal_session");

  try {
    const session = await startTerminalSession({
      id: toolRunId,
      cwd,
      shell: input.shell || "",
      args: Array.isArray(input.args) ? input.args : [],
      cols: input.cols || 100,
      rows: input.rows || 30,
      mode: input.mode || "auto",
      onOutput: (chunk) => {
        const payload = {
          sessionId: toolRunId,
          stream: chunk.stream,
          text: chunk.text,
          mode: chunk.mode,
          bytes: Buffer.byteLength(chunk.text || "", "utf8"),
          cwd
        };
        const event = emitToolEvent(toolRunId, {
          type: "tool.output",
          text: chunk.text,
          payload
        });
        mirrorWorkspaceCommandTaskEvent(
          toolRunId,
          chunk.stream === "stderr" ? "stderr" : "stdout",
          chunk.text,
          payload,
          event?.id || "",
          "workspace.terminal_session"
        );
      },
      onExit: (sessionResult) => {
        const ok = Number(sessionResult.exitCode || 0) === 0;
        updateToolRun(toolRunId, {
          status: ok ? "completed" : "failed",
          result: sessionResult,
          error: ok ? "" : `Terminal exited with code ${sessionResult.exitCode}`,
          completedAt: new Date().toISOString()
        });
        emitToolEvent(toolRunId, {
          type: ok ? "tool.completed" : "tool.failed",
          text: sessionResult.signal ? `Terminal exited with signal ${sessionResult.signal}` : `Terminal exited with code ${sessionResult.exitCode}`,
          payload: { session: sessionResult, ok }
        });
        mirrorWorkspaceCommandTaskEvent(
          toolRunId,
          "system",
          ok ? "Terminal session completed." : `Terminal session failed with code ${sessionResult.exitCode}`,
          { session: sessionResult, ok },
          "terminal-exited",
          "workspace.terminal_session"
        );
      }
    });
    emitToolEvent(toolRunId, {
      type: "tool.output",
      text: `terminal mode=${session.mode} shell=${session.shell}`,
      payload: { session }
    });
    return { ok: true, status: "running", session, toolRunId };
  } catch (error) {
    updateToolRun(toolRunId, { status: "failed", error: error.message, completedAt: new Date().toISOString() });
    emitToolEvent(toolRunId, { type: "tool.error", text: error.message, payload: { error: error.message } });
    mirrorWorkspaceCommandTaskEvent(toolRunId, "error", error.message, { error: error.message }, "terminal-error", "workspace.terminal_session");
    throw error;
  }
}

async function executeWorkspaceCommandToolRun(toolRunId, settingsValue) {
  return runApprovedWorkspaceCommand({
    toolRunId,
    execute: async (input) => {
      const controller = new AbortController();
      activeWorkspaceCommands.set(toolRunId, {
        controller,
        startedAt: new Date().toISOString(),
        command: input.command || "",
        workspaceId: input.workspaceId || ""
      });
      try {
        mirrorWorkspaceCommandTaskEvent(
          toolRunId,
          "system",
          `${input.kind === "test" ? "Running workspace test" : "Running workspace command"}: ${input.command || ""}`,
          { command: input.command || "", kind: input.kind || "terminal", workspaceId: input.workspaceId || "" },
          "started"
        );
        const result = await runWorkspaceCommand(input.workspaceId, settingsValue, {
          command: input.command,
          kind: input.kind,
          timeoutMs: input.timeoutMs,
          approved: true,
          signal: controller.signal,
          onOutput: (chunk) => {
            const payload = {
              stream: chunk.stream,
              text: chunk.text,
              bytes: Buffer.byteLength(chunk.text || "", "utf8"),
              elapsedMs: chunk.elapsedMs,
              command: chunk.command,
              cwd: chunk.cwd
            };
            const event = emitToolEvent(toolRunId, {
              type: "tool.output",
              text: chunk.text,
              payload
            });
            mirrorWorkspaceCommandTaskEvent(
              toolRunId,
              chunk.stream === "stderr" ? "stderr" : "stdout",
              chunk.text,
              payload,
              event?.id || ""
            );
          }
        });
        mirrorWorkspaceCommandTaskEvent(
          toolRunId,
          "system",
          result.ok ? "Workspace command completed." : "Workspace command failed.",
          { command: input.command || "", kind: input.kind || "terminal", exitCode: result.exitCode ?? null, ok: Boolean(result.ok) },
          "completed"
        );
        return result;
      } finally {
        activeWorkspaceCommands.delete(toolRunId);
      }
    }
  });
}

function stopWorkspaceToolRun(toolRunId, reason = "Stopped by user.") {
  const active = activeWorkspaceCommands.get(toolRunId);
  if (!active) {
    const run = getToolRun(toolRunId);
    return { ok: false, stopped: false, error: run ? "Tool run is not running." : "Tool run not found.", toolRun: run || null };
  }
  emitToolEvent(toolRunId, {
    type: "tool.cancel_requested",
    text: reason,
    payload: {
      reason,
      command: active.command,
      workspaceId: active.workspaceId
    }
  });
  active.controller.abort(reason);
  return { ok: true, stopped: true, toolRunId };
}

async function executeAgentTaskToolRun(toolRunId, settingsValue) {
  return runWorkspaceToolAction({
    toolRunId,
    startedText: (input) => input.prompt || input.title || "Agent task",
    completedText: "Agent task created.",
    failedText: "Agent task failed to start.",
    execute: async (input) => {
      const payload = {
        ...(input.payload || {}),
        approved: true
      };
      const task = await createTask(payload, settingsValue);
      const workspace = findWorkspaceForPath(task.cwd || payload.cwd || "");
      attachToolRunToTask(toolRunId, { taskId: task.id, workspaceId: workspace?.id || "" });
      return {
        ok: true,
        id: task.id,
        status: task.status,
        task: {
          id: task.id,
          agent: task.agent,
          title: task.title,
          cwd: task.cwd,
          status: task.status,
          sessionId: task.sessionId || ""
        }
      };
    }
  });
}

async function executeBrowserFetchToolRun(toolRunId) {
  return runWorkspaceToolAction({
    toolRunId,
    startedText: (input) => input.url || "Browser fetch",
    completedText: "Browser fetch completed.",
    failedText: "Browser fetch failed.",
    execute: async (input) => fetchBrowserPage(input, {
      emitProgress: (event) => {
        emitToolEvent(toolRunId, {
          type: "tool.output",
          text: [event.phase, event.status || event.bytes || event.url || ""].filter(Boolean).join(" "),
          payload: event
        });
      }
    })
  });
}

async function executeAgentReachToolRun(toolRunId, action) {
  return runWorkspaceToolAction({
    toolRunId,
    startedText: (input) => ["Agent Reach", action, input.source || input.platform || input.operation || ""].filter(Boolean).join(" "),
    completedText: "Agent Reach completed.",
    failedText: "Agent Reach failed.",
    execute: async (input) => runAgentReachCommand(action, input, { timeoutMs: input.timeoutMs })
  });
}

async function executeDoubaoToolRun(toolRunId, action) {
  return runWorkspaceToolAction({
    toolRunId,
    startedText: (input) => ["Doubao", action, input.prompt || ""].filter(Boolean).join(" "),
    completedText: "Doubao completed.",
    failedText: "Doubao failed.",
    execute: async (input) => runDoubaoCommand(action, input, { timeoutMs: input.timeoutMs })
  });
}

async function executeMcpCallToolRun(toolRunId, settingsValue) {
  return runWorkspaceToolAction({
    toolRunId,
    startedText: (input) => input.fullName || ["mcp", input.serverId || "", input.toolName || ""].join("__"),
    completedText: "MCP call completed.",
    failedText: "MCP call failed.",
    execute: async (input) => callMcpTool(settingsValue, input, {
      timeoutMs: Number(input.timeoutMs || 0),
      emitProgress: (event) => {
        emitToolEvent(toolRunId, {
          type: "tool.output",
          text: [event.phase, event.name || event.serverId || event.method || event.toolName || "", event.status || ""].filter(Boolean).join(" "),
          payload: event
        });
      }
    })
  });
}

function runnableApprovedToolRun(toolRunId) {
  const run = getToolRun(toolRunId);
  if (!run) return false;
  return ["approved", "pending", "approval_required"].includes(run.status || "");
}

async function resumeApprovedToolRun(approval, settingsValue, request, url, auth) {
  if (!approval?.toolRunId) return { ok: true, result: null, runnable: false };
  const run = getToolRun(approval.toolRunId);
  if (!run) {
    const error = new Error("Approved tool run was not found.");
    error.status = 404;
    throw error;
  }

  if (!runnableApprovedToolRun(approval.toolRunId)) {
    return { ok: run.status === "completed", result: run.result || null, runnable: false, toolRun: run };
  }

  let result = null;
  if (approval.kind === "workspace.command" || approval.kind === "workspace.test") {
    result = await executeWorkspaceCommandToolRun(approval.toolRunId, settingsValue);
    audit(request, url, auth, {
      type: approval.kind === "workspace.test" ? "workspace.test" : "workspace.command",
      success: Boolean(result.ok),
      target: result.workspace?.path || approval.workspaceId,
      reason: result.ok ? "" : result.stderr || result.stdout || "Command failed",
      meta: { approvedByApprovalId: approval.id, toolRunId: approval.toolRunId, resumed: true }
    });
  } else if (approval.kind === "agent.task") {
    result = await executeAgentTaskToolRun(approval.toolRunId, settingsValue);
    audit(request, url, auth, {
      type: "task.create",
      success: Boolean(result.ok),
      target: result.id || approval.toolRunId,
      reason: result.ok ? "" : result.error || "Task failed to start",
      meta: { approvedByApprovalId: approval.id, toolRunId: approval.toolRunId, resumed: true }
    });
  } else if (approval.kind === "browser.fetch") {
    result = await executeBrowserFetchToolRun(approval.toolRunId);
    audit(request, url, auth, {
      type: "browser.fetch",
      success: Boolean(result.ok),
      target: result.finalUrl || result.url || approval.toolRunId,
      reason: result.ok ? "" : result.statusText || "Browser fetch failed",
      meta: { approvedByApprovalId: approval.id, toolRunId: approval.toolRunId, resumed: true }
    });
  } else if (approval.kind === "mcp.call") {
    result = await executeMcpCallToolRun(approval.toolRunId, settingsValue);
    audit(request, url, auth, {
      type: "mcp.call",
      success: Boolean(result.ok),
      target: result.fullName || approval.toolRunId,
      reason: result.ok ? "" : result.error || "MCP call failed",
      meta: { approvedByApprovalId: approval.id, toolRunId: approval.toolRunId, resumed: true }
    });
  } else if (approval.kind === "workspace.terminal_session") {
    result = await startWorkspaceTerminalSessionToolRun(approval.toolRunId, settingsValue);
    audit(request, url, auth, {
      type: "workspace.terminal_session",
      success: Boolean(result.ok),
      target: result.session?.cwd || approval.workspaceId,
      reason: result.ok ? "" : result.error || "Terminal session failed to start",
      meta: { approvedByApprovalId: approval.id, toolRunId: approval.toolRunId, resumed: true }
    });
  }

  return { ok: true, result, runnable: true, toolRun: getToolRun(approval.toolRunId) };
}

async function runSystemTool({ toolName, title, input = {}, execute, request, url, auth }) {
  const toolRun = createWorkspaceActionToolRun({
    workspaceId: "",
    toolName,
    title,
    input
  });
  try {
    const result = await runWorkspaceToolAction({
      toolRunId: toolRun.id,
      startedText: title,
      completedText: `${title} completed.`,
      failedText: `${title} failed.`,
      execute: () => execute(toolRun)
    });
    audit(request, url, auth, {
      type: toolName,
      success: Boolean(result.ok),
      target: toolRun.id,
      reason: result.ok ? "" : result.error || result.stderr || result.stdout || "Tool failed.",
      meta: { toolRunId: toolRun.id }
    });
    return { ...result, toolRunId: toolRun.id };
  } catch (error) {
    audit(request, url, auth, {
      type: toolName,
      success: false,
      target: toolRun.id,
      reason: error.message,
      meta: { toolRunId: toolRun.id }
    });
    throw error;
  }
}

function runProbeCommand(command, args = [], { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: withAgentReachPath(process.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      resolve({ ok: false, stdout, stderr: stderr || "Timed out.", code: -1 });
    }, timeoutMs);

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: error.message, code: -1 });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

function splitProbeCommandLine(input) {
  const args = [];
  let current = "";
  let quote = "";
  let escape = false;

  for (let index = 0; index < String(input || "").length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === "\\" && quote && (next === quote || next === "\\")) {
      escape = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

async function commandProbe(commandLine, args = ["--version"]) {
  const parts = splitProbeCommandLine(commandLine);
  if (!parts.length) {
    return { ok: false, command: "", code: -1, version: "", error: "Command is empty." };
  }
  const [command, ...baseArgs] = parts;
  const result = await runProbeCommand(command, [...baseArgs, ...args], { timeoutMs: 5000 });
  return {
    ok: result.ok,
    command: commandLine,
    code: result.code,
    version: (result.stdout || result.stderr || "").split(/\r?\n/).find(Boolean)?.slice(0, 240) || "",
    error: result.ok ? "" : (result.stderr || result.stdout || "Command not available.").slice(0, 500)
  };
}

function doctorCheck(id, ok, label, detail, severity = "error") {
  return { id, ok, label, detail, severity };
}

function sandboxDoctorStatus(settingsValue = settings) {
  const security = settingsValue.security || {};
  const workspaces = getWorkspaces(settingsValue);
  const allowRoots = [
    ...(Array.isArray(settingsValue.allowedRoots) ? settingsValue.allowedRoots : []),
    ...workspaces.map((workspace) => workspace.allowedRoot || workspace.path).filter(Boolean)
  ];
  return {
    mode: security.sandboxMode || "workspace-write",
    backend: "policy-only",
    nativeBackendAvailable: false,
    enabled: true,
    reason: process.platform === "win32"
      ? "Windows native process sandbox backend is not wired yet; VibeLink enforces preflight policy, approvals, allowed roots, and network gating."
      : "Native process sandbox backend is not wired yet; VibeLink enforces preflight policy, approvals, allowed roots, and network gating.",
    allowRoots: [...new Set(allowRoots)].slice(0, 100),
    networkAccess: security.networkAccess !== false,
    approvalPolicy: security.approvalPolicy || "on-request",
    requireTrustedWorkspace: security.requireTrustedWorkspace !== false,
    permissionDomains: ["read-only", "workspace-write", "network", "destructive", "privileged"]
  };
}

async function buildDoctorReport(request) {
  const publicSettingsValue = await publicSettings(settings);
  const [desktop, git, gh, codex, claude, agentReach, doubao] = await Promise.all([
    getCodexDesktopStatus().catch((error) => ({ ok: false, error: error.message })),
    commandProbe("git"),
    commandProbe("gh"),
    settings.codexCommand && settings.codexCommand !== "auto" ? commandProbe(settings.codexCommand) : Promise.resolve({ ok: true, command: settings.codexCommand || "auto", version: "auto" }),
    commandProbe(settings.claudeCommand || "claude"),
    commandProbe("agent-reach", ["version"]),
    getDoubaoStatus({
      endpoint: settings.doubaoCdpEndpoint,
      url: settings.doubaoUrl,
      timeoutMs: 5000
    }).catch((error) => ({ ok: false, error: error.message }))
  ]);
  const toolStats = toolEventStatsPayload();
  const workspaces = getWorkspaces(settings);
  const trusted = settings.security?.trustedWorkspaces || [];
  const mcp = mcpStatus(settings);
  const codebaseMemory = codebaseMemoryInstallInfo();
  const sandbox = sandboxDoctorStatus(settings);
  const terminal = terminalCapabilityReport();
  const hasAnyModelKey = Boolean(publicSettingsValue.hasOpenAIKey || publicSettingsValue.hasAnthropicKey || publicSettingsValue.hasZhipuKey || publicSettingsValue.doubaoCommand);
  const checks = [
    doctorCheck("node", Number(process.versions.node.split(".")[0]) >= 22, "Node runtime", process.version),
    doctorCheck("sqlite", Boolean(getDbPath()), "SQLite", getDbPath()),
    doctorCheck("tool-events", true, "Tool event store", `${toolStats.count} events, cursor ${toolStats.maxCursor || 0}`),
    doctorCheck("credentials", Boolean(publicSettingsValue.credentials?.available), "Credential backend", publicSettingsValue.credentials?.description || "unknown"),
    doctorCheck("model-key", hasAnyModelKey, "Model provider", hasAnyModelKey ? "configured" : "missing"),
    doctorCheck("openai-key", Boolean(publicSettingsValue.hasOpenAIKey), "OpenAI key", publicSettingsValue.hasOpenAIKey ? "configured" : "missing", "warn"),
    doctorCheck("anthropic-key", Boolean(publicSettingsValue.hasAnthropicKey), "Anthropic key", publicSettingsValue.hasAnthropicKey ? "configured" : "missing", "warn"),
    doctorCheck("zhipu-key", Boolean(publicSettingsValue.hasZhipuKey), "Zhipu/GLM key", publicSettingsValue.hasZhipuKey ? "configured" : "missing", "warn"),
    doctorCheck("git", git.ok, "Git", git.version || git.error),
    doctorCheck("gh", gh.ok, "GitHub CLI", gh.version || gh.error, "warn"),
    doctorCheck("codex", codex.ok, "Codex command", codex.version || codex.error || codex.command, settings.codexCommand && settings.codexCommand !== "auto" ? "error" : "warn"),
    doctorCheck("claude", claude.ok, "Claude command", claude.version || claude.error, "warn"),
    doctorCheck("agent-reach", agentReach.ok, "Agent Reach", agentReach.version || agentReach.error, "warn"),
    doctorCheck("doubao", doubao.ok, "Doubao web CLI", doubao.status?.target?.ok ? doubao.status.target.url : doubao.status?.target?.reason || doubao.doctor?.stderr || doubao.doctor?.stdout || doubao.error || "not ready", "warn"),
    doctorCheck("desktop", Boolean(desktop?.ok || desktop?.found), "Codex Desktop", desktop?.target?.windowTitle || desktop?.windowTitle || desktop?.error || "not found", "warn"),
    doctorCheck("host", isHostAllowed(request, settings), "Host allowlist", request.headers.host || "unknown"),
    doctorCheck("workspace-command-network", settings.security?.networkAccess !== false, "Workspace command network", settings.security?.networkAccess === false ? "network commands require approval" : "enabled", "warn"),
    doctorCheck("workspace-command-trust", settings.security?.requireTrustedWorkspace === false || trusted.length > 0, "Workspace command trust", settings.security?.requireTrustedWorkspace === false ? "not required" : trusted.length ? "untrusted workspaces require approval" : "no trusted workspaces configured", "warn"),
    doctorCheck("sandbox-policy", sandbox.enabled, "Sandbox policy", `${sandbox.backend}, mode=${sandbox.mode}, network=${sandbox.networkAccess ? "enabled" : "approval required"}`, "warn"),
    doctorCheck("terminal-runtime", terminal.fallbackAvailable, "Terminal runtime", terminal.ptyAvailable ? "PTY backend available" : terminal.reason, terminal.fallbackAvailable ? "warn" : "error"),
    doctorCheck("mcp-config", true, "MCP servers", `${mcp.enabled}/${mcp.configured} enabled`, "warn"),
    doctorCheck("codebase-memory-mcp", codebaseMemory.available, "Codebase memory MCP", codebaseMemory.server?.command || "not installed", "warn"),
    doctorCheck("trusted-workspaces", !settings.security?.requireTrustedWorkspace || trusted.length > 0, "Trusted workspaces", trusted.length ? `${trusted.length} configured` : "none configured"),
    doctorCheck("workspace-count", workspaces.length > 0, "Workspaces", `${workspaces.length} known`)
  ];
  const failures = checks.filter((item) => !item.ok && item.severity !== "warn");
  const warnings = [
    ...checks.filter((item) => !item.ok && item.severity === "warn"),
    ...publicAccessWarnings(request, settings).map((message, index) => ({
      id: `public-access-${index + 1}`,
      ok: false,
      label: "Public access",
      detail: message,
      severity: "warn"
    }))
  ];
  return {
    ok: failures.length === 0,
    platform: {
      os: process.platform,
      arch: process.arch,
      release: os.release(),
      node: process.version
    },
    checks,
    failures,
    warningChecks: warnings,
    warnings,
    security: {
      sandboxMode: settings.security?.sandboxMode || "",
      approvalPolicy: settings.security?.approvalPolicy || "",
      networkAccess: settings.security?.networkAccess !== false,
      requireTrustedWorkspace: settings.security?.requireTrustedWorkspace !== false,
      cloudflare: cloudflareGuide(request, settings)
    },
    sandbox,
    terminal,
    agentReach: {
      ...agentReach,
      install: agentReachInstallInfo()
    },
    doubao,
    codebaseMemory,
    toolEvents: toolStats,
    mcp,
    desktop,
    network: getNetworkAddresses(settings.port),
    generatedAt: new Date().toISOString()
  };
}

async function providerRegistryPayload(options = {}) {
  const settingsValue = await settingsWithSecrets(settings);
  const probes = {};
  if (options.fresh) {
    const [codex, claude, doubao] = await Promise.all([
      settings.codexCommand && settings.codexCommand !== "auto"
        ? commandProbe(settings.codexCommand).catch((error) => ({ ok: false, error: error.message }))
        : Promise.resolve({ ok: true }),
      commandProbe(settings.claudeCommand || "claude").catch((error) => ({ ok: false, error: error.message })),
      getDoubaoStatus({
        endpoint: settings.doubaoCdpEndpoint,
        url: settings.doubaoUrl,
        timeoutMs: 5000
      }).catch((error) => ({ ok: false, error: error.message }))
    ]);
    probes.codex = codex;
    probes.claude = claude;
    probes.doubao = doubao;
  }
  return buildProviderRegistry({ settings: settingsValue, probes });
}

function serveStatic(request, response, url) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendError(response, 404, "Not found");
      return;
    }

    const extension = path.extname(filePath);
    const isHashedAsset = /^\/assets\/.+-[A-Za-z0-9_-]+\.(?:js|css)$/.test(url.pathname);
    const cacheControl = isHashedAsset
      ? "public, max-age=31536000, immutable"
      : "no-store, must-revalidate";

    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": cacheControl
    });
    response.end(data);
  });
}

function serveLocalFile(request, response, url, auth) {
  const requestedPath = (url.searchParams.get("path") || "").trim().replace(/^<|>$/g, "");
  let filePath = "";
  try {
    filePath = resolveAllowedPath(requestedPath, settings);
  } catch (error) {
    audit(request, url, auth, { type: "file.access", success: false, target: requestedPath, reason: error.message });
    sendError(response, error.status || 403, error.message);
    return;
  }
  const extension = path.extname(filePath).toLowerCase();

  if (!path.isAbsolute(requestedPath) || !servableFileExtensions.has(extension)) {
    audit(request, url, auth, { type: "file.access", success: false, target: requestedPath, reason: "Unsupported file" });
    sendError(response, 400, "Unsupported file");
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      audit(request, url, auth, { type: "file.access", success: false, target: filePath, reason: "File not found" });
      sendError(response, 404, "File not found");
      return;
    }
    if (!imageExtensions.has(extension) && stat.size > 25 * 1024 * 1024) {
      audit(request, url, auth, { type: "file.access", success: false, target: filePath, reason: "File is too large" });
      sendError(response, 413, "File is too large to serve through the bridge.");
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        audit(request, url, auth, { type: "file.access", success: false, target: filePath, reason: "File not found" });
        sendError(response, 404, "File not found");
        return;
      }

      audit(request, url, auth, { type: "file.access", success: true, target: filePath, meta: { size: stat.size, extension } });
      const disposition = imageExtensions.has(extension) || extension === ".pdf" ? "inline" : "attachment";
      response.writeHead(200, {
        "Content-Type": mimeTypes[extension] || "application/octet-stream",
        "Content-Disposition": `${disposition}; filename="${path.basename(filePath).replace(/"/g, "_")}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=60"
      });
      response.end(data);
    });
  });
}

function attachmentPathFor(id) {
  const safeId = path.basename(String(id || ""));
  if (!/^[a-f0-9-]+(?:\.[a-z0-9]{1,16})?$/i.test(safeId)) return "";
  return path.join(attachmentsDir, safeId);
}

function safeUploadName(value) {
  return path
    .basename(String(value || "attachment").replaceAll("\\", "/"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .slice(0, 160) || "attachment";
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function uploadExtension(mimeType, name) {
  const fromMime = uploadMimeToExt.get(mimeType);
  if (fromMime) return fromMime;
  const fromName = path.extname(safeUploadName(name)).toLowerCase();
  if (/^\.[a-z0-9]{1,16}$/i.test(fromName)) return fromName;
  return ".bin";
}

function textPreview(buffer, mimeType, extension) {
  const textish =
    mimeType.startsWith("text/") ||
    [".txt", ".md", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".xml", ".yaml", ".yml", ".toml", ".py", ".ps1", ".sh"].includes(extension);
  if (!textish) return "";
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf8");
  if (sample.includes("\u0000")) return "";
  return sample;
}

async function saveAttachment(request, response) {
  const mimeType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const originalName = safeUploadName(safeDecode(request.headers["x-file-name"] || ""));
  const relativePath = safeDecode(request.headers["x-relative-path"] || "").replace(/^[\\/]+/, "").slice(0, 500);
  const extension = uploadExtension(mimeType, originalName);

  let data;
  try {
    data = await readRawBody(request, 30 * 1024 * 1024);
  } catch (error) {
    sendError(response, error.status || 400, error.message);
    return;
  }

  if (!data.length) {
    sendError(response, 400, "Empty upload.");
    return;
  }

  await fs.promises.mkdir(attachmentsDir, { recursive: true });
  const id = `${crypto.randomUUID()}${extension}`;
  const filePath = path.join(attachmentsDir, id);
  await fs.promises.writeFile(filePath, data);
  const isImage = imageExtensions.has(extension);
  sendJson(response, 201, {
    ok: true,
    id,
    name: originalName,
    relativePath,
    path: filePath,
    url: `/api/attachments/${encodeURIComponent(id)}`,
    kind: isImage ? "image" : "file",
    markdown: isImage ? `![${originalName}](${filePath})` : `[${originalName}](${filePath})`,
    mimeType,
    size: data.length,
    preview: textPreview(data, mimeType, extension)
  });
}

function serveAttachment(request, response, url) {
  const id = decodeURIComponent(url.pathname.replace(/^\/api\/attachments\//, ""));
  const filePath = attachmentPathFor(id);
  if (!filePath || !filePath.startsWith(attachmentsDir)) {
    sendError(response, 400, "Invalid attachment.");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendError(response, 404, "Attachment not found.");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Content-Disposition": `inline; filename="${path.basename(filePath).replaceAll('"', "")}"`,
      "Cache-Control": "private, max-age=300"
    });
    response.end(data);
  });
}

async function routeApi(request, response, url) {
  if (url.pathname === "/api/login" && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "login", { limit: 8, windowMs: 10 * 60 * 1000 })) return;
    const body = await readBody(request);
    const activeDevices = listDevices().filter((device) => !device.revokedAt && !device.expired);
    const legacyAllowed = Boolean(settings.allowLegacyPairingTokenLogin) || (!isPublicHost(request) && activeDevices.length === 0);
    if (!legacyAllowed) {
      audit(request, url, null, {
        type: "login",
        success: false,
        reason: isPublicHost(request)
          ? "Legacy pairing token login is disabled on public hosts."
          : "Legacy pairing token login is disabled after a device is paired."
      });
      sendError(response, 403, "Legacy pairing token login is disabled. Use QR pairing and approve the device from an existing session.");
      return;
    }
    let device;
    try {
      device = pairDevice({
        pairingToken: body.pairingToken,
        settings,
        label: body.deviceLabel || request.headers["user-agent"] || "Browser"
      });
    } catch (error) {
      audit(request, url, null, { type: "login", success: false, reason: error.message });
      sendError(response, error.status || 401, error.message);
      return;
    }

    const patch = sanitizeSettingsPatch({ apiKeys: body.apiKeys || {} });
    let credentialResult = {};
    if (body.rememberKeys && patch.apiKeys && Object.keys(patch.apiKeys).length) {
      credentialResult = await writeApiKeys(patch.apiKeys);
    }
    settings = {
      ...settings,
      apiKeys: {
        ...settings.apiKeys,
        ...(body.rememberKeys ? {} : patch.apiKeys)
      }
    };

    if (body.rememberKeys) await saveSettings(settings);
    audit(request, url, { device }, { type: "login", success: true, target: device.id, meta: { legacyPairingToken: true, credentials: credentialResult } });
    sendJson(response, 200, { ok: true, token: device.token, device: { id: device.id, label: device.label }, settings: await publicSettings(settings) });
    return;
  }

  if (url.pathname === "/api/pairing-sessions" && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "pairing.create", { limit: 6, windowMs: 10 * 60 * 1000 })) return;
    const body = await readBody(request);
    const createdSession = createPairingSession({
      label: body.deviceLabel || requestUserAgent(request) || "New device",
      ip: requestIp(request),
      userAgent: requestUserAgent(request),
      meta: { host: cleanHost(request.headers.host || "") }
    });
    const localLauncherTrusted = Boolean(body.trustLocalLauncher) && isLoopbackIp(requestIp(request));
    const approvedSession = localLauncherTrusted ? approvePairingSession(createdSession.id, "local-windows-launcher") : null;
    const session = approvedSession ? { ...createdSession, ...approvedSession, code: createdSession.code } : createdSession;
    const pairingUrl = publicUrlFor(request, `/?pair=${encodeURIComponent(session.id)}&code=${encodeURIComponent(session.code)}`);
    const qrSvg = await QRCode.toString(pairingUrl, { type: "svg", margin: 1, width: 220 });
    audit(request, url, null, { type: "pairing.create", success: true, target: session.id, meta: { label: session.label, localLauncherTrusted } });
    sendJson(response, 201, { ok: true, session, pairingUrl, qrSvg });
    return;
  }

  const publicPairingStatusMatch = url.pathname.match(/^\/api\/pairing-sessions\/([^/]+)$/);
  if (publicPairingStatusMatch && request.method === "GET") {
    if (!enforceRateLimit(request, response, url, "pairing.status", { limit: 60, windowMs: 60 * 1000 }, null, publicPairingStatusMatch[1])) return;
    const session = getPairingSession(publicPairingStatusMatch[1]);
    if (!session) {
      sendError(response, 404, "Pairing session not found.");
      return;
    }
    sendJson(response, 200, { ok: true, session });
    return;
  }

  const pairingClaimMatch = url.pathname.match(/^\/api\/pairing-sessions\/([^/]+)\/claim$/);
  if (pairingClaimMatch && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "pairing.claim", { limit: 12, windowMs: 10 * 60 * 1000 }, null, pairingClaimMatch[1])) return;
    const body = await readBody(request);
    let result;
    try {
      result = claimPairingSession({
        id: pairingClaimMatch[1],
        code: body.code || url.searchParams.get("code") || "",
        label: body.deviceLabel || requestUserAgent(request) || "Browser",
        meta: { claimedIp: requestIp(request), userAgent: requestUserAgent(request) }
      });
    } catch (error) {
      audit(request, url, null, { type: "pairing.claim", success: false, target: pairingClaimMatch[1], reason: error.message });
      sendError(response, error.status || 400, error.message);
      return;
    }
    audit(request, url, { device: result.device }, { type: "pairing.claim", success: true, target: result.session.id });
    sendJson(response, 200, { ok: true, token: result.device.token, device: { id: result.device.id, label: result.device.label }, session: result.session, settings: await publicSettings(settings) });
    return;
  }

  if (!isHostAllowed(request, settings)) {
    audit(request, url, null, { type: "host.blocked", success: false, reason: "Host is not allowed.", target: cleanHost(request.headers.host || "") });
    sendError(response, 403, "Host is not allowed.");
    return;
  }

  const auth = authForRequest(request, url);
  if (!auth.ok) {
    audit(request, url, auth, { type: "auth.failed", success: false, reason: auth.reason || "Unauthorized" });
    sendError(response, 401, "Unauthorized");
    return;
  }

  if (url.pathname === "/api/files" && request.method === "GET") {
    if (!enforceRateLimit(request, response, url, "file.download", { limit: 120, windowMs: 60 * 1000 }, auth)) return;
    serveLocalFile(request, response, url, auth);
    return;
  }

  if (url.pathname === "/api/attachments" && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "attachment.upload", { limit: 40, windowMs: 60 * 1000 }, auth)) return;
    await saveAttachment(request, response);
    audit(request, url, auth, { type: "attachment.upload", success: true });
    return;
  }

  if (url.pathname.startsWith("/api/attachments/") && request.method === "GET") {
    serveAttachment(request, response, url);
    return;
  }

  if (url.pathname === "/api/status" && request.method === "GET") {
    const publicSettingsValue = await publicSettings(settings);
    const providerRegistry = await providerRegistryPayload();
    sendJson(response, 200, {
      ok: true,
      settings: publicSettingsValue,
      providerRegistry,
      storage: {
        sqlite: getDbPath()
      },
      security: {
        warnings: publicAccessWarnings(request, settings),
        devices: listDevices(),
        cloudflare: cloudflareGuide(request, settings)
      },
      notifications: {
        webPush: publicSettingsValue.webPush,
        emailFallback: { configured: Boolean(settings.notificationEmail) }
      },
      workspaces: getWorkspaces(settings),
      network: getNetworkAddresses(settings.port),
      tasks: conversationTasks()
    });
    return;
  }

  if (url.pathname === "/api/approvals" && request.method === "GET") {
    const approvals = listApprovalRequests({
      status: url.searchParams.get("status") || "",
      workspaceId: url.searchParams.get("workspaceId") || "",
      limit: Number(url.searchParams.get("limit") || 100)
    }).map((approval) => (approval?.status === "expired" ? expireToolApproval(approval.id) : approval));
    sendJson(response, 200, {
      items: applyFields(approvals, url)
    });
    return;
  }

  const approvalDecisionMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
  if (approvalDecisionMatch && request.method === "POST") {
    const body = await readBody(request);
    const approvalBefore = getApprovalRequest(approvalDecisionMatch[1]);
    if (!approvalBefore) {
      sendError(response, 404, "Approval request not found.");
      return;
    }

    if (approvalBefore.status !== "pending") {
      if (approvalBefore.status === "expired") {
        const approval = expireToolApproval(approvalBefore.id);
        sendJson(response, 409, { ok: false, approval, alreadyDecided: true, error: "Approval request expired." });
        return;
      }
      if (approvalBefore.status === "approved" && runnableApprovedToolRun(approvalBefore.toolRunId)) {
        const resumed = await resumeApprovedToolRun(approvalBefore, settings, request, url, auth);
        sendJson(response, 200, { ok: true, approval: approvalBefore, result: resumed.result, resumed: resumed.runnable, alreadyDecided: true });
        return;
      }
      sendJson(response, 200, { ok: approvalBefore.status === "approved", approval: approvalBefore, alreadyDecided: true });
      return;
    }

    if (body.decision === "approve" || body.approved === true) {
      const approval = approveToolApproval(approvalBefore.id, {
        deviceId: auth.device?.id || "",
        reason: body.reason || "Approved from VibeLink.",
        decision: { source: "api", body }
      });
      audit(request, url, auth, {
        type: "approval.approved",
        success: true,
        target: approval.id,
        meta: { toolRunId: approval.toolRunId, kind: approval.kind }
      });

      const resumed = await resumeApprovedToolRun(approval, settings, request, url, auth);
      sendJson(response, 200, { ok: true, approval, result: resumed.result, resumed: resumed.runnable });
      return;
    }

    const approval = denyToolApproval(approvalBefore.id, {
      deviceId: auth.device?.id || "",
      reason: body.reason || "Denied from VibeLink.",
      decision: { source: "api", body }
    });
    audit(request, url, auth, {
      type: "approval.denied",
      success: true,
      target: approval.id,
      reason: approval.decisionReason,
      meta: { toolRunId: approval.toolRunId, kind: approval.kind }
    });
    sendJson(response, 200, { ok: false, approval });
    return;
  }

  if (url.pathname === "/api/tool-runs" && request.method === "GET") {
    sendJson(response, 200, {
      items: applyFields(listToolRuns({
        workspaceId: url.searchParams.get("workspaceId") || "",
        taskId: url.searchParams.get("taskId") || "",
        limit: Number(url.searchParams.get("limit") || 100)
      }), url)
    });
    return;
  }

  const toolRunDetailMatch = url.pathname.match(/^\/api\/tool-runs\/([^/]+)$/);
  if (toolRunDetailMatch && request.method === "GET") {
    const toolRun = getToolRun(toolRunDetailMatch[1]);
    if (!toolRun) {
      sendError(response, 404, "Tool run not found.");
      return;
    }
    sendJson(response, 200, {
      toolRun,
      events: listToolEvents({
        toolRunId: toolRun.id,
        after: Number(url.searchParams.get("after") || 0),
        limit: Number(url.searchParams.get("limit") || 1000)
      })
    });
    return;
  }

  const toolRunStopMatch = url.pathname.match(/^\/api\/tool-runs\/([^/]+)\/stop$/);
  if (toolRunStopMatch && request.method === "POST") {
    const body = await readBody(request);
    const toolRunId = toolRunStopMatch[1];
    let result = stopWorkspaceToolRun(toolRunId, body.reason || "Stopped from VibeLink.");
    if (!result.ok) {
      const terminalResult = stopTerminalSession(toolRunId, body.reason || "Stopped from VibeLink.");
      if (terminalResult.ok) {
        emitToolEvent(toolRunId, {
          type: "tool.cancel_requested",
          text: terminalResult.reason || body.reason || "Stopped from VibeLink.",
          payload: { session: terminalResult.session }
        });
        result = { ...terminalResult, stopped: true, toolRunId };
      }
    }
    audit(request, url, auth, {
      type: "tool.stop",
      success: Boolean(result.ok),
      target: toolRunId,
      reason: result.ok ? "" : result.error || "Tool run is not running.",
      meta: { toolRunId }
    });
    sendJson(response, result.ok ? 200 : result.toolRun ? 409 : 404, result);
    return;
  }

  if (url.pathname === "/api/tool-registry" && request.method === "GET") {
    sendJson(response, 200, { items: applyFields(listToolRegistry({ mcpTools: getCachedMcpTools() }), url) });
    return;
  }

  if (url.pathname === "/api/provider-registry" && request.method === "GET") {
    const registry = await providerRegistryPayload({ fresh: url.searchParams.get("fresh") === "1" });
    sendJson(response, 200, applyFields(registry, url));
    return;
  }

  if (url.pathname === "/api/tool-events/stats" && request.method === "GET") {
    sendJson(response, 200, toolEventStatsPayload());
    return;
  }

  if (url.pathname === "/api/tool-events/prune" && request.method === "POST") {
    const body = await readBody(request);
    const retention = toolEventsRetention(settings);
    const dryRun = isDryRun(url) || body.dryRun !== false;
    const result = pruneToolEvents({
      before: body.before || retention.cutoff,
      keepLatest: body.keepLatest ?? retention.keepLatest,
      dryRun
    });
    audit(request, url, auth, {
      type: "tool_events.prune",
      success: true,
      target: result.cutoff,
      meta: { keepLatest: result.keepLatest, deleted: result.deleted, prunable: result.prunable, dryRun: result.dryRun }
    });
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/doctor" && request.method === "GET") {
    const result = await runSystemTool({
      toolName: "system.doctor",
      title: "Doctor",
      input: { host: request.headers.host || "", path: url.pathname },
      request,
      url,
      auth,
      execute: async () => {
        const report = await buildDoctorReport(request);
        return { ok: report.ok, result: report, error: report.ok ? "" : `${report.failures.length} check(s) failed.` };
      }
    });
    sendJson(response, 200, { ...result.result, toolRunId: result.toolRunId });
    return;
  }

  if (url.pathname === "/api/agent-reach/status" && request.method === "GET") {
    const validation = validate(AgentReachStatusSchema, { timeoutMs: Number(url.searchParams.get("timeoutMs") || 0) || undefined });
    if (!validation.ok) {
      sendJson(response, 400, { error: "Validation failed", details: validation.issues });
      return;
    }
    const result = await runSystemTool({
      toolName: "agent_reach.status",
      title: "Agent Reach status",
      input: validation.data,
      request,
      url,
      auth,
      execute: async () => {
        const status = await getAgentReachStatus({ timeoutMs: validation.data.timeoutMs });
        return { ok: status.ok, result: status, error: status.ok ? "" : status.doctor?.stderr || status.doctor?.stdout || "Agent Reach status failed." };
      }
    });
    sendJson(response, result.result?.ok ? 200 : 409, { ...result.result, toolRunId: result.toolRunId });
    return;
  }

  if (url.pathname === "/api/agent-reach/skill" && request.method === "POST") {
    const body = await readBody(request);
    const validation = validate(AgentReachSkillSchema, body);
    if (!validation.ok) {
      sendJson(response, 400, { error: "Validation failed", details: validation.issues });
      return;
    }
    const toolRun = createWorkspaceActionToolRun({
      toolName: "agent_reach.skill",
      title: `Agent Reach skill ${validation.data.operation}`,
      input: validation.data
    });
    const result = await executeAgentReachToolRun(toolRun.id, "skill");
    audit(request, url, auth, {
      type: "agent_reach.skill",
      success: Boolean(result.ok),
      target: validation.data.operation,
      reason: result.ok ? "" : result.stderr || result.stdout || "Agent Reach skill command failed.",
      meta: { toolRunId: toolRun.id }
    });
    sendJson(response, result.ok ? 200 : 409, { ...result, toolRunId: toolRun.id });
    return;
  }

  if (url.pathname === "/api/agent-reach/format" && request.method === "POST") {
    const body = await readBody(request);
    const validation = validate(AgentReachFormatSchema, body);
    if (!validation.ok) {
      sendJson(response, 400, { error: "Validation failed", details: validation.issues });
      return;
    }
    const toolRun = createWorkspaceActionToolRun({
      toolName: "agent_reach.format",
      title: `Agent Reach format ${validation.data.platform}`,
      input: validation.data
    });
    const result = await executeAgentReachToolRun(toolRun.id, "format");
    audit(request, url, auth, {
      type: "agent_reach.format",
      success: Boolean(result.ok),
      target: validation.data.platform,
      reason: result.ok ? "" : result.stderr || result.stdout || "Agent Reach format failed.",
      meta: { toolRunId: toolRun.id }
    });
    sendJson(response, result.ok ? 200 : 409, { ...result, toolRunId: toolRun.id });
    return;
  }

  if (url.pathname === "/api/agent-reach/transcribe" && request.method === "POST") {
    const body = await readBody(request);
    const validation = validate(AgentReachTranscribeSchema, body);
    if (!validation.ok) {
      sendJson(response, 400, { error: "Validation failed", details: validation.issues });
      return;
    }
    const toolRun = createWorkspaceActionToolRun({
      toolName: "agent_reach.transcribe",
      title: `Agent Reach transcribe ${validation.data.source}`,
      input: validation.data
    });
    const result = await executeAgentReachToolRun(toolRun.id, "transcribe");
    audit(request, url, auth, {
      type: "agent_reach.transcribe",
      success: Boolean(result.ok),
      target: validation.data.source,
      reason: result.ok ? "" : result.stderr || result.stdout || "Agent Reach transcribe failed.",
      meta: { toolRunId: toolRun.id }
    });
    sendJson(response, result.ok ? 200 : 409, { ...result, toolRunId: toolRun.id });
    return;
  }

  if (url.pathname === "/api/doubao/status" && request.method === "GET") {
    const validation = validate(DoubaoStatusSchema, {
      endpoint: url.searchParams.get("endpoint") || settings.doubaoCdpEndpoint,
      url: url.searchParams.get("url") || settings.doubaoUrl,
      timeoutMs: Number(url.searchParams.get("timeoutMs") || 0) || undefined
    });
    if (!validation.ok) {
      sendJson(response, 400, { error: "Validation failed", details: validation.issues });
      return;
    }
    const input = validation.data;
    const result = await runSystemTool({
      toolName: "doubao.status",
      title: "Doubao status",
      input,
      request,
      url,
      auth,
      execute: async () => {
        const status = await getDoubaoStatus(input);
        return { ok: status.ok, result: status, error: status.ok ? "" : status.doctor?.stderr || status.doctor?.stdout || "Doubao status failed." };
      }
    });
    sendJson(response, result.result?.ok ? 200 : 409, { ...result.result, toolRunId: result.toolRunId });
    return;
  }

  if (url.pathname === "/api/doubao/configure" && request.method === "POST") {
    const body = await readBody(request);
    const validation = validate(DoubaoConfigureSchema, body);
    if (!validation.ok) {
      sendJson(response, 400, { error: "Validation failed", details: validation.issues });
      return;
    }
    const toolRun = createWorkspaceActionToolRun({
      toolName: "doubao.configure",
      title: "Doubao configure",
      input: validation.data
    });
    const result = await executeDoubaoToolRun(toolRun.id, "configure");
    audit(request, url, auth, {
      type: "doubao.configure",
      success: Boolean(result.ok),
      target: validation.data.url || settings.doubaoUrl,
      reason: result.ok ? "" : result.stderr || result.stdout || "Doubao configure failed.",
      meta: { toolRunId: toolRun.id }
    });
    sendJson(response, result.ok ? 200 : 409, { ...result, toolRunId: toolRun.id });
    return;
  }

  if (url.pathname === "/api/doubao/ask" && request.method === "POST") {
    const body = await readBody(request);
    const validation = validate(DoubaoAskSchema, {
      endpoint: settings.doubaoCdpEndpoint,
      url: settings.doubaoUrl,
      ...body
    });
    if (!validation.ok) {
      sendJson(response, 400, { error: "Validation failed", details: validation.issues });
      return;
    }
    const toolRun = createWorkspaceActionToolRun({
      toolName: "doubao.ask",
      title: `Doubao ask ${validation.data.prompt}`,
      input: validation.data
    });
    const result = await executeDoubaoToolRun(toolRun.id, "ask");
    audit(request, url, auth, {
      type: "doubao.ask",
      success: Boolean(result.ok),
      target: validation.data.url || settings.doubaoUrl,
      reason: result.ok ? "" : result.stderr || result.stdout || "Doubao ask failed.",
      meta: { toolRunId: toolRun.id }
    });
    sendJson(response, result.ok ? 200 : 409, { ...result, toolRunId: toolRun.id });
    return;
  }

  if (url.pathname === "/api/mcp/status" && request.method === "GET") {
    const result = await runSystemTool({
      toolName: "mcp.status",
      title: "MCP status",
      input: { configured: settings.mcp?.servers?.length || 0 },
      request,
      url,
      auth,
      execute: async () => {
        const status = mcpStatus(settings);
        return { ok: true, result: status };
      }
    });
    sendJson(response, 200, { ...result.result, toolRunId: result.toolRunId });
    return;
  }

  if (url.pathname === "/api/mcp/probe" && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "mcp.probe", { limit: 12, windowMs: 60 * 1000 }, auth)) return;
    const body = await readBody(request);
    const result = await runSystemTool({
      toolName: "mcp.probe",
      title: body.serverId ? `MCP probe ${body.serverId}` : "MCP probe",
      input: { serverId: body.serverId || "", configured: settings.mcp?.servers?.length || 0 },
      request,
      url,
      auth,
      execute: async (toolRun) => {
        const report = await probeMcpServers(settings, {
          serverId: body.serverId || "",
          timeoutMs: Number(body.timeoutMs || 0),
          emitProgress: (event) => {
            emitToolEvent(toolRun.id, {
              type: "tool.output",
              text: [event.phase, event.name || event.serverId || event.method || "", event.status || ""].filter(Boolean).join(" "),
              payload: event
            });
          }
        });
        return { ok: report.ok, result: report, error: report.ok ? "" : "One or more MCP servers failed probe." };
      }
    });
    sendJson(response, 200, { ...result.result, toolRunId: result.toolRunId });
    return;
  }

  if (url.pathname === "/api/mcp/call" && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "mcp.call", { limit: 40, windowMs: 60 * 1000 }, auth)) return;
    const body = await readBody(request);
    const targetName = body.fullName || ["mcp", body.serverId || "", body.toolName || ""].join("__");
    const risk = mcpCallApprovalRisk(body, settings.security || {});
    if (isDryRun(url)) {
      sendJson(response, 200, {
        dryRun: true,
        wouldCall: {
          serverId: body.serverId || "",
          toolName: body.toolName || "",
          fullName: body.fullName || "",
          argumentKeys: body.arguments && typeof body.arguments === "object" ? Object.keys(body.arguments) : []
        },
        approvalRequired: risk.required,
        risk: { reasons: risk.reasons, matches: risk.matches }
      });
      return;
    }
    const toolRun = createWorkspaceActionToolRun({
      toolName: "mcp.call",
      title: `MCP call ${targetName}`,
      input: {
        serverId: body.serverId || "",
        toolName: body.toolName || "",
        fullName: body.fullName || "",
        arguments: body.arguments && typeof body.arguments === "object" ? body.arguments : {},
        argumentKeys: body.arguments && typeof body.arguments === "object" ? Object.keys(body.arguments) : [],
        timeoutMs: Number(body.timeoutMs || 0),
        risk
      }
    });

    if (risk.required) {
      const approval = requestToolApproval({
        toolRunId: toolRun.id,
        kind: "mcp.call",
        title: "Approve MCP tool call",
        reason: risk.reasons.join("; "),
        request: { serverId: body.serverId || "", toolName: body.toolName || "", fullName: body.fullName || "", argumentKeys: Object.keys(body.arguments || {}) },
        risk
      });
      audit(request, url, auth, {
        type: "mcp.call_approval_required",
        success: false,
        target: targetName,
        reason: risk.reasons.join("; "),
        meta: { approvalId: approval.id, toolRunId: toolRun.id, risk }
      });
      sendJson(response, 428, {
        error: `MCP call requires explicit approval: ${risk.reasons.join(", ")}`,
        approval,
        approvalId: approval.id,
        toolRun,
        toolRunId: toolRun.id,
        reasons: risk.reasons,
        matches: risk.matches,
        policy: { approvalPolicy: settings.security?.approvalPolicy || "" }
      });
      return;
    }

    const result = await executeMcpCallToolRun(toolRun.id, settings);
    audit(request, url, auth, {
      type: "mcp.call",
      success: Boolean(result.ok),
      target: result.fullName || targetName,
      reason: result.ok ? "" : result.error || "MCP call failed",
      meta: { toolRunId: toolRun.id, risk }
    });
    sendJson(response, result.ok ? 200 : 409, { ...result, toolRunId: toolRun.id });
    return;
  }

  if (url.pathname === "/api/browser/fetch" && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "browser.fetch", { limit: 30, windowMs: 60 * 1000 }, auth)) return;
    const body = await readBody(request);
    const validation = validate(BrowserFetchSchema, body);
    if (!validation.ok) {
      sendJson(response, 400, { error: "Validation failed", details: validation.issues });
      return;
    }
    const targetUrl = String(body.url || "").trim();
    const risk = browserFetchRisk(targetUrl, settings.security || {});
    if (isDryRun(url)) {
      sendJson(response, 200, {
        dryRun: true,
        url: targetUrl,
        approvalRequired: risk.required,
        risk: { reasons: risk.reasons, matches: risk.matches }
      });
      return;
    }
    const toolRun = createWorkspaceActionToolRun({
      toolName: "browser.fetch",
      title: targetUrl || "Browser fetch",
      input: {
        url: targetUrl,
        timeoutMs: Number(body.timeoutMs || 15000),
        maxBytes: Number(body.maxBytes || 1024 * 1024),
        risk
      }
    });

    if (risk.required) {
      const approval = requestToolApproval({
        toolRunId: toolRun.id,
        kind: "browser.fetch",
        title: "Approve browser fetch",
        reason: risk.reasons.join("; "),
        request: { url: targetUrl, timeoutMs: Number(body.timeoutMs || 15000), maxBytes: Number(body.maxBytes || 1024 * 1024) },
        risk
      });
      audit(request, url, auth, {
        type: "browser.fetch_approval_required",
        success: false,
        target: targetUrl,
        reason: risk.reasons.join("; "),
        meta: { approvalId: approval.id, toolRunId: toolRun.id, risk }
      });
      sendJson(response, 428, {
        error: `Browser fetch requires explicit approval: ${risk.reasons.join(", ")}`,
        approval,
        approvalId: approval.id,
        toolRun,
        toolRunId: toolRun.id,
        reasons: risk.reasons,
        matches: risk.matches,
        policy: {
          networkAccess: settings.security?.networkAccess !== false,
          approvalPolicy: settings.security?.approvalPolicy || ""
        }
      });
      return;
    }

    try {
      const result = await executeBrowserFetchToolRun(toolRun.id);
      audit(request, url, auth, {
        type: "browser.fetch",
        success: Boolean(result.ok),
        target: result.finalUrl || result.url || targetUrl,
        reason: result.ok ? "" : result.statusText || "Browser fetch failed",
        meta: { toolRunId: toolRun.id, risk }
      });
      sendJson(response, result.ok ? 200 : 502, { ...result, toolRunId: toolRun.id });
    } catch (error) {
      audit(request, url, auth, {
        type: "browser.fetch",
        success: false,
        target: targetUrl,
        reason: error.message,
        meta: { toolRunId: toolRun.id, risk }
      });
      sendError(response, error.status || 500, error.message);
    }
    return;
  }

  if (url.pathname === "/api/tool-events" && request.method === "GET") {
    const filter = {
      after: Number(url.searchParams.get("after") || request.headers["last-event-id"] || 0),
      toolRunId: url.searchParams.get("toolRunId") || "",
      workspaceId: url.searchParams.get("workspaceId") || "",
      taskId: url.searchParams.get("taskId") || ""
    };
    if (url.searchParams.get("stream") === "1") {
      subscribeToolEvents(response, filter);
      return;
    }
    sendJson(response, 200, {
      items: applyFields(listToolEvents({
        ...filter,
        limit: Number(url.searchParams.get("limit") || 1000)
      }), url)
    });
    return;
  }

  if (url.pathname === "/api/live-calls" && request.method === "GET") {
    sendJson(response, 200, { items: applyFields(listLiveCallSessions(), url) });
    return;
  }

  if (url.pathname === "/api/live-calls/asr-providers" && request.method === "GET") {
    sendJson(response, 200, { items: applyFields(listAsrProviders(), url) });
    return;
  }

  if (url.pathname === "/api/live-calls" && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "live_call.create", { limit: 20, windowMs: 60 * 1000 }, auth)) return;
    const body = await readBody(request);
    const session = createLiveCallSession({
      title: body.title,
      source: body.source,
      workspaceId: body.workspaceId,
      asrProvider: body.asrProvider
    });
    audit(request, url, auth, { type: "live_call.create", success: true, target: session.id, meta: { source: session.source } });
    if (session?.id) {
      setLiveCallQuestionHook(session.id, (question, sess) => {
        dispatchLiveCallQuestion({
          sessionId: sess.id,
          question,
          history: collectLiveCallHistory(sess),
          settings,
          agent: body.agent || "claude",
          model: body.model || ""
        }).catch((error) => console.error("[liveCallAgent] dispatch failed:", error.message));
      });
    }
    sendJson(response, 201, { ok: true, session });
    return;
  }

  const liveCallMatch = url.pathname.match(/^\/api\/live-calls\/([^/]+)$/);
  if (liveCallMatch && request.method === "GET") {
    const session = getLiveCallSession(liveCallMatch[1]);
    if (!session) {
      sendError(response, 404, "Live call session not found.");
      return;
    }
    sendJson(response, 200, { session });
    return;
  }

  const liveCallStopMatch = url.pathname.match(/^\/api\/live-calls\/([^/]+)\/stop$/);
  if (liveCallStopMatch && request.method === "POST") {
    const body = await readBody(request);
    stopLiveCallAgentTask(liveCallStopMatch[1]).catch(() => {});
    const session = stopLiveCallSession(liveCallStopMatch[1], body.reason || "manual");
    audit(request, url, auth, { type: "live_call.stop", success: Boolean(session), target: liveCallStopMatch[1] });
    if (!session) {
      sendError(response, 404, "Live call session not found.");
      return;
    }
    sendJson(response, 200, { ok: true, session });
    return;
  }

  const liveCallPauseMatch = url.pathname.match(/^\/api\/live-calls\/([^/]+)\/pause$/);
  if (liveCallPauseMatch && request.method === "POST") {
    const body = await readBody(request);
    const session = pauseLiveCallSession(liveCallPauseMatch[1], body.reason || "manual");
    if (!session) {
      sendError(response, 404, "Live call session not found.");
      return;
    }
    sendJson(response, 200, { ok: true, session });
    return;
  }

  const liveCallResumeMatch = url.pathname.match(/^\/api\/live-calls\/([^/]+)\/resume$/);
  if (liveCallResumeMatch && request.method === "POST") {
    const body = await readBody(request);
    const session = resumeLiveCallSession(liveCallResumeMatch[1], body.reason || "manual");
    if (!session) {
      sendError(response, 404, "Live call session not found.");
      return;
    }
    sendJson(response, 200, { ok: true, session });
    return;
  }

  const liveCallAsrCheckpointMatch = url.pathname.match(/^\/api\/live-calls\/([^/]+)\/asr-checkpoints$/);
  if (liveCallAsrCheckpointMatch && request.method === "GET") {
    const session = getLiveCallSession(liveCallAsrCheckpointMatch[1]);
    if (!session) {
      sendError(response, 404, "Live call session not found.");
      return;
    }
    sendJson(response, 200, { items: applyFields(getLiveCallAsrCheckpoints(liveCallAsrCheckpointMatch[1]), url) });
    return;
  }

  const liveCallAsrRecoverMatch = url.pathname.match(/^\/api\/live-calls\/([^/]+)\/asr-recover$/);
  if (liveCallAsrRecoverMatch && request.method === "POST") {
    const session = getLiveCallSession(liveCallAsrRecoverMatch[1]);
    if (!session) {
      sendError(response, 404, "Live call session not found.");
      return;
    }
    const items = recoverLiveCallAsrFromCheckpoints(liveCallAsrRecoverMatch[1]);
    audit(request, url, auth, { type: "live_call.asr_recover", success: true, target: liveCallAsrRecoverMatch[1], meta: { checkpointCount: items.length } });
    sendJson(response, 200, { ok: true, items: applyFields(items, url) });
    return;
  }

  const liveCallEventsMatch = url.pathname.match(/^\/api\/live-calls\/([^/]+)\/events$/);
  if (liveCallEventsMatch && request.method === "GET") {
    const after = Number(url.searchParams.get("after") || request.headers["last-event-id"] || 0);
    const session = getLiveCallSession(liveCallEventsMatch[1]);
    if (!session) {
      sendError(response, 404, "Live call session not found.");
      return;
    }
    subscribeLiveCallEvents(liveCallEventsMatch[1], response, { after });
    return;
  }

  const liveCallEventsCatchUpMatch = url.pathname.match(/^\/api\/live-calls\/([^/]+)\/events\/catch-up$/);
  if (liveCallEventsCatchUpMatch && request.method === "GET") {
    const items = listLiveCallEvents(liveCallEventsCatchUpMatch[1], {
      after: Number(url.searchParams.get("after") || 0),
      limit: Number(url.searchParams.get("limit") || 200)
    });
    if (!items) {
      sendError(response, 404, "Live call session not found.");
      return;
    }
    sendJson(response, 200, { items: applyFields(items, url) });
    return;
  }

  // Unified event log (cross-table).
  if (url.pathname === "/api/events/unified" && request.method === "GET") {
    const items = listUnifiedEvents({
      taskId: url.searchParams.get("taskId") || "",
      liveCallSessionId: url.searchParams.get("liveCallSessionId") || "",
      toolRunId: url.searchParams.get("toolRunId") || "",
      after: Number(url.searchParams.get("after") || 0),
      limit: Number(url.searchParams.get("limit") || 200)
    });
    sendJson(response, 200, { items: applyFields(items, url) });
    return;
  }

  // Command registry.
  if (url.pathname === "/api/command-registry" && request.method === "GET") {
    const filter = url.searchParams.get("filter") || "";
    const items = getCommands(filter);
    sendJson(response, 200, { items: applyFields(items, url) });
    return;
  }
  if (url.pathname === "/api/command-registry/refresh" && request.method === "POST") {
    const count = refreshSkills();
    sendJson(response, 200, { ok: true, skillsLoaded: count });
    return;
  }

  const liveCallLevelMatch = url.pathname.match(/^\/api\/live-calls\/([^/]+)\/level$/);
  if (liveCallLevelMatch && request.method === "POST") {
    const body = await readBody(request);
    const session = recordLiveCallLevel(liveCallLevelMatch[1], body);
    if (!session) {
      sendError(response, 404, "Live call session not found.");
      return;
    }
    sendJson(response, 200, { ok: true, session });
    return;
  }

  const liveCallTranscriptMatch = url.pathname.match(/^\/api\/live-calls\/([^/]+)\/transcript$/);
  if (liveCallTranscriptMatch && request.method === "POST") {
    const body = await readBody(request);
    const session = recordLiveCallTranscript(liveCallTranscriptMatch[1], body);
    if (!session) {
      sendError(response, 404, "Live call session not found.");
      return;
    }
    sendJson(response, 200, { ok: true, session });
    return;
  }

  const liveCallAnswerMatch = url.pathname.match(/^\/api\/live-calls\/([^/]+)\/answer$/);
  if (liveCallAnswerMatch && request.method === "POST") {
    const body = await readBody(request);
    const session = recordLiveCallAnswer(liveCallAnswerMatch[1], body);
    if (!session) {
      sendError(response, 404, "Live call session not found.");
      return;
    }
    sendJson(response, 200, { ok: true, session });
    return;
  }

  if (url.pathname === "/api/settings" && request.method === "POST") {
    const body = await readBody(request);
    const validation = validate(SettingsPatchSchema, body);
    if (!validation.ok) {
      sendJson(response, 400, { error: "Validation failed", details: validation.issues });
      return;
    }
    const patch = sanitizeSettingsPatch(body);
    if (isDryRun(url)) {
      const currentPublic = await publicSettings(settings);
      const diff = {};
      for (const key of Object.keys(patch)) {
        diff[key] = { from: currentPublic[key], to: patch[key] };
      }
      sendJson(response, 200, { dryRun: true, diff, wouldChange: Object.keys(diff).length > 0 });
      return;
    }
    const credentialResult = patch.apiKeys ? await writeApiKeys(patch.apiKeys) : {};
    settings = {
      ...settings,
      ...patch,
      mcp: patch.mcp ? mergeMcpSettings(settings.mcp || {}, patch.mcp) : settings.mcp,
      apiKeys: {
        ...settings.apiKeys
      }
    };
    settings = ensureNotificationSettings(settings);
    await saveSettings(settings);
    ensureDefaultWorkspaces(settings);
    scheduleToolEventsPrune();
    audit(request, url, auth, { type: "settings.update", success: true, meta: { keys: Object.keys(patch), credentials: credentialResult } });
    sendJson(response, 200, { ok: true, settings: await publicSettings(settings) });
    return;
  }

  if (url.pathname === "/api/openapi.json" && request.method === "GET") {
    const openapiPath = path.join(publicDir, "..", "docs", "openapi.json");
    if (fs.existsSync(openapiPath)) {
      const content = fs.readFileSync(openapiPath, "utf8");
      sendJson(response, 200, JSON.parse(content));
    } else {
      sendError(response, 404, "OpenAPI spec not found. Run: node tools/gen-openapi.mjs > docs/openapi.json");
    }
    return;
  }

  if (url.pathname === "/api/cloudflare/guide" && request.method === "GET") {
    sendJson(response, 200, cloudflareGuide(request, settings));
    return;
  }

  if (url.pathname === "/api/devices" && request.method === "GET") {
    sendJson(response, 200, { items: applyFields(listDevices(), url), currentDeviceId: auth.device?.id || "" });
    return;
  }

  if (url.pathname === "/api/devices/current/rotate" && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "device.rotate", { limit: 6, windowMs: 10 * 60 * 1000 }, auth, auth.device?.id || "")) return;
    const result = rotateDeviceToken(auth.device?.id || "");
    audit(request, url, auth, { type: "device.rotate", success: Boolean(result), target: auth.device?.id || "", reason: result ? "" : "Device not found." });
    if (!result) {
      sendError(response, 404, "Device not found.");
      return;
    }
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  const deviceRevokeMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/);
  if (deviceRevokeMatch && request.method === "POST") {
    const ok = revokeDevice(deviceRevokeMatch[1]);
    audit(request, url, auth, { type: "device.revoke", success: ok, target: deviceRevokeMatch[1], reason: ok ? "" : "Device not found or already revoked." });
    sendJson(response, 200, { ok });
    return;
  }

  const deviceRotateMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/rotate$/);
  if (deviceRotateMatch && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "device.rotate", { limit: 6, windowMs: 10 * 60 * 1000 }, auth, deviceRotateMatch[1])) return;
    const result = rotateDeviceToken(deviceRotateMatch[1]);
    audit(request, url, auth, { type: "device.rotate", success: Boolean(result), target: deviceRotateMatch[1], reason: result ? "" : "Device not found." });
    if (!result) {
      sendError(response, 404, "Device not found.");
      return;
    }
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (url.pathname === "/api/pairing-sessions" && request.method === "GET") {
    sendJson(response, 200, { items: applyFields(listPairingSessions({ status: url.searchParams.get("status") || "pending" }), url) });
    return;
  }

  const pairingApproveMatch = url.pathname.match(/^\/api\/pairing-sessions\/([^/]+)\/approve$/);
  if (pairingApproveMatch && request.method === "POST") {
    const session = approvePairingSession(pairingApproveMatch[1], auth.device?.id || "");
    audit(request, url, auth, { type: "pairing.approve", success: Boolean(session && session.status === "approved"), target: pairingApproveMatch[1], reason: session ? session.status : "not_found" });
    if (!session) {
      sendError(response, 404, "Pairing session not found.");
      return;
    }
    sendJson(response, 200, { ok: session.status === "approved", session });
    return;
  }

  const pairingDenyMatch = url.pathname.match(/^\/api\/pairing-sessions\/([^/]+)\/deny$/);
  if (pairingDenyMatch && request.method === "POST") {
    const session = denyPairingSession(pairingDenyMatch[1], auth.device?.id || "");
    audit(request, url, auth, { type: "pairing.deny", success: Boolean(session), target: pairingDenyMatch[1] });
    if (!session) {
      sendError(response, 404, "Pairing session not found.");
      return;
    }
    sendJson(response, 200, { ok: true, session });
    return;
  }

  if (url.pathname === "/api/audit-log" && request.method === "GET") {
    sendJson(response, 200, {
      items: applyFields(listAuditLogs({
        after: Number(url.searchParams.get("after") || 0),
        limit: Number(url.searchParams.get("limit") || 200)
      }), url)
    });
    return;
  }

  if (url.pathname === "/api/push/public-key" && request.method === "GET") {
    sendJson(response, 200, { publicKey: settings.webPush?.publicKey || "" });
    return;
  }

  if (url.pathname === "/api/push/subscriptions" && request.method === "POST") {
    const body = await readBody(request);
    const subscription = upsertPushSubscription({ deviceId: auth.device?.id || "", subscription: body.subscription || body });
    audit(request, url, auth, { type: "push.subscribe", success: true, target: subscription.id });
    sendJson(response, 201, { ok: true, subscription });
    return;
  }

  const pushRevokeMatch = url.pathname.match(/^\/api\/push\/subscriptions\/([^/]+)$/);
  if (pushRevokeMatch && request.method === "DELETE") {
    const ok = revokePushSubscription(decodeURIComponent(pushRevokeMatch[1]));
    audit(request, url, auth, { type: "push.unsubscribe", success: ok, target: pushRevokeMatch[1] });
    sendJson(response, 200, { ok });
    return;
  }

  if (url.pathname === "/api/workspaces" && request.method === "GET") {
    sendJson(response, 200, { items: applyFields(getWorkspaces(settings), url) });
    return;
  }

  if (url.pathname === "/api/workspaces" && request.method === "POST") {
    const body = await readBody(request);
    if (isDryRun(url)) {
      const validation = { name: body.name || "", path: body.path || "", allowedRoot: body.allowedRoot || "" };
      sendJson(response, 200, { dryRun: true, wouldValidate: validation, wouldCreate: !!(body.name && body.path) });
      return;
    }
    sendJson(response, 201, { workspace: createWorkspace(body, settings) });
    return;
  }

  const workspaceTreeMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tree$/);
  if (workspaceTreeMatch && request.method === "GET") {
    sendJson(response, 200, await getWorkspaceTree(workspaceTreeMatch[1], settings, url.searchParams.get("dir") || ""));
    return;
  }

  const workspaceContextMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/context$/);
  if (workspaceContextMatch && request.method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, await getWorkspaceContext(workspaceContextMatch[1], settings, body));
    return;
  }

  const workspaceFileMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/file$/);
  if (workspaceFileMatch && request.method === "GET") {
    sendJson(response, 200, await getWorkspaceFile(workspaceFileMatch[1], settings, url.searchParams.get("path") || ""));
    return;
  }

  const workspaceOpenExplorerMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/open-explorer$/);
  if (workspaceOpenExplorerMatch && request.method === "POST") {
    sendJson(response, 200, await openWorkspaceInExplorer(workspaceOpenExplorerMatch[1], settings));
    return;
  }

  const workspaceWorktreeMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/worktrees$/);
  if (workspaceWorktreeMatch && request.method === "POST") {
    const body = await readBody(request);
    const workspaceId = workspaceWorktreeMatch[1];
    const branchName = String(body.branchName || body.name || "").trim();
    if (isDryRun(url)) {
      sendJson(response, 200, {
        dryRun: true,
        workspaceId,
        branchName,
        baseRef: body.baseRef || "HEAD",
        wouldExecute: true
      });
      return;
    }
    const toolRun = createWorkspaceActionToolRun({
      workspaceId,
      toolName: "workspace.git_worktree",
      title: `create worktree ${branchName || "worktree"}`,
      input: {
        branchName,
        baseRef: body.baseRef || "HEAD",
        path: body.path || "",
        root: body.root || ""
      }
    });
    let result;
    try {
      result = await runWorkspaceToolAction({
        toolRunId: toolRun.id,
        startedText: `create worktree ${branchName || "worktree"}`,
        completedText: "Git worktree created.",
        failedText: "Git worktree creation failed.",
        execute: () => createPermanentWorktree(workspaceId, settings, body)
      });
    } catch (error) {
      audit(request, url, auth, {
        type: "workspace.git_worktree",
        success: false,
        target: workspaceId,
        reason: error.message,
        meta: { branchName, toolRunId: toolRun.id }
      });
      sendError(response, error.status || 500, error.message);
      return;
    }
    audit(request, url, auth, {
      type: "workspace.git_worktree",
      success: true,
      target: result.path || "",
      meta: { branchName: result.branchName || branchName, toolRunId: toolRun.id }
    });
    sendJson(response, 201, { ...result, toolRunId: toolRun.id });
    return;
  }

  const workspaceGitStatusMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/git\/status$/);
  if (workspaceGitStatusMatch && request.method === "GET") {
    sendJson(response, 200, await getWorkspaceGitStatus(workspaceGitStatusMatch[1], settings));
    return;
  }

  const workspaceGitDiffMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/git\/diff$/);
  if (workspaceGitDiffMatch && request.method === "GET") {
    sendJson(response, 200, await getWorkspaceGitDiff(workspaceGitDiffMatch[1], settings));
    return;
  }

  const workspaceGitFileActionMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/git\/file-action$/);
  if (workspaceGitFileActionMatch && request.method === "POST") {
    const body = await readBody(request);
    const workspaceId = workspaceGitFileActionMatch[1];
    const action = String(body.action || "").trim().toLowerCase();
    const targetPath = String(body.path || "");
    const toolRun = createWorkspaceActionToolRun({
      workspaceId,
      toolName: "workspace.git_file_action",
      title: `${action || "file-action"} ${targetPath}`.trim(),
      input: { action, path: targetPath }
    });
    let result;
    try {
      result = await runWorkspaceToolAction({
        toolRunId: toolRun.id,
        startedText: `${action || "file-action"} ${targetPath}`.trim(),
        completedText: "Git file action completed.",
        failedText: "Git file action failed.",
        execute: () => applyWorkspaceGitFileAction(workspaceId, settings, body)
      });
    } catch (error) {
      audit(request, url, auth, {
        type: "workspace.git_file_action",
        success: false,
        target: targetPath,
        reason: error.message,
        meta: { action, toolRunId: toolRun.id }
      });
      sendError(response, error.status || 500, error.message);
      return;
    }
    audit(request, url, auth, {
      type: "workspace.git_file_action",
      success: true,
      target: body.path || "",
      meta: { action: body.action || "", toolRunId: toolRun.id }
    });
    sendJson(response, 200, { ...result, toolRunId: toolRun.id });
    return;
  }

  const workspaceGitActionMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/git\/action$/);
  if (workspaceGitActionMatch && request.method === "POST") {
    const body = await readBody(request);
    const workspaceId = workspaceGitActionMatch[1];
    const action = String(body.action || "").trim().toLowerCase();
    if (isDryRun(url)) {
      sendJson(response, 200, {
        dryRun: true,
        workspaceId,
        action,
        message: body.message || "",
        wouldExecute: true
      });
      return;
    }
    const toolRun = createWorkspaceActionToolRun({
      workspaceId,
      toolName: "workspace.git_action",
      title: `git ${action || "action"}`,
      input: {
        action,
        message: body.message || "",
        title: body.title || ""
      }
    });
    let result;
    try {
      result = await runWorkspaceToolAction({
        toolRunId: toolRun.id,
        startedText: `git ${action || "action"}`,
        completedText: "Git action completed.",
        failedText: "Git action failed.",
        execute: () => applyWorkspaceGitAction(workspaceId, settings, body)
      });
    } catch (error) {
      audit(request, url, auth, {
        type: "workspace.git_action",
        success: false,
        target: workspaceId,
        reason: error.message,
        meta: { action, toolRunId: toolRun.id }
      });
      sendError(response, error.status || 500, error.message);
      return;
    }
    audit(request, url, auth, {
      type: "workspace.git_action",
      success: true,
      target: result.workspace?.path || "",
      meta: { action: body.action || "", toolRunId: toolRun.id }
    });
    sendJson(response, 200, { ...result, toolRunId: toolRun.id });
    return;
  }

  const workspaceCommandMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/command$/);
  if (workspaceCommandMatch && request.method === "POST") {
    const body = await readBody(request);
    const validation = validate(CommandInputSchema, body);
    if (!validation.ok) {
      sendJson(response, 400, { error: "Validation failed", details: validation.issues });
      return;
    }
    const workspaceId = workspaceCommandMatch[1];
    const kind = body.kind === "test" ? "test" : "terminal";
    let workspacePath = "";
    try {
      workspacePath = resolveWorkspacePath(workspaceId, settings);
    } catch (error) {
      sendError(response, error.status || 404, error.message);
      return;
    }
    const commandRisk = workspaceCommandApprovalRisk(body.command || "", workspacePath, settings.security || {});
    if (isDryRun(url)) {
      sendJson(response, 200, {
        dryRun: true,
        workspaceId,
        command: body.command || "",
        kind,
        approvalRequired: commandRisk.required,
        risk: {
          reasons: commandRisk.reasons,
          matches: commandRisk.matches,
          policy: {
            networkAccess: settings.security?.networkAccess !== false,
            sandboxMode: settings.security?.sandboxMode || ""
          }
        }
      });
      return;
    }
    const taskId = typeof body.taskId === "string" && getTask(body.taskId) ? body.taskId : "";
    const toolRun = createWorkspaceCommandToolRun({
      workspaceId,
      taskId,
      kind,
      command: body.command || "",
      timeoutMs: kind === "test" ? body.timeoutMs || 180000 : body.timeoutMs || 120000,
      risk: commandRisk
    });
    if (commandRisk.required) {
      const approval = requestToolApproval({
        toolRunId: toolRun.id,
        workspaceId,
        taskId,
        kind: kind === "test" ? "workspace.test" : "workspace.command",
        title: kind === "test" ? "Approve workspace test command" : "Approve workspace command",
        reason: commandRisk.reasons.join("; "),
        request: {
          command: body.command || "",
          kind,
          taskId,
          cwd: workspacePath,
          timeoutMs: kind === "test" ? body.timeoutMs || 180000 : body.timeoutMs || 120000
        },
        risk: commandRisk
      });
      audit(request, url, auth, {
        type: body.kind === "test" ? "workspace.test_approval_required" : "workspace.command_approval_required",
        success: false,
        target: workspaceId,
        reason: commandRisk.reasons.join("; "),
        meta: { command: body.command || "", kind, taskId, risk: commandRisk, approvalId: approval.id, toolRunId: toolRun.id }
      });
      sendCriticalNotification(settings, {
        type: "approval.required",
        title: "Command approval required",
        body: `${kind === "test" ? "Test" : "Command"} needs approval: ${body.command || ""}`.slice(0, 180),
        tag: `approval:${approval.id}`,
        url: "/",
        meta: { approvalId: approval.id, toolRunId: toolRun.id, workspaceId }
      }).catch((error) => {
        recordAuditLog({ type: "notification.error", success: false, reason: error.message, meta: { approvalId: approval.id } });
      });
      sendJson(response, 428, {
        error: `Command requires explicit approval: ${commandRisk.reasons.join(", ")}`,
        approval,
        approvalId: approval.id,
        toolRun,
        toolRunId: toolRun.id,
        reasons: commandRisk.reasons,
        matches: commandRisk.matches,
        policy: {
          networkAccess: settings.security?.networkAccess !== false,
          requireTrustedWorkspace: settings.security?.requireTrustedWorkspace !== false,
          sandboxMode: settings.security?.sandboxMode || "",
          approvalPolicy: settings.security?.approvalPolicy || ""
        }
      });
      return;
    }
    if (body.background === true) {
      executeWorkspaceCommandToolRun(toolRun.id, settings)
        .then((result) => {
          audit(request, url, auth, {
            type: body.kind === "test" ? "workspace.test" : "workspace.command",
            success: Boolean(result.ok),
            target: result.workspace?.path || "",
            reason: result.ok ? "" : result.stderr || result.stdout || "Command failed",
            meta: { command: body.command || "", kind, taskId, background: true, risk: commandRisk, toolRunId: toolRun.id }
          });
        })
        .catch((error) => {
          audit(request, url, auth, {
            type: body.kind === "test" ? "workspace.test" : "workspace.command",
            success: false,
            target: workspaceId,
            reason: error.message,
            meta: { command: body.command || "", kind, taskId, background: true, risk: commandRisk, toolRunId: toolRun.id }
          });
        });
      sendJson(response, 202, { ok: true, status: "running", background: true, toolRun, toolRunId: toolRun.id });
      return;
    }

    const result = await executeWorkspaceCommandToolRun(toolRun.id, settings);
    audit(request, url, auth, {
      type: body.kind === "test" ? "workspace.test" : "workspace.command",
      success: Boolean(result.ok),
      target: result.workspace?.path || "",
      reason: result.ok ? "" : result.stderr || result.stdout || "Command failed",
      meta: { command: body.command || "", kind, taskId, risk: commandRisk, toolRunId: toolRun.id }
    });
    sendJson(response, 200, { ...result, toolRunId: toolRun.id });
    return;
  }

  const workspaceTerminalSessionMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/terminal-session$/);
  if (workspaceTerminalSessionMatch && request.method === "POST") {
    const body = await readBody(request);
    const workspaceId = workspaceTerminalSessionMatch[1];
    let workspacePath = "";
    try {
      workspacePath = resolveWorkspacePath(workspaceId, settings);
    } catch (error) {
      sendError(response, error.status || 404, error.message);
      return;
    }
    const taskId = typeof body.taskId === "string" && getTask(body.taskId) ? body.taskId : "";
    const risk = terminalSessionApprovalRisk(workspacePath, settings.security || {});
    const toolRun = createWorkspaceActionToolRun({
      workspaceId,
      taskId,
      toolName: "workspace.terminal_session",
      title: "Workspace terminal session",
      input: {
        workspaceId,
        taskId,
        shell: typeof body.shell === "string" ? body.shell.trim() : "",
        mode: ["auto", "pty", "spawn"].includes(body.mode) ? body.mode : "auto",
        cols: Number(body.cols || 100),
        rows: Number(body.rows || 30),
        risk
      }
    });
    if (risk.required) {
      const approval = requestToolApproval({
        toolRunId: toolRun.id,
        workspaceId,
        taskId,
        kind: "workspace.terminal_session",
        title: "Approve terminal session",
        reason: risk.reasons.join("; "),
        request: { workspaceId, taskId, cwd: workspacePath, mode: body.mode || "auto" },
        risk
      });
      audit(request, url, auth, {
        type: "workspace.terminal_session_approval_required",
        success: false,
        target: workspaceId,
        reason: risk.reasons.join("; "),
        meta: { taskId, approvalId: approval.id, toolRunId: toolRun.id, risk }
      });
      sendJson(response, 428, {
        error: `Terminal session requires explicit approval: ${risk.reasons.join(", ")}`,
        approval,
        approvalId: approval.id,
        toolRun,
        toolRunId: toolRun.id,
        reasons: risk.reasons,
        matches: risk.matches
      });
      return;
    }
    const result = await startWorkspaceTerminalSessionToolRun(toolRun.id, settings);
    audit(request, url, auth, {
      type: "workspace.terminal_session",
      success: Boolean(result.ok),
      target: result.session?.cwd || workspacePath,
      reason: result.ok ? "" : result.error || "Terminal session failed to start",
      meta: { taskId, toolRunId: toolRun.id, session: result.session || null }
    });
    sendJson(response, 202, { ...result, toolRun, toolRunId: toolRun.id });
    return;
  }

  if (url.pathname === "/api/terminal-sessions" && request.method === "GET") {
    sendJson(response, 200, { items: applyFields(listTerminalSessions(), url) });
    return;
  }

  const terminalSessionMatch = url.pathname.match(/^\/api\/terminal-sessions\/([^/]+)$/);
  if (terminalSessionMatch && request.method === "GET") {
    const session = getTerminalSession(terminalSessionMatch[1]);
    if (!session) {
      sendError(response, 404, "Terminal session not found.");
      return;
    }
    sendJson(response, 200, { session });
    return;
  }

  const terminalSessionInputMatch = url.pathname.match(/^\/api\/terminal-sessions\/([^/]+)\/input$/);
  if (terminalSessionInputMatch && request.method === "POST") {
    const body = await readBody(request);
    const toolRunId = terminalSessionInputMatch[1];
    const text = String(body.text || "");
    const result = writeTerminalSession(toolRunId, text);
    if (result.ok) {
      emitToolEvent(toolRunId, { type: "tool.input", text, payload: { session: result.session, bytes: Buffer.byteLength(text, "utf8") } });
      mirrorWorkspaceCommandTaskEvent(toolRunId, "stdin", text, { session: result.session }, `input:${Date.now()}`, "workspace.terminal_session");
    }
    audit(request, url, auth, {
      type: "workspace.terminal_session.input",
      success: Boolean(result.ok),
      target: toolRunId,
      reason: result.ok ? "" : result.error || "Terminal session input failed",
      meta: { toolRunId, bytes: Buffer.byteLength(text, "utf8") }
    });
    sendJson(response, result.ok ? 200 : 409, result);
    return;
  }

  const terminalSessionResizeMatch = url.pathname.match(/^\/api\/terminal-sessions\/([^/]+)\/resize$/);
  if (terminalSessionResizeMatch && request.method === "POST") {
    const body = await readBody(request);
    const toolRunId = terminalSessionResizeMatch[1];
    const result = resizeTerminalSession(toolRunId, body.cols, body.rows);
    if (result.ok) emitToolEvent(toolRunId, { type: "tool.resize", text: `${result.cols}x${result.rows}`, payload: result });
    audit(request, url, auth, {
      type: "workspace.terminal_session.resize",
      success: Boolean(result.ok),
      target: toolRunId,
      reason: result.ok ? "" : result.error || "Terminal session resize failed",
      meta: { toolRunId, cols: body.cols, rows: body.rows }
    });
    sendJson(response, result.ok ? 200 : 409, result);
    return;
  }

  if (url.pathname === "/api/codex-app-server/probe" && request.method === "POST") {
    const result = await runSystemTool({
      toolName: "system.codex_app_server_probe",
      title: "Codex app-server probe",
      input: {},
      request,
      url,
      auth,
      execute: async () => {
        const probe = await runCodexAppServerProbe(settings);
        return { ok: Boolean(probe.ok), result: probe, error: probe.ok ? "" : probe.error || "Codex app-server probe failed." };
      }
    });
    sendJson(response, 200, { ...(result.result || {}), toolRunId: result.toolRunId });
    return;
  }

  if (url.pathname === "/api/codex-desktop/status" && request.method === "GET") {
    const result = await getCodexDesktopStatus();
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/codex-desktop/draft-probe" && request.method === "POST") {
    const body = await readBody(request);
    const text = typeof body.text === "string" ? body.text : "";
    const result = await runSystemTool({
      toolName: "desktop.draft_probe",
      title: "Desktop draft probe",
      input: { textLength: text.length },
      request,
      url,
      auth,
      execute: async () => {
        const probe = await probeCodexDesktopDraft(text);
        return { ok: Boolean(probe.ok), result: probe, error: probe.ok ? "" : probe.error || probe.target?.reason || "Desktop draft probe failed." };
      }
    });
    sendJson(response, 200, { ...(result.result || {}), toolRunId: result.toolRunId });
    return;
  }

  if (url.pathname === "/api/codex-desktop/send" && request.method === "POST") {
    const body = await readBody(request);
    if (!body.prompt || typeof body.prompt !== "string") {
      sendError(response, 400, "Prompt is required");
      return;
    }

    const result = await sendToCodexDesktop(body.prompt);
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/desktop-remote/status" && request.method === "GET") {
    const result = await getDesktopRemoteState({ fresh: url.searchParams.get("fresh") === "1" });
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/desktop-remote/observations" && request.method === "GET") {
    const result = listDesktopObservations({
      after: Number(url.searchParams.get("after") || 0),
      limit: Number(url.searchParams.get("limit") || 100)
    });
    sendJson(response, 200, { items: applyFields(result, url) });
    return;
  }

  if (url.pathname === "/api/desktop-remote/events" && request.method === "GET") {
    const after = Number(url.searchParams.get("after") || request.headers["last-event-id"] || 0);
    subscribeDesktopObserver(response, { after });
    return;
  }

  if (url.pathname === "/api/desktop-remote/messages" && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "desktop.message", { limit: 40, windowMs: 60 * 1000 }, auth)) return;
    const body = await readBody(request);
    if (!body.text || typeof body.text !== "string") {
      audit(request, url, auth, { type: "desktop.message", success: false, reason: "Text is required" });
      sendError(response, 400, "Text is required");
      return;
    }

    const item = enqueueDesktopRemoteMessage(body.text, {
      permissionMode: typeof body.permissionMode === "string" ? body.permissionMode : "",
      model: typeof body.model === "string" ? body.model : "",
      reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : "",
      settingsPolicy: typeof body.settingsPolicy === "string" ? body.settingsPolicy : "useExisting",
      target: body.target && typeof body.target === "object" ? body.target : null
    });
    const state = await getDesktopRemoteState();
    audit(request, url, auth, { type: "desktop.message", success: true, target: item.id, meta: { target: body.target || null } });
    sendJson(response, 202, { ok: true, item, state });
    return;
  }

  if (url.pathname === "/api/desktop-remote/retry" && request.method === "POST") {
    retryDesktopRemoteQueue();
    const state = await getDesktopRemoteState({ fresh: true });
    sendJson(response, 200, state);
    return;
  }

  if (url.pathname === "/api/desktop-remote/clear" && request.method === "POST") {
    clearDesktopRemoteQueue();
    const state = await getDesktopRemoteState();
    sendJson(response, 200, state);
    return;
  }

  if (url.pathname === "/api/desktop-remote/focus" && request.method === "POST") {
    const body = await readBody(request);
    const result = await focusDesktopRemoteConversation(Number(body.index || 0));
    sendJson(response, result.ok ? 200 : 409, result);
    return;
  }

  if (url.pathname === "/api/histories" && request.method === "GET") {
    sendJson(response, 200, { items: applyFields(listHistories({ fresh: url.searchParams.get("fresh") === "1" }), url) });
    return;
  }

  if (url.pathname === "/api/thread-state" && request.method === "GET") {
    sendJson(response, 200, getThreadState());
    return;
  }

  if (url.pathname === "/api/thread-state" && request.method === "POST") {
    const body = await readBody(request);
    const state = updateThreadState(body.key, body.patch || {});
    sendJson(response, 200, state);
    return;
  }

  if (url.pathname === "/api/thread-state/forks" && request.method === "POST") {
    const body = await readBody(request);
    const result = createThreadFork(body);
    sendJson(response, 201, result);
    return;
  }

  const historyMatch = url.pathname.match(/^\/api\/histories\/([^/]+)\/([^/]+)$/);
  if (historyMatch && request.method === "GET") {
    const [, provider, id] = historyMatch;
    const item = getHistory(provider, decodeURIComponent(id), { fresh: url.searchParams.get("fresh") === "1" });
    if (!item) {
      sendError(response, 404, "History not found");
      return;
    }
    sendJson(response, 200, item);
    return;
  }

  if (url.pathname === "/api/tasks" && request.method === "GET") {
    sendJson(response, 200, { items: applyFields(conversationTasks(), url) });
    return;
  }

  if (url.pathname === "/api/tasks" && request.method === "POST") {
    if (!enforceRateLimit(request, response, url, "task.create", { limit: 30, windowMs: 60 * 1000 }, auth)) return;
    const body = await readBody(request);
    const validation = validate(TaskInputSchema, body);
    if (!validation.ok) {
      sendJson(response, 400, { error: "Validation failed", details: validation.issues });
      return;
    }
    const policy = taskSecurityPolicy(body);
    const riskReasons = taskRiskReasons(body, policy);
    const workspace = findWorkspaceForPath(body.cwd || settings.defaultCwd || process.cwd());
    if (isDryRun(url)) {
      sendJson(response, 200, {
        dryRun: true,
        prompt: body.prompt,
        agent: body.agent || "codex",
        cwd: body.cwd || settings.defaultCwd || "",
        approvalRequired: taskApprovalRequired(body, policy),
        risk: { reasons: riskReasons, policy }
      });
      return;
    }
    const taskToolRun = createAgentTaskToolRun({
      workspaceId: workspace?.id || "",
      title: body.title || body.prompt || "Agent task",
      input: {
        payload: {
          ...body,
          security: policy
        },
        prompt: body.prompt || "",
        cwd: body.cwd || settings.defaultCwd || "",
        agent: body.agent || "codex",
        mode: body.mode || "new",
        sessionId: body.sessionId || ""
      },
      risk: { required: taskApprovalRequired(body, policy), reasons: riskReasons, policy }
    });
    if (taskApprovalRequired(body, policy)) {
      const approval = requestToolApproval({
        toolRunId: taskToolRun.id,
        workspaceId: workspace?.id || "",
        kind: "agent.task",
        title: "Approve agent task",
        reason: riskReasons.join("; "),
        request: {
          prompt: body.prompt || "",
          cwd: body.cwd || settings.defaultCwd || "",
          agent: body.agent || "codex",
          mode: body.mode || "new",
          sessionId: body.sessionId || ""
        },
        risk: { required: true, reasons: riskReasons, policy }
      });
      audit(request, url, auth, {
        type: "task.approval_required",
        success: false,
        reason: riskReasons.join("; "),
        meta: { policy, cwd: body.cwd || settings.defaultCwd || "", approvalId: approval.id, toolRunId: taskToolRun.id }
      });
      sendCriticalNotification(settings, {
        type: "approval.required",
        title: "Task approval required",
        body: `${body.agent || "Agent"} task needs approval: ${body.prompt || ""}`.slice(0, 180),
        tag: `approval:${approval.id}`,
        url: "/",
        meta: { approvalId: approval.id, toolRunId: taskToolRun.id, workspaceId: workspace?.id || "" }
      }).catch((error) => {
        recordAuditLog({ type: "notification.error", success: false, reason: error.message, meta: { approvalId: approval.id } });
      });
      sendJson(response, 428, {
        error: `Task requires explicit approval: ${riskReasons.join(", ")}`,
        approval,
        approvalId: approval.id,
        toolRun: taskToolRun,
        toolRunId: taskToolRun.id,
        reasons: riskReasons,
        policy
      });
      return;
    }

    const result = await executeAgentTaskToolRun(taskToolRun.id, settings);
    const task = result.task || { id: result.id, status: result.status };
    audit(request, url, auth, { type: "task.create", success: true, target: task.id, meta: { agent: task.agent, cwd: task.cwd, policy, approved: Boolean(body.approved), riskReasons, toolRunId: taskToolRun.id } });
    sendJson(response, 201, {
      id: task.id,
      status: task.status,
      toolRunId: taskToolRun.id
    });
    return;
  }

  const taskEventsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
  if (taskEventsMatch && request.method === "GET") {
    const after = Number(url.searchParams.get("after") || request.headers["last-event-id"] || 0);
    const ok = subscribeTask(taskEventsMatch[1], response, { after });
    if (!ok) sendError(response, 404, "Task not found");
    return;
  }

  const taskEventsCatchUpMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/events\/catch-up$/);
  if (taskEventsCatchUpMatch && request.method === "GET") {
    const task = getTask(taskEventsCatchUpMatch[1]);
    if (!task) {
      sendError(response, 404, "Task not found");
      return;
    }
    sendJson(response, 200, {
      items: applyFields(listTaskEvents(task.id, {
        after: Number(url.searchParams.get("after") || request.headers["last-event-id"] || 0),
        limit: Number(url.searchParams.get("limit") || 5000)
      }), url)
    });
    return;
  }

  const taskChangesMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/changes$/);
  if (taskChangesMatch && request.method === "GET") {
    const task = getTask(taskChangesMatch[1]);
    if (!task) {
      sendError(response, 404, "Task not found");
      return;
    }
    sendJson(response, 200, await getTaskChanges(task, settings));
    return;
  }

  const taskInputMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/input$/);
  if (taskInputMatch && request.method === "POST") {
    const body = await readBody(request);
    const result = writeTaskInput(taskInputMatch[1], String(body.text || ""));
    sendJson(response, 200, result);
    return;
  }

  const taskStopMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/);
  if (taskStopMatch && request.method === "POST") {
    const ok = stopTask(taskStopMatch[1]);
    sendJson(response, ok ? 200 : 409, { ok });
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && request.method === "GET") {
    const task = getTask(taskMatch[1]);
    if (!task) {
      sendError(response, 404, "Task not found");
      return;
    }
    sendJson(response, 200, {
      id: task.id,
      agent: task.agent,
      title: task.title,
      cwd: task.cwd,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      exitCode: task.exitCode,
      sessionId: task.sessionId,
      commandLabel: task.commandLabel,
      events: task.events
    });
    return;
  }

  sendError(response, 404, "Unknown API route");
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (!isHostAllowed(request, settings)) {
      sendError(response, 403, "Host is not allowed.");
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await routeApi(request, response, url);
      return;
    }

    serveStatic(request, response, url);
  } catch (error) {
    if (response.headersSent || response.writableEnded || response.destroyed) {
      console.error(error.stack || error.message);
      return;
    }
    sendError(response, 500, error.stack || error.message);
  }
});

import { WebSocketServer } from "ws";
import { handleLiveCallAudioConnection } from "./liveCallAudio.js";

server.on("clientError", (error, socket) => {
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {
    // Ignore broken client sockets.
  }
});

server.on("error", (error) => {
  console.error(error.stack || error.message);
});

// WebSocket upgrade handler — only used for /api/live-calls/:id/audio today.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", async (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const match = url.pathname.match(/^\/api\/live-calls\/([^/]+)\/audio$/);
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!isHostAllowed(request, settings)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const auth = authenticateRequest(request, url, settings);
    if (!auth.ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleLiveCallAudioConnection(match[1], ws, { auth, url });
    });
  } catch (error) {
    console.error("[ws] upgrade failed:", error.stack || error.message);
    try {
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    } catch {}
  }
});

scheduleToolEventsPrune();

server.listen(settings.port, settings.host, () => {
  const local = `http://localhost:${settings.port}`;
  console.log(`VibeLink listening on ${local}`);
  console.log(`Pairing token: ${settings.pairingToken}`);
  for (const item of getNetworkAddresses(settings.port)) console.log(`LAN: ${item.url}`);
});
