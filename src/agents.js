import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tasksDir } from "./config.js";
import { insertTaskEvent, listTaskEvents, upsertTask } from "./db.js";
import { resolveAllowedPath } from "./security.js";

const tasks = new Map();
const MAX_RESTORED_TASKS = 80;
let notificationHandler = null;

function nowIso() {
  return new Date().toISOString();
}

function appendTaskEvent(task, event) {
  if (event.payload?.thread_id && !task.sessionId) {
    task.sessionId = event.payload.thread_id;
  }

  const enriched = {
    id: crypto.randomUUID(),
    at: nowIso(),
    ...event
  };

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
    .map((item) => resolveAllowedPath(item, settings));

  const cwd = candidates.find(isDirectory) || process.cwd();
  return {
    cwd,
    requestedCwd: requestedResolved,
    usedFallback: cwd !== requestedResolved
  };
}

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

function quotedPromptArgs(template, prompt) {
  const placeholder = "__MOBILE_AGENT_PROMPT__";
  const safeTemplate = template.includes("{prompt}") ? template.replace("{prompt}", placeholder) : `${template} ${placeholder}`;
  return splitCommandLine(safeTemplate).map((item) => (item === placeholder ? prompt : item));
}

function claudeArgs(payload, settings) {
  const args = ["--print", "--output-format", "stream-json", "--include-partial-messages"];

  if (settings.permissionMode && settings.permissionMode !== "default") {
    args.push("--permission-mode", settings.permissionMode);
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

  if (template) {
    const args = quotedPromptArgs(template, payload.prompt || "");

    if (payload.mode === "resume" && payload.sessionId && !template.includes("{sessionId}")) {
      args.unshift("resume", payload.sessionId);
    }

    return args.map((arg) => arg.replaceAll("{sessionId}", payload.sessionId || ""));
  }

  const common = ["-C", payload.cwd || settings.defaultCwd || process.cwd()];
  if (payload.model) common.push("-m", payload.model);
  if (payload.reasoningEffort) common.push("-c", `model_reasoning_effort="${payload.reasoningEffort}"`);

  if (payload.mode === "resume" && payload.sessionId) {
    const resumeArgs = ["exec", "resume", "--json"];
    if (payload.model) resumeArgs.push("-m", payload.model);
    if (payload.reasoningEffort) resumeArgs.push("-c", `model_reasoning_effort="${payload.reasoningEffort}"`);
    resumeArgs.push("--skip-git-repo-check");
    resumeArgs.push(payload.sessionId, payload.prompt || "");
    return resumeArgs;
  }

  return ["exec", "--json", ...common, payload.prompt || ""];
}

function buildEnv(agent, settings, extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv
  };

  if (agent === "claude" && settings.apiKeys?.anthropic) {
    env.ANTHROPIC_API_KEY = settings.apiKeys.anthropic;
  }

  if (agent === "codex" && settings.apiKeys?.openai) {
    env.OPENAI_API_KEY = settings.apiKeys.openai;
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

export function getTask(id) {
  const task = tasks.get(id);
  if (!task) return null;
  const persistedEvents = listTaskEvents(id, { after: 0, limit: 5000 });
  return {
    ...task,
    events: persistedEvents.length ? persistedEvents : task.events
  };
}

export function createTask(payload, settings) {
  const agent = payload.agent === "codex" ? "codex" : "claude";
  let cwd = "";
  let requestedCwd = "";
  let usedFallback = false;
  let cwdError = null;
  try {
    const resolved = resolveWorkingDir(payload, settings);
    cwd = resolved.cwd;
    requestedCwd = resolved.requestedCwd;
    usedFallback = resolved.usedFallback;
  } catch (error) {
    cwdError = error;
    requestedCwd = payload.cwd || settings.defaultCwd || process.cwd();
    cwd = settings.defaultCwd || process.cwd();
  }
  const id = crypto.randomUUID();
  const logPath = path.join(tasksDir, `${id}.jsonl`);
  const title = (payload.title || payload.prompt || `${agent} task`).slice(0, 96);

  const base =
    agent === "claude"
      ? commandParts(settings.claudeCommand || "claude")
      : resolveCodexCommand(settings.codexCommand || "auto");
  const args =
    agent === "claude"
      ? [...base.args, ...claudeArgs(payload, settings)]
      : [...base.args, ...codexArgs({ ...payload, cwd }, settings)];

  const task = {
    id,
    agent,
    title,
    cwd,
    status: "starting",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    exitCode: null,
    sessionId: payload.sessionId || "",
    commandLabel: commandLabel(base.command, args),
    process: null,
    listeners: new Set(),
    events: [],
    logPath
  };

  tasks.set(id, task);
  upsertTask(task);
  appendTaskEvent(task, { type: "system", text: `Starting ${agent} in ${cwd}` });

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

  try {
    const child = spawn(base.command, args, {
      cwd,
      env: buildEnv(agent, settings, payload.env),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });

    task.process = child;
    task.status = "running";
    task.updatedAt = nowIso();
    upsertTask(task);
    appendTaskEvent(task, { type: "system", text: task.commandLabel });

    child.stdout.on("data", (data) => {
      task.updatedAt = nowIso();
      for (const event of normalizeOutput(data)) appendTaskEvent(task, event);
    });

    child.stderr.on("data", (data) => {
      task.updatedAt = nowIso();
      appendTaskEvent(task, { type: "stderr", text: data.toString() });
    });

    child.on("error", (error) => {
      task.status = "failed";
      task.updatedAt = nowIso();
      upsertTask(task);
      appendTaskEvent(task, { type: "error", text: error.message });
    });

    child.on("close", (code, signal) => {
      task.status = code === 0 ? "done" : "failed";
      task.exitCode = code;
      task.updatedAt = nowIso();
      upsertTask(task);
      appendTaskEvent(task, {
        type: "system",
        text: signal ? `Exited with signal ${signal}` : `Exited with code ${code}`
      });
      notificationHandler?.({
        type: task.status === "done" ? "task.done" : "task.failed",
        title: task.status === "done" ? "Task completed" : "Task failed",
        body: task.title || task.commandLabel || task.id,
        tag: `task:${task.id}`,
        url: "/",
        meta: { taskId: task.id, status: task.status, exitCode: code, signal: signal || "" }
      });
    });
  } catch (error) {
    task.status = "failed";
    task.updatedAt = nowIso();
    upsertTask(task);
    appendTaskEvent(task, { type: "error", text: error.message });
  }

  return task;
}

export function writeTaskInput(id, text) {
  const task = tasks.get(id);
  if (!task || !task.process || task.status !== "running") return { ok: false, reason: "Task is not running." };
  if (!task.process.stdin?.writable) {
    appendTaskEvent(task, {
      type: "error",
      text: "This agent run does not accept live stdin. Send a new message to continue the conversation."
    });
    return { ok: false, reason: "This agent run does not accept live stdin." };
  }
  task.process.stdin.write(`${text}\n`);
  appendTaskEvent(task, { type: "stdin", text });
  return { ok: true };
}

export function stopTask(id) {
  const task = tasks.get(id);
  if (!task || !task.process || task.status !== "running") return false;
  task.process.kill();
  appendTaskEvent(task, { type: "system", text: "Stop requested" });
  return true;
}

export function subscribeTask(id, response, { after = 0 } = {}) {
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

  const historical = listTaskEvents(id, { after: Number(after || 0), limit: 5000 });
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
