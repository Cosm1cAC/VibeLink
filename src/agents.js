import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { withAgentReachPath } from "./agentReachRuntime.js";
import { bridgeAgentToolEvent } from "./agentToolBridge.js";
import { withCodebaseMemoryPath } from "./codebaseMemoryRuntime.js";
import { tasksDir } from "./config.js";
import { doubaoAgentArgs, doubaoBridgeCliPath, doubaoCliPath } from "./doubaoRuntime.js";
import { acknowledgeExecutionHostEvents, createApprovalRequest, getDefaultEventReplayLimit, ingestExecutionHostEvent, insertTaskEvent, listTaskEvents, listTaskEventsAsync, resolveEventReplayLimit, settleApprovalContinuation, upsertExecutionBinding, upsertTask } from "./db.js";
import { getExecutionHostFacade } from "./executionHostClient.js";
import { resolveAllowedPath } from "./security.js";
import { settingsWithSecrets } from "./store.js";
import { zhipuAgentArgs, zhipuCliPath } from "./zhipuRuntime.js";

const tasks = new Map();
const MAX_RESTORED_TASKS = 80;
let notificationHandler = null;
let taskScheduler = null;

function nowIso() {
  return new Date().toISOString();
}

function appendTaskEvent(task, event) {
  const sessionId = event.payload?.thread_id || event.payload?.session_id || event.payload?.sessionId;
  if (sessionId && !task.sessionId) {
    task.sessionId = sessionId;
  }

  const enriched = {
    id: crypto.randomUUID(),
    at: nowIso(),
    ...event
  };

  // Auto-classify event kind if not explicitly set.
  if (!enriched.kind) {
    const type = enriched.type || "";
    if (type === "user" || type === "user_message") enriched.kind = "user";
    else if (type === "assistant" || type === "assistant_message") enriched.kind = "assistant";
    else if (type === "system") enriched.kind = "system";
    else if (type === "error") enriched.kind = "error";
    else if (type.startsWith("approval.")) enriched.kind = "approval";
    else if (type.startsWith("tool.")) enriched.kind = "tool";
    else if (type === "stderr" || type === "stdout") enriched.kind = "output";
    else enriched.kind = "system";
  }

  task.events.push(enriched);
  if (task.events.length > 2500) task.events.shift();

  try {
    const cursor = insertTaskEvent(task.id, enriched);
    if (cursor) enriched.cursor = cursor;
    upsertTask(task);
  } catch {
    // Database persistence should never interrupt the agent process.
  }

  try {
    fs.appendFileSync(task.logPath, `${JSON.stringify(enriched)}\n`, "utf8");
  } catch {
    // Logging should never interrupt the agent process.
  }

  for (const listener of task.listeners) listener(enriched);

  try {
    bridgeAgentToolEvent(task, enriched);
  } catch {
    // Tool-event extraction is best-effort and should not interrupt task output.
  }

  return enriched;
}

export function setTaskNotificationHandler(handler) {
  notificationHandler = typeof handler === "function" ? handler : null;
}

function eventTitle(events, fallback) {
  const userEvent = events.find((event) => event.type === "stdin");
  if (userEvent?.text) return userEvent.text.slice(0, 96);

  const commandEvent = events.find((event) => event.type === "system" && !/^Starting \w+ in /i.test(event.text || ""));
  const commandText = commandEvent?.text || "";
  const quotedPrompt = commandText.match(/"([^"]{1,240})"\s*$/)?.[1];
  if (quotedPrompt) return quotedPrompt.slice(0, 96);

  const parts = splitCommandLine(commandText);
  const trailingPrompt = parts.at(-1);
  if (trailingPrompt && !/^(exec|resume|--json|-C)$/i.test(trailingPrompt) && !/[\\/](codex|claude)(\.exe)?$/i.test(trailingPrompt)) {
    return trailingPrompt.slice(0, 96);
  }

  return fallback;
}

function eventStatus(events) {
  const exit = [...events].reverse().find((event) => event.type === "system" && /Exited with (?:code|signal)/i.test(event.text || ""));
  if (!exit) return "done";
  if (/Exited with code 0/i.test(exit.text || "")) return "done";
  return "failed";
}

function eventExitCode(events) {
  const exit = [...events].reverse().find((event) => event.type === "system" && /Exited with code/i.test(event.text || ""));
  const code = exit?.text?.match(/Exited with code (-?\d+)/i)?.[1];
  return code === undefined ? null : Number(code);
}

function inferAgent(events) {
  const command = events.find((event) => event.type === "system" && event.text)?.text || "";
  if (/doubao|doubao-cli/i.test(command)) return "doubao";
  return /claude/i.test(command) && !/codex/i.test(command) ? "claude" : "codex";
}

function inferCwd(events) {
  const start = events.find((event) => event.type === "system" && /^Starting \w+ in /i.test(event.text || ""));
  return start?.text?.replace(/^Starting \w+ in /i, "") || "";
}

function inferResumeSessionId(events) {
  const command = events.find((event) => event.type === "system" && /\bexec\s+resume\b/i.test(event.text || ""))?.text || "";
  const resumeIndex = command.search(/\bresume\b/i);
  const resumeCommand = resumeIndex >= 0 ? command.slice(resumeIndex) : command;
  return resumeCommand.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || "";
}

function restoreTaskFromLog(filePath) {
  const events = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (!events.length) return null;

  const id = path.basename(filePath).replace(/\.jsonl$/i, "");
  const agent = inferAgent(events);
  const commandLabel = events.find((event) => event.type === "system" && !/^Starting \w+ in /i.test(event.text || ""))?.text || "";
  const restored = {
    id,
    agent,
    title: eventTitle(events, `${agent} task`),
    cwd: inferCwd(events),
    status: eventStatus(events),
    createdAt: events[0]?.at || nowIso(),
    updatedAt: events[events.length - 1]?.at || nowIso(),
    exitCode: eventExitCode(events),
    sessionId: events.find((event) => event.payload?.thread_id)?.payload?.thread_id || inferResumeSessionId(events),
    commandLabel,
    process: null,
    listeners: new Set(),
    events,
    logPath: filePath,
    restored: true
  };

  return restored;
}

export function restoreTasks() {
  if (!fs.existsSync(tasksDir)) return;

  const files = fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const filePath = path.join(tasksDir, entry.name);
      return { filePath, mtime: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_RESTORED_TASKS);

  for (const { filePath } of files) {
    try {
      const task = restoreTaskFromLog(filePath);
      if (task) {
        tasks.set(task.id, task);
        upsertTask(task);
        for (const event of task.events) {
          try {
            const cursor = insertTaskEvent(task.id, event);
            if (cursor) event.cursor = cursor;
            bridgeAgentToolEvent(task, event);
          } catch {
            // A single bad event should not prevent task restore.
          }
        }
      }
    } catch {
      // A corrupt task log should not prevent the bridge from starting.
    }
  }
}

function splitCommandLine(input) {
  const args = [];
  let current = "";
  let quote = "";
  let escape = false;

  for (let index = 0; index < input.length; index += 1) {
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
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
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

function commandParts(command) {
  const parts = splitCommandLine(command);
  if (!parts.length) throw new Error("Agent command is empty.");
  return {
    command: parts[0],
    args: parts.slice(1)
  };
}

function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isAbsoluteExecutable(command) {
  return path.isAbsolute(command) || /^[A-Za-z]:[\\/]/.test(command);
}

function commandLabel(command, args) {
  return [command, ...args]
    .map((part) => {
      const value = String(part);
      return /\s/.test(value) ? JSON.stringify(value) : value;
    })
    .join(" ");
}

function windowsAppsCodexAlias(command) {
  return process.platform === "win32" && /\\WindowsApps\\OpenAI\.Codex_/i.test(command);
}

function resolveWorkingDir(payload, settings) {
  const requested = payload.cwd || settings.defaultCwd || process.cwd();
  const requestedResolved = resolveAllowedPath(requested, settings);
  const candidates = [requestedResolved, settings.defaultCwd, process.cwd(), os.homedir()]
    .filter(Boolean)
    .flatMap((item) => {
      try {
        return [resolveAllowedPath(item, settings)];
      } catch {
        return [];
      }
    });

  const cwd = candidates.find(isDirectory) || process.cwd();
  return {
    cwd,
    requestedCwd: requestedResolved,
    usedFallback: cwd !== requestedResolved
  };
}

export const __testInternals = {
  agentLaunchPlan,
  claudeArgs,
  persistentLaunchPayload,
  resolveWorkingDir,
  createOutputNormalizer: (...args) => createOutputNormalizer(...args)
};

function newestExisting(paths) {
  return paths
    .filter(pathExists)
    .map((filePath) => ({
      filePath,
      mtime: fs.statSync(filePath).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.filePath;
}

function findBundledCodexExe() {
  if (process.platform !== "win32") return "";

  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [];
  const openAiBin = path.join(local, "OpenAI", "Codex", "bin");
  const packageBin = path.join(local, "Packages", "OpenAI.Codex_2p2nqsd0c76g0", "LocalCache", "Local", "OpenAI", "Codex", "bin");

  if (pathExists(openAiBin)) {
    for (const entry of fs.readdirSync(openAiBin, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(openAiBin, entry.name, "codex.exe"));
    }
  }

  candidates.push(path.join(packageBin, "codex.exe"));
  return newestExisting(candidates) || "";
}

function resolveCodexCommand(command) {
  const trimmed = (command || "").trim();
  const shouldAuto =
    !trimmed ||
    trimmed === "auto" ||
    (process.platform === "win32" && /^codex(\.exe)?$/i.test(trimmed));

  if (shouldAuto) {
    const bundled = findBundledCodexExe();
    if (bundled) return { command: bundled, args: [] };
  }

  return commandParts(trimmed || "codex");
}

function resolveDoubaoCommand(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed || trimmed === "auto") {
    const bridge = doubaoBridgeCliPath();
    if (pathExists(bridge)) return { command: process.execPath, args: [bridge] };
    return { command: process.execPath, args: [doubaoCliPath()] };
  }
  return commandParts(trimmed);
}

function quotedPromptArgs(template, prompt) {
  const placeholder = "__MOBILE_AGENT_PROMPT__";
  const safeTemplate = template.includes("{prompt}") ? template.replace("{prompt}", placeholder) : `${template} ${placeholder}`;
  return splitCommandLine(safeTemplate).map((item) => (item === placeholder ? prompt : item));
}

function codexApprovalPolicy(value = "") {
  return value === "strict" ? "untrusted" : value;
}

function codexGlobalArgs(payload, settings, policy) {
  const args = ["-C", payload.cwd || settings.defaultCwd || process.cwd()];
  if (payload.model) args.push("-m", payload.model);
  if (payload.reasoningEffort) args.push("-c", `model_reasoning_effort="${payload.reasoningEffort}"`);
  if (policy.sandboxMode) args.push("--sandbox", policy.sandboxMode);
  if (policy.approvalPolicy) args.push("--ask-for-approval", codexApprovalPolicy(policy.approvalPolicy));
  args.push("-c", `sandbox_network_access=${policy.networkAccess ? "true" : "false"}`);
  return args;
}

function claudeArgs(payload, settings) {
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];

  const permissionMode = payload.permissionMode || settings.permissionMode;
  if (permissionMode && permissionMode !== "default") {
    args.push("--permission-mode", permissionMode);
  }

  if (payload.mode === "resume" && payload.sessionId) {
    args.push("--resume", payload.sessionId);
  } else if (payload.mode === "continue") {
    args.push("--continue");
  }

  if (payload.model) args.push("--model", payload.model);
  if (payload.reasoningEffort) args.push("--effort", payload.reasoningEffort);
  if (payload.name) args.push("--name", payload.name);
  args.push(payload.prompt || "");

  return args;
}

function codexArgs(payload, settings) {
  const rawTemplate = payload.template || settings.codexTemplate || "";
  const template = rawTemplate.trim() === "exec {prompt}" ? "" : rawTemplate;
  const policy = securityPolicy(payload, settings);

  if (template) {
    const args = quotedPromptArgs(template, payload.prompt || "");

    if (payload.mode === "resume" && payload.sessionId && !template.includes("{sessionId}")) {
      args.unshift("resume", payload.sessionId);
    }

    return args.map((arg) => arg.replaceAll("{sessionId}", payload.sessionId || ""));
  }

  const globalArgs = codexGlobalArgs(payload, settings, policy);

  if (payload.mode === "resume" && payload.sessionId) {
    const resumeArgs = [...globalArgs, "exec", "resume", "--json"];
    resumeArgs.push("--skip-git-repo-check");
    resumeArgs.push(payload.sessionId, payload.prompt || "");
    return resumeArgs;
  }

  return [...globalArgs, "exec", "--json", payload.prompt || ""];
}

function taskAgent(value = "") {
  if (value === "codex") return "codex";
  if (value === "zhipu") return "zhipu";
  if (value === "doubao") return "doubao";
  return "claude";
}

function agentLaunchPlan(payload, settings) {
  const agent = taskAgent(payload.agent);
  if (agent === "claude") {
    const base = commandParts(settings.claudeCommand || "claude");
    return { agent, base, args: [...base.args, ...claudeArgs(payload, settings)] };
  }
  if (agent === "doubao") {
    const base = resolveDoubaoCommand(settings.doubaoCommand || "auto");
    return { agent, base, args: [...base.args, ...doubaoAgentArgs(payload, settings)] };
  }
  if (agent === "zhipu") {
    const base = { command: process.execPath, args: [zhipuCliPath()] };
    return { agent, base, args: [...base.args, ...zhipuAgentArgs(payload, settings)] };
  }
  const base = resolveCodexCommand(settings.codexCommand || "auto");
  return { agent, base, args: [...base.args, ...codexArgs(payload, settings)] };
}

function securityPolicy(payload, settings) {
  return {
    ...settings.security,
    ...(payload.security || {})
  };
}

function buildEnv(agent, settings, extraEnv = {}) {
  const env = withCodebaseMemoryPath(withAgentReachPath({
    ...process.env,
    ...extraEnv
  }));

  if (agent === "claude" && settings.apiKeys?.anthropic) {
    env.ANTHROPIC_API_KEY = settings.apiKeys.anthropic;
  }

  if (agent === "codex" && settings.apiKeys?.openai) {
    env.OPENAI_API_KEY = settings.apiKeys.openai;
  }

  if (settings.apiKeys?.zhipu) {
    env.ZHIPU_API_KEY = settings.apiKeys.zhipu;
  }

  return env;
}

function textFromJsonEvent(parsed) {
  if (parsed.item?.type === "agent_message") return parsed.item.text || "";
  return (
    parsed.message?.content?.map?.((part) => part.text || "").join("") ||
    parsed.content?.map?.((part) => part.text || "").join("") ||
    parsed.delta?.text ||
    parsed.text ||
    parsed.result ||
    ""
  );
}

function normalizeOutput(data) {
  const raw = data.toString();
  const lines = raw.split(/\r?\n/).filter(Boolean);

  return lines.map((line) => {
    try {
      const parsed = JSON.parse(line);
      const text = textFromJsonEvent(parsed);

      return {
        type: "json",
        text,
        payload: parsed
      };
    } catch {
      return { type: "stdout", text: `${line}\n` };
    }
  });
}

function persistentLaunchPayload(payload = {}) {
  return Object.fromEntries([
    "agent", "title", "prompt", "cwd", "model", "mode", "sessionId", "reasoningEffort",
    "permissionMode", "security", "template", "name"
  ].filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]));
}

function createOutputNormalizer(onEvent) {
  let buffered = "";
  const decoder = new StringDecoder("utf8");
  return {
    write(data) {
      buffered += decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data || ""), "utf8"));
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || "";
      for (const line of lines) {
        if (!line) continue;
        for (const event of normalizeOutput(`${line}\n`)) onEvent(event);
      }
    },
    end() {
      buffered += decoder.end();
      if (!buffered) return;
      for (const event of normalizeOutput(buffered)) onEvent(event);
      buffered = "";
    }
  };
}

const HOST_EXECUTION_STATUSES = new Set(["completed", "failed", "cancelled", "lost", "outcome_unknown"]);

function eventBytes(event = {}) {
  const payload = event.payload || {};
  if (payload.encoding === "base64") return Buffer.from(String(payload.data || ""), "base64");
  return Buffer.from(String(payload.text ?? payload.data ?? ""), "utf8");
}

function queuedResumePayload(task, prompt) {
  const payload = { ...task.launchPayload, prompt };
  if ((task.agent === "codex" || task.agent === "claude") && task.sessionId) {
    payload.mode = "resume";
    payload.sessionId = task.sessionId;
  } else {
    delete payload.mode;
    delete payload.sessionId;
  }
  return payload;
}

async function monitorProviderTurn(task, execution, runtimeSettings) {
  const stderrDecoder = new StringDecoder("utf8");
  const normalizer = createOutputNormalizer((event) => {
    task.updatedAt = nowIso();
    appendTaskEvent(task, event);
  });
  let exit = null;
  try {
    while (!exit) {
      const page = await execution.facade.providerEvents(execution.id, execution.afterHostSeq, 128);
      const events = Array.isArray(page?.events) ? page.events : [];
      for (const hostEvent of events) {
        ingestExecutionHostEvent(execution.id, {
          ...hostEvent,
          executionId: hostEvent.executionId || execution.id,
          eventId: hostEvent.eventId || `${execution.id}:${hostEvent.hostSeq}`,
          at: hostEvent.at || nowIso()
        });
        const event = hostEvent.type === "provider.event" && hostEvent.payload?.type
          ? { ...hostEvent.payload, eventId: hostEvent.eventId, hostSeq: hostEvent.hostSeq, at: hostEvent.payload.at || hostEvent.at }
          : hostEvent;
        execution.afterHostSeq = Math.max(execution.afterHostSeq, Number(event.hostSeq || 0));
        if (event.protocol === "codex-app-server" && event.threadId && !task.sessionId) {
          task.sessionId = event.threadId;
          upsertTask(task);
        }
        if (event.type === "stream.stdout") normalizer.write(eventBytes(event));
        else if (event.type === "stream.stderr") {
          task.updatedAt = nowIso();
          const text = stderrDecoder.write(eventBytes(event));
          if (text) appendTaskEvent(task, { type: "stderr", text });
        } else if (event.type === "provider.approval.required") {
          const payload = event.payload || {};
          const requestId = payload.requestId === undefined ? "" : String(payload.requestId);
          const continuationRef = String(payload.continuationRef || `codex:${event.threadId || ""}:${event.turnId || ""}:${event.itemId || ""}:${requestId}`).slice(0, 2000);
          const approvalId = String(payload.approvalId || `provider:${execution.id}:${requestId}`).slice(0, 160);
          try {
            createApprovalRequest({
              id: approvalId,
              toolRunId: task.toolRunId || "",
              taskId: task.id,
              kind: `provider.${payload.kind || "approval"}`,
              title: "Codex approval required",
              reason: payload.reason || "",
              request: {
                ...(payload.request || payload),
                executionId: execution.id,
                approvalHostSeq: Number(event.hostSeq || 0)
              },
              provider: "codex",
              threadId: event.threadId || "",
              turnId: event.turnId || "",
              itemId: event.itemId || "",
              continuationRef,
              decisionVersion: payload.expectedDecisionVersion || 0,
              requestedPermissions: payload.requestedPermissions,
              availableDecisions: Array.isArray(payload.availableDecisions) ? payload.availableDecisions : []
            });
          } catch {
            // Replayed host events are expected to hit the existing approval row.
          }
          appendTaskEvent(task, { type: "approval.required", payload: { ...payload, approvalId, continuationRef } });
        } else if (["provider.approval.delivered", "provider.approval.applied", "provider.approval.stale"].includes(event.type)) {
          const continuationRef = String(event.payload?.continuationRef || "");
          const status = event.type.slice("provider.approval.".length);
          if (continuationRef) {
            try {
              settleApprovalContinuation(continuationRef, status, {
                reason: event.payload?.reason || "Provider continuation ended before the decision was applied."
              });
            } catch (error) {
              if (error.code !== "OUTBOX_STATE_CONFLICT") throw error;
            }
          }
          appendTaskEvent(task, { type: `approval.${status}`, payload: event.payload || {} });
        } else if (event.type === "execution.exited") exit = event.payload || {};
        else if (event.type === "execution.lost" || event.type === "operation.outcome_unknown") {
          appendTaskEvent(task, { type: "error", text: event.payload?.message || event.type });
        } else if (event.type === "output.truncated") {
          appendTaskEvent(task, { type: "system", text: "Execution host output was truncated." });
        }
      }
      if (execution.afterHostSeq > execution.ackedHostSeq) {
        await execution.facade.acknowledgeProviderEvents(execution.id, execution.afterHostSeq);
        acknowledgeExecutionHostEvents(execution.id, execution.afterHostSeq);
        execution.ackedHostSeq = execution.afterHostSeq;
      }
      if (exit) break;
      const snapshot = await execution.facade.getProvider(execution.id);
      upsertExecutionBinding({
        id: execution.id,
        status: snapshot.status,
        attachState: snapshot.attachState || "attached",
        workerPid: snapshot.workerPid,
        processPid: snapshot.processPid,
        processStartedAt: snapshot.processStartedAt,
        workerInstanceId: snapshot.workerInstanceId,
        capabilities: snapshot.capabilities,
        lastSeenHostSeq: Math.max(Number(snapshot.lastHostSeq || 0), execution.afterHostSeq),
        endedAt: snapshot.endedAt,
        exitCode: snapshot.exitCode,
        signal: snapshot.signal
      });
      if (HOST_EXECUTION_STATUSES.has(snapshot.status)) {
        exit = { exitCode: snapshot.exitCode, signal: snapshot.signal || "", status: snapshot.status };
        break;
      }
      if (!events.length) await new Promise((resolve) => {
        const timer = setTimeout(resolve, 25);
        timer.unref?.();
      });
    }
    normalizer.end();
    const trailingStderr = stderrDecoder.end();
    if (trailingStderr) appendTaskEvent(task, { type: "stderr", text: trailingStderr });
    const exitCode = Number(exit?.exitCode ?? 1);
    if (!task.stopRequested && task.inputQueue.length) {
      const prompt = task.inputQueue.shift();
      appendTaskEvent(task, { type: "system", text: "Turn completed; starting queued resume." });
      await startProviderTurn(task, queuedResumePayload(task, prompt), runtimeSettings, crypto.randomUUID());
      return { status: task.status, exitCode: task.exitCode };
    }
    task.status = exitCode === 0 ? "done" : "failed";
    task.exitCode = exitCode;
    task.updatedAt = nowIso();
    task.execution = null;
    upsertTask(task);
    appendTaskEvent(task, {
      type: "system",
      text: exit?.signal ? `Exited with signal ${exit.signal}` : `Exited with code ${exitCode}`
    });
    notificationHandler?.({
      type: task.status === "done" ? "task.done" : "task.failed",
      title: task.status === "done" ? "Task completed" : "Task failed",
      body: task.title || task.commandLabel || task.id,
      tag: `task:${task.id}`,
      url: "/",
      meta: { taskId: task.id, status: task.status, exitCode, signal: exit?.signal || "" }
    });
    taskScheduler?.settleTask?.(task.id, { status: task.status, exitCode });
    return { status: task.status, exitCode };
  } catch (error) {
    normalizer.end();
    const trailingStderr = stderrDecoder.end();
    if (trailingStderr) appendTaskEvent(task, { type: "stderr", text: trailingStderr });
    task.status = "failed";
    task.updatedAt = nowIso();
    task.execution = null;
    upsertTask(task);
    appendTaskEvent(task, { type: "error", text: error.message });
    taskScheduler?.settleTask?.(task.id, { status: "failed", error: error.message });
    return { status: "failed", error: error.message };
  }
}

async function startProviderTurn(task, payload, runtimeSettings, executionId) {
  const launch = agentLaunchPlan({ ...payload, cwd: task.cwd, agent: task.agent }, runtimeSettings);
  const facade = task.executionFacade;
  if (typeof facade?.startProvider !== "function") {
    const error = new Error("Agent CLI execution requires the configured execution host.");
    error.code = "EXECUTION_HOST_REQUIRED";
    throw error;
  }
  task.commandLabel = commandLabel(launch.base.command, launch.args);
  const useAppServer = task.agent === "codex" && typeof facade.startAppServerProvider === "function";
  const policy = securityPolicy(payload, runtimeSettings);
  const common = {
    executionId,
    command: launch.base.command,
    cwd: task.cwd,
    env: buildEnv(task.agent, runtimeSettings, payload.env)
  };
  const snapshot = useAppServer
    ? await facade.startAppServerProvider({
      ...common,
      args: [...launch.base.args, ...codexGlobalArgs(payload, runtimeSettings, policy)],
      ...(payload.sessionId
        ? { threadResumeParams: { threadId: payload.sessionId, cwd: task.cwd, runtimeWorkspaceRoots: [task.cwd] } }
        : {
            threadStartParams: {
              cwd: task.cwd,
              runtimeWorkspaceRoots: [task.cwd],
              approvalPolicy: codexApprovalPolicy(policy.approvalPolicy || "on-request"),
              sandbox: policy.sandboxMode || "workspace-write",
              threadSource: "appServer",
              ephemeral: false
            }
          }),
      turnStartParams: {
        ...(payload.sessionId ? { threadId: payload.sessionId } : {}),
        input: [{ type: "text", text: payload.prompt || "", text_elements: [] }]
      }
    })
    : await facade.startProvider({ ...common, args: launch.args });
  upsertExecutionBinding({
    id: snapshot.executionId,
    kind: useAppServer ? "provider.appServer" : "provider.cli",
    taskId: task.id,
    toolRunId: task.toolRunId || "",
    provider: task.agent,
    owner: "execution-host",
    status: snapshot.status || "running",
    attachState: snapshot.attachState || "attached",
    workerPid: snapshot.workerPid,
    processPid: snapshot.processPid,
    processStartedAt: snapshot.processStartedAt,
    workerInstanceId: snapshot.workerInstanceId,
    capabilities: snapshot.capabilities || {},
    lastSeenHostSeq: Number(snapshot.lastHostSeq || 0),
    lastIngestedHostSeq: Number(snapshot.lastAckedHostSeq || 0),
    lastAckedHostSeq: Number(snapshot.lastAckedHostSeq || 0)
  });
  task.execution = {
    id: snapshot.executionId,
    facade,
    afterHostSeq: Number(snapshot.lastAckedHostSeq || 0),
    ackedHostSeq: Number(snapshot.lastAckedHostSeq || 0)
  };
  task.status = "running";
  task.updatedAt = nowIso();
  upsertTask(task);
  appendTaskEvent(task, { type: "system", text: task.commandLabel });
  return monitorProviderTurn(task, task.execution, runtimeSettings);
}

export async function restoreTaskExecution(binding, snapshot, settings) {
  const task = tasks.get(binding.taskId);
  if (!task || !snapshot || task.execution) return false;
  const facade = getExecutionHostFacade();
  if (typeof facade?.providerEvents !== "function") return false;
  task.executionFacade = facade;
  task.launchPayload ||= {};
  task.inputQueue ||= [];
  task.stopRequested = false;
  task.execution = {
    id: binding.id,
    facade,
    afterHostSeq: Number(binding.lastAckedHostSeq || 0),
    ackedHostSeq: Number(binding.lastAckedHostSeq || 0)
  };
  task.status = "running";
  task.updatedAt = nowIso();
  upsertTask(task);
  void monitorProviderTurn(task, task.execution, await settingsWithSecrets(settings));
  return true;
}

export function getTasks() {
  return [...tasks.values()]
    .map((task) => ({
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
      eventCount: task.events.length
    }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export function configureTaskScheduler(scheduler) {
  taskScheduler = scheduler || null;
}

export async function executeQueuedTask(job, settings) {
  const payload = job.payload || {};
  const runtimeSettings = await settingsWithSecrets(settings);
  let task = tasks.get(job.taskId);
  if (!task) {
    const agent = taskAgent(payload.agent);
    const { cwd } = resolveWorkingDir(payload, runtimeSettings);
    const launch = agentLaunchPlan({ ...payload, cwd, agent }, runtimeSettings);
    task = {
      id: job.taskId,
      agent,
      title: (payload.title || payload.prompt || `${agent} task`).slice(0, 96),
      cwd,
      status: "queued",
      createdAt: job.createdAt || nowIso(),
      updatedAt: nowIso(),
      exitCode: null,
      sessionId: payload.sessionId || "",
      commandLabel: commandLabel(launch.base.command, launch.args),
      security: securityPolicy(payload, runtimeSettings),
      execution: null,
      listeners: new Set(),
      events: [],
      logPath: path.join(tasksDir, `${job.taskId}.jsonl`)
    };
    tasks.set(task.id, task);
    upsertTask(task);
    appendTaskEvent(task, { type: "system", text: "Restored queued task from SQLite." });
  }
  task.executionFacade = payload.executionHost || getExecutionHostFacade();
  task.launchPayload = { ...payload, executionHost: undefined };
  task.inputQueue ||= [];
  task.stopRequested = false;
  task.status = "starting";
  task.exitCode = null;
  task.updatedAt = nowIso();
  upsertTask(task);
  appendTaskEvent(task, {
    type: "system",
    text: job.attempts > 1 ? `Retry attempt ${job.attempts} of ${job.maxAttempts}.` : "Task claimed by background scheduler."
  });
  try {
    return await startProviderTurn(task, payload, runtimeSettings, crypto.randomUUID());
  } catch (error) {
    task.status = "failed";
    task.updatedAt = nowIso();
    task.execution = null;
    upsertTask(task);
    appendTaskEvent(task, { type: "error", text: error.message });
    return { status: "failed", error: error.message };
  }
}

export function applyTaskQueueTransition(job, detail = {}) {
  const task = tasks.get(job?.taskId);
  if (!task) return;
  if (job.status === "queued") {
    task.status = "queued";
    task.updatedAt = nowIso();
    upsertTask(task);
    if (detail.type === "retry_scheduled") {
      appendTaskEvent(task, { type: "system", text: `Attempt ${job.attempts} failed; retry scheduled for ${job.nextAttemptAt}.` });
    }
  } else if (job.status === "cancelled" && !task.execution) {
    task.status = "cancelled";
    task.updatedAt = nowIso();
    upsertTask(task);
    appendTaskEvent(task, { type: "system", text: "Queued task cancelled." });
  }
}

export function getTask(id) {
  const task = tasks.get(id);
  if (!task) return null;
  const persistedEvents = listTaskEvents(id, { after: 0, limit: getDefaultEventReplayLimit() });
  return {
    ...task,
    events: persistedEvents.length ? persistedEvents : task.events
  };
}

export function appendExternalTaskEvent(id, event = {}) {
  const task = tasks.get(id);
  if (task) {
    task.updatedAt = nowIso();
    return appendTaskEvent(task, event);
  }

  const enriched = {
    id: event.id || crypto.randomUUID(),
    at: event.at || nowIso(),
    ...event
  };

  try {
    const cursor = insertTaskEvent(id, enriched);
    if (cursor) enriched.cursor = cursor;
    return enriched;
  } catch {
    return null;
  }
}

export async function createTask(payload, settings) {
  const agent = taskAgent(payload.agent);
  const runtimeSettings = await settingsWithSecrets(settings);
  const policy = securityPolicy(payload, runtimeSettings);
  let cwd = "";
  let requestedCwd = "";
  let usedFallback = false;
  let cwdError = null;
  try {
    const resolved = resolveWorkingDir(payload, runtimeSettings);
    cwd = resolved.cwd;
    requestedCwd = resolved.requestedCwd;
    usedFallback = resolved.usedFallback;
  } catch (error) {
    cwdError = error;
    requestedCwd = payload.cwd || settings.defaultCwd || process.cwd();
    cwd = runtimeSettings.defaultCwd || process.cwd();
  }
  const id = crypto.randomUUID();
  const logPath = path.join(tasksDir, `${id}.jsonl`);
  const title = (payload.title || payload.prompt || `${agent} task`).slice(0, 96);

  const launch = agentLaunchPlan({ ...payload, cwd, agent }, runtimeSettings);
  const base = launch.base;
  const args = launch.args;

  const task = {
    id,
    agent,
    title,
    cwd,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    exitCode: null,
    sessionId: payload.sessionId || "",
    commandLabel: commandLabel(base.command, args),
    security: policy,
    execution: null,
    executionFacade: payload.executionHost || getExecutionHostFacade(),
    launchPayload: persistentLaunchPayload(payload),
    inputQueue: [],
    stopRequested: false,
    listeners: new Set(),
    events: [],
    logPath
  };

  tasks.set(id, task);
  upsertTask(task);
  appendTaskEvent(task, { type: "system", text: `Starting ${agent} in ${cwd}` });
  appendTaskEvent(task, {
    type: "security",
    text: `Security policy: sandbox=${policy.sandboxMode || "default"}, approval=${policy.approvalPolicy || "default"}, network=${policy.networkAccess ? "enabled" : "disabled"}`
  });

  if (cwdError) {
    task.status = "failed";
    task.updatedAt = nowIso();
    upsertTask(task);
    appendTaskEvent(task, { type: "error", text: cwdError.message || `Directory is outside allowed roots: ${requestedCwd}` });
    return task;
  }

  if (usedFallback) {
    appendTaskEvent(task, {
      type: "system",
      text: `Requested directory does not exist, using ${cwd} instead of ${requestedCwd}`
    });
  }

  if (payload.prompt) {
    appendTaskEvent(task, { type: "stdin", text: payload.prompt });
  }

  if (windowsAppsCodexAlias(base.command)) {
    task.status = "failed";
    task.updatedAt = nowIso();
    upsertTask(task);
    appendTaskEvent(task, {
      type: "error",
      text: "Codex command points to the WindowsApps app alias, which cannot be spawned by the bridge. Set Codex command to auto."
    });
    return task;
  }

  if (isAbsoluteExecutable(base.command) && !pathExists(base.command)) {
    task.status = "failed";
    task.updatedAt = nowIso();
    upsertTask(task);
    appendTaskEvent(task, { type: "error", text: `Agent executable not found: ${base.command}` });
    return task;
  }

  if (taskScheduler) {
    taskScheduler.enqueue({ taskId: task.id, payload: task.launchPayload, priority: payload.priority, maxAttempts: payload.maxAttempts });
    appendTaskEvent(task, { type: "system", text: "Task added to the persistent execution queue." });
  } else {
    void startProviderTurn(task, payload, runtimeSettings, id).catch((error) => {
      task.status = "failed";
      task.updatedAt = nowIso();
      upsertTask(task);
      appendTaskEvent(task, { type: "error", text: error.message });
    });
  }

  return task;
}

export function writeTaskInput(id, text) {
  const task = tasks.get(id);
  const prompt = String(text || "");
  if (!task || !task.execution || task.status !== "running") return { ok: false, reason: "Task is not running." };
  if (!prompt.trim()) return { ok: false, reason: "Input is required." };
  task.inputQueue.push(prompt);
  appendTaskEvent(task, { type: "stdin", text });
  appendTaskEvent(task, { type: "system", text: "Input queued for the next resume turn." });
  return { ok: true, queued: true, queueLength: task.inputQueue.length };
}

export async function stopTask(id) {
  const task = tasks.get(id);
  if (task?.status === "queued" && taskScheduler) {
    return taskScheduler.cancel(id)?.status === "cancelled";
  }
  if (!task || !task.execution || task.status !== "running") return false;
  task.stopRequested = true;
  task.inputQueue.length = 0;
  taskScheduler?.cancelRunning?.(id);
  try {
    await task.execution.facade.signalProvider(task.execution.id, "stop", "task stopped by user");
  } catch (error) {
    if (error.code === "EXECUTION_STATE_CONFLICT") return false;
    throw error;
  }
  appendTaskEvent(task, { type: "system", text: "Stop requested" });
  return true;
}

export async function subscribeTask(id, response, { after = 0 } = {}) {
  const task = tasks.get(id);
  if (!task) return false;

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const send = (event) => {
    if (event.cursor) response.write(`id: ${event.cursor}\n`);
    response.write(`event: task\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const historical = await listTaskEventsAsync(id, { after: Number(after || 0), limit: resolveEventReplayLimit(undefined) });
  for (const event of historical.length ? historical : task.events.filter((event) => Number(event.cursor || 0) > Number(after || 0))) send(event);
  task.listeners.add(send);

  const ping = setInterval(() => {
    response.write(`event: ping\ndata: {}\n\n`);
  }, 25000);

  response.on("close", () => {
    clearInterval(ping);
    task.listeners.delete(send);
  });

  return true;
}
