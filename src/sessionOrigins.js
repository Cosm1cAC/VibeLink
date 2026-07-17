import fs from "node:fs";
import path from "node:path";
import { dataDir, tasksDir as defaultTasksDir } from "./config.js";

export const SESSION_ORIGINS = Object.freeze({
  CODEX_DESKTOP: "codex-desktop",
  VIBELINK_CLI: "vibelink-cli",
  UNKNOWN: "unknown"
});

export const SESSION_ORIGIN_FILTERS = new Set(["all", ...Object.values(SESSION_ORIGINS)]);

const DEFAULT_REGISTRY_PATH = path.join(dataDir, "session-origins.json");
const TASK_LOG_PREFIX_BYTES = 1024 * 1024;

function bindingKey(provider, sessionId) {
  return `${String(provider || "").trim()}:${String(sessionId || "").trim()}`;
}

function cleanBinding(value = {}) {
  const provider = String(value.provider || "").trim();
  const sessionId = String(value.sessionId || "").trim();
  const sessionOrigin = String(value.sessionOrigin || "").trim();
  if (!provider || !sessionId || !Object.values(SESSION_ORIGINS).includes(sessionOrigin)) return null;
  return {
    provider,
    sessionId,
    sessionOrigin,
    taskId: String(value.taskId || "").trim(),
    createdAt: String(value.createdAt || "").trim()
  };
}

function readRegistry(registryPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const bindings = new Map();
    for (const value of Object.values(parsed?.items || {})) {
      const binding = cleanBinding(value);
      if (binding) bindings.set(bindingKey(binding.provider, binding.sessionId), binding);
    }
    return { bindings, backfilledAt: String(parsed?.backfilledAt || "") };
  } catch {
    return { bindings: new Map(), backfilledAt: "" };
  }
}

function writeRegistry(registryPath, bindings, backfilledAt = "") {
  const items = {};
  for (const binding of bindings.values()) {
    const cleaned = cleanBinding(binding);
    if (!cleaned) continue;
    items[bindingKey(cleaned.provider, cleaned.sessionId)] = cleaned;
  }

  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, backfilledAt, items }, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, registryPath);
}

function readTaskLogPrefix(filePath) {
  const file = fs.openSync(filePath, "r");
  try {
    const size = Math.min(fs.fstatSync(file).size, TASK_LOG_PREFIX_BYTES);
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(file, buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(file);
  }
}

function taskLogBinding(filePath) {
  let events;
  try {
    events = readTaskLogPrefix(filePath)
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
  } catch {
    return null;
  }

  const start = events.find((event) => /^Starting \w+ in /i.test(event.text || ""));
  const command = events.find((event) => event.type === "system" && event.text && event !== start)?.text || "";
  const launchMode = start?.payload?.launchMode || (/\bexec\s+resume\b/i.test(command) ? "resume" : "new");
  if (launchMode !== "new") return null;

  const sessionId = events.find((event) => event.payload?.thread_id)?.payload?.thread_id || "";
  if (!sessionId) return null;

  const agentFromText = String(start?.text || "").match(/^Starting\s+(\w+)\s+in\s+/i)?.[1] || "";
  return cleanBinding({
    provider: start?.payload?.agent || agentFromText || "codex",
    sessionId,
    sessionOrigin: SESSION_ORIGINS.VIBELINK_CLI,
    taskId: path.basename(filePath).replace(/\.jsonl$/i, ""),
    createdAt: start?.at || ""
  });
}

function backfillTaskBindings(tasksDir, bindings) {
  if (!fs.existsSync(tasksDir)) return bindings;
  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const binding = taskLogBinding(path.join(tasksDir, entry.name));
    if (!binding) continue;
    const key = bindingKey(binding.provider, binding.sessionId);
    if (!bindings.has(key)) bindings.set(key, binding);
  }
  return bindings;
}

export function loadSessionOriginBindings({
  tasksDir = defaultTasksDir,
  registryPath = DEFAULT_REGISTRY_PATH,
  persistBackfill = true
} = {}) {
  const registry = readRegistry(registryPath);
  if (registry.backfilledAt) return registry.bindings;

  const bindings = backfillTaskBindings(tasksDir, registry.bindings);
  if (persistBackfill) writeRegistry(registryPath, bindings, new Date().toISOString());
  return bindings;
}

export function recordSessionOrigin(binding, { registryPath = DEFAULT_REGISTRY_PATH } = {}) {
  const cleaned = cleanBinding({ ...binding, createdAt: binding?.createdAt || new Date().toISOString() });
  if (!cleaned) throw new Error("Invalid session origin binding.");

  const registry = readRegistry(registryPath);
  const key = bindingKey(cleaned.provider, cleaned.sessionId);
  if (registry.bindings.has(key)) return registry.bindings.get(key);
  registry.bindings.set(key, cleaned);
  writeRegistry(registryPath, registry.bindings, registry.backfilledAt);
  return cleaned;
}

export function classifySessionOrigin(item = {}, bindings = new Map()) {
  const explicit = bindings.get(bindingKey(item.provider, item.id || item.sessionId));
  if (explicit?.sessionOrigin) return explicit.sessionOrigin;
  if (item.provider === "codex" && /^Codex Desktop$/i.test(String(item.originator || "").trim())) {
    return SESSION_ORIGINS.CODEX_DESKTOP;
  }
  return SESSION_ORIGINS.UNKNOWN;
}

export function filterBySessionOrigin(items = [], sessionOrigin = "all") {
  if (!sessionOrigin || sessionOrigin === "all") return items;
  return items.filter((item) => item.sessionOrigin === sessionOrigin);
}

export function isSessionOriginFilter(value) {
  return SESSION_ORIGIN_FILTERS.has(String(value || "all"));
}

export function resolveSessionOriginFilter(value) {
  const sessionOrigin = String(value || "all").trim() || "all";
  if (!isSessionOriginFilter(sessionOrigin)) {
    throw new Error(`Unsupported sessionOrigin: ${sessionOrigin}`);
  }
  return sessionOrigin;
}
