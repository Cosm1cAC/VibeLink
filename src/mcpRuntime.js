import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { storeMcpTools, getCachedMcpTools } from "./db.js";
import { codebaseMemoryServerConfig, mergeCodebaseMemoryServer, withCodebaseMemoryPath } from "./codebaseMemoryRuntime.js";
import { createMcpSessionManager } from "./mcpSessionManager.js";
import { createMcpSessionSidecarClient } from "./mcpSessionSidecarClient.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MAX_TOOL_DESCRIPTION = 2048;
const MAX_STDIO_BUFFER = 1024 * 1024;
let persistentMcpSessions = null;
let rustMcpSidecar = null;
let rustMcpSidecarReady = false;
let rustMcpSidecarFailed = false;
const rustMcpSidecarStats = {
  starts: 0,
  failures: 0,
  fallbacks: 0,
  lastFailureAt: "",
  lastError: ""
};

function nowIso() {
  return new Date().toISOString();
}

function compact(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanServerName(value = "") {
  return String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function safeJsonParse(line = "") {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function timeoutError(timeoutMs) {
  const error = new Error(`MCP probe timed out after ${timeoutMs}ms.`);
  error.code = "ETIMEDOUT";
  return error;
}

function withTimeout(promise, timeoutMs, onTimeout = null) {
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(timeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function buildMcpToolName(serverName = "", toolName = "") {
  return `mcp__${cleanServerName(serverName) || "server"}__${cleanServerName(toolName) || "tool"}`;
}

export function configuredMcpServers(settings = {}, discovery = {}) {
  const withAutoMemory = settings.codebaseMemory?.autoMcp === false
    ? settings
    : mergeCodebaseMemoryServer(settings, codebaseMemoryServerConfig(discovery));
  return Array.isArray(withAutoMemory.mcp?.servers)
    ? withAutoMemory.mcp.servers.map((server) => ({
        ...server,
        id: cleanServerName(server.id || server.name),
        name: cleanServerName(server.name || server.id),
        type: server.type || "stdio",
        enabled: server.enabled !== false
      }))
    : [];
}

export function publicMcpServers(settings = {}) {
  return configuredMcpServers(settings).map((server) => ({
    id: server.id,
    name: server.name,
    type: server.type,
    enabled: server.enabled,
    command: server.type === "stdio" ? server.command || "" : "",
    args: server.type === "stdio" ? server.args || [] : [],
    cwd: server.type === "stdio" ? server.cwd || "" : "",
    url: server.type !== "stdio" ? server.url || "" : "",
    envKeys: server.env ? Object.keys(server.env) : [],
    headerKeys: server.headers ? Object.keys(server.headers) : []
  }));
}

function normalizeTool(serverName, tool = {}) {
  const name = cleanServerName(tool.name || "");
  return {
    name,
    fullName: buildMcpToolName(serverName, name),
    title: compact(tool.title || tool.annotations?.title || name, 160),
    description: compact(tool.description || "", MAX_TOOL_DESCRIPTION),
    inputSchema: tool.inputSchema || tool.input_schema || null
  };
}

function jsonRpcMessage(id, method, params = undefined) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params })
  };
}

function initializeParams() {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: "vibelink",
      version: "0.1.0"
    }
  };
}

export function isMcpPersistentSessionsEnabled() {
  return process.env.VIBELINK_MCP_PERSISTENT_SESSIONS === "1";
}

function mcpRustSidecarMode() {
  const mode = String(process.env.VIBELINK_MCP_RUST_SIDECAR || "").trim().toLowerCase();
  if (mode === "auto") return "auto";
  if (/^(1|true|yes|on)$/.test(mode)) return "manual";
  return "off";
}

export function isMcpRustSidecarEnabled() {
  const mode = mcpRustSidecarMode();
  if (mode === "manual") return true;
  if (mode === "auto") return mcpRustSidecarAvailable();
  return false;
}

function mcpSessionManager() {
  if (!persistentMcpSessions) persistentMcpSessions = createMcpSessionManager();
  return persistentMcpSessions;
}

function mcpRustSidecarCommand() {
  if (process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND) return process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND;
  return path.join(
    process.cwd(),
    "apps",
    "windows",
    "target",
    "debug",
    process.platform === "win32" ? "vibelink.exe" : "vibelink"
  );
}

function mcpRustSidecarAvailable() {
  try {
    return fs.existsSync(mcpRustSidecarCommand());
  } catch {
    return false;
  }
}

function mcpRustSidecarArgs() {
  if (!process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON) return ["mcp-session-sidecar"];
  try {
    const parsed = JSON.parse(process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON);
    return Array.isArray(parsed) ? parsed.map(String) : ["mcp-session-sidecar"];
  } catch {
    return ["mcp-session-sidecar"];
  }
}

function mcpRustSidecarClient(timeoutMs = 10000) {
  if (!rustMcpSidecar) {
    rustMcpSidecar = createMcpSessionSidecarClient({
      command: mcpRustSidecarCommand(),
      args: mcpRustSidecarArgs(),
      timeoutMs
    });
    rustMcpSidecarStats.starts += 1;
  }
  return rustMcpSidecar;
}

async function readyMcpRustSidecarClient(timeoutMs = 10000) {
  const client = mcpRustSidecarClient(timeoutMs);
  if (rustMcpSidecarReady) return client;
  const stats = await client.getSessionStats({ timeout: timeoutMs });
  if (!stats || typeof stats !== "object") {
    throw new Error("MCP Rust sidecar readiness check returned an invalid stats payload.");
  }
  rustMcpSidecarReady = true;
  rustMcpSidecarFailed = false;
  rustMcpSidecarStats.lastError = "";
  return client;
}

async function closeRustMcpSidecar() {
  if (!rustMcpSidecar) return;
  const client = rustMcpSidecar;
  rustMcpSidecar = null;
  rustMcpSidecarReady = false;
  await client.close().catch(() => {});
}

export async function closePersistentMcpSessions() {
  if (persistentMcpSessions) {
    await persistentMcpSessions.closeAll();
    persistentMcpSessions = null;
  }
  await closeRustMcpSidecar();
}

export async function closeIdlePersistentMcpSessions(options = {}) {
  let closed = 0;
  let remaining = 0;
  if (persistentMcpSessions) {
    const result = await persistentMcpSessions.closeIdleSessions(options);
    closed += Number(result.closed || 0);
    remaining += Number(result.remaining || 0);
    if (result.remaining === 0) persistentMcpSessions = null;
  }
  if (rustMcpSidecar) {
    const result = await rustMcpSidecar.closeIdleSessions(options).catch(() => ({ closed: 0, remaining: 0 }));
    closed += Number(result.closed || 0);
    remaining += Number(result.remaining || 0);
    if (result.remaining === 0) await closeRustMcpSidecar();
  }
  return { closed, remaining };
}

export function getPersistentMcpSessionStats() {
  return {
    enabled: isMcpPersistentSessionsEnabled(),
    ...(persistentMcpSessions?.stats() || { sessions: 0 })
  };
}

export function getMcpRustSidecarStats() {
  const mode = mcpRustSidecarMode();
  const configured = mode !== "off";
  const enabled = isMcpRustSidecarEnabled();
  return {
    enabled,
    mode,
    auto: mode === "auto",
    available: configured && mcpRustSidecarAvailable(),
    active: configured && Boolean(rustMcpSidecar),
    ready: configured && rustMcpSidecarReady,
    failed: configured && rustMcpSidecarFailed,
    command: configured ? mcpRustSidecarCommand() : "",
    args: configured ? mcpRustSidecarArgs() : [],
    starts: rustMcpSidecarStats.starts,
    failures: rustMcpSidecarStats.failures,
    fallbacks: rustMcpSidecarStats.fallbacks,
    lastFailureAt: rustMcpSidecarStats.lastFailureAt,
    lastError: rustMcpSidecarStats.lastError,
    client: rustMcpSidecar?.stats() || { pending: 0, terminated: true }
  };
}

function parseMcpFullName(fullName = "") {
  const parts = String(fullName || "").split("__");
  if (parts[0] !== "mcp" || parts.length < 3) return { serverId: "", toolName: "" };
  return {
    serverId: parts[1] || "",
    toolName: parts.slice(2).join("__") || ""
  };
}

function selectMcpServer(settings = {}, serverId = "") {
  const target = cleanServerName(serverId || "");
  return configuredMcpServers(settings).find((server) => server.id === target || server.name === target) || null;
}

function mcpTextContent(content = []) {
  return Array.isArray(content)
    ? content.map((item) => item?.text || item?.data || "").filter(Boolean).join("\n")
    : "";
}

async function probeHttpServer(server, timeoutMs, emitProgress) {
  const url = server.url || "";
  if (!url) throw new Error("MCP HTTP server URL is empty.");
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(server.headers || {})
  };
  let nextId = 1;

  async function call(method, params) {
    const body = JSON.stringify(jsonRpcMessage(nextId++, method, params));
    emitProgress?.({ phase: "http.request", method, url });
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${compact(text, 500)}`);
      error.status = response.status;
      throw error;
    }
    const trimmed = text.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith("data:")) {
      const dataLine = trimmed.split(/\r?\n/).find((line) => line.startsWith("data:"));
      return safeJsonParse(dataLine?.slice(5).trim() || "") || {};
    }
    return safeJsonParse(trimmed) || {};
  }

  const initialize = await call("initialize", initializeParams());
  await call("notifications/initialized").catch(() => null);
  const toolsList = await call("tools/list");
  const tools = Array.isArray(toolsList.result?.tools) ? toolsList.result.tools : Array.isArray(toolsList.tools) ? toolsList.tools : [];
  return {
    ok: true,
    transport: "http",
    protocolVersion: initialize.result?.protocolVersion || initialize.protocolVersion || "",
    serverInfo: initialize.result?.serverInfo || initialize.serverInfo || null,
    capabilities: initialize.result?.capabilities || initialize.capabilities || null,
    tools: tools.map((tool) => normalizeTool(server.name, tool))
  };
}

async function callHttpTool(server, toolName, toolArguments, timeoutMs, emitProgress) {
  const url = server.url || "";
  if (!url) throw new Error("MCP HTTP server URL is empty.");
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(server.headers || {})
  };
  let nextId = 1;

  async function call(method, params) {
    const body = JSON.stringify(jsonRpcMessage(nextId++, method, params));
    emitProgress?.({ phase: "http.request", method, url });
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${compact(text, 500)}`);
      error.status = response.status;
      throw error;
    }
    const trimmed = text.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith("data:")) {
      const dataLine = trimmed.split(/\r?\n/).find((line) => line.startsWith("data:"));
      return safeJsonParse(dataLine?.slice(5).trim() || "") || {};
    }
    return safeJsonParse(trimmed) || {};
  }

  await call("initialize", initializeParams());
  await call("notifications/initialized").catch(() => null);
  const response = await call("tools/call", { name: toolName, arguments: toolArguments || {} });
  return response.result || response;
}

async function probeStdioServer(server, timeoutMs, emitProgress) {
  if (!server.command) throw new Error("MCP stdio server command is empty.");
  let nextId = 1;
  let stdout = "";
  let stderr = "";
  let settled = false;
  const pending = new Map();
  const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
    cwd: server.cwd || process.cwd(),
    env: withCodebaseMemoryPath({ ...process.env, ...(server.env || {}) }),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const closeChild = () => {
    try { child.stdin?.end(); } catch {}
    try { child.kill(); } catch {}
  };

  function rejectAll(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function write(message) {
    emitProgress?.({ phase: "stdio.send", method: message.method, id: message.id });
    child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  function request(method, params) {
    const id = nextId++;
    const message = jsonRpcMessage(id, method, params);
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
    });
    write(message);
    return promise;
  }

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > MAX_STDIO_BUFFER) stdout = stdout.slice(-MAX_STDIO_BUFFER);
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      const message = safeJsonParse(line);
      if (message?.id !== undefined && pending.has(message.id)) {
        const pendingRequest = pending.get(message.id);
        pending.delete(message.id);
        emitProgress?.({ phase: "stdio.receive", method: pendingRequest.method, id: message.id });
        if (message.error) pendingRequest.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pendingRequest.resolve(message);
      }
      newline = stdout.indexOf("\n");
    }
  });

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > MAX_STDIO_BUFFER) stderr = stderr.slice(-MAX_STDIO_BUFFER);
    emitProgress?.({ phase: "stdio.stderr", text: compact(chunk.toString(), 500) });
  });

  child.on("error", (error) => rejectAll(error));
  child.on("exit", (code) => {
    if (settled) return;
    rejectAll(new Error(`MCP stdio server exited before probe completed with code ${code ?? "unknown"}.`));
  });

  return withTimeout(
    (async () => {
      const initialize = await request("initialize", initializeParams());
      write(jsonRpcMessage(undefined, "notifications/initialized"));
      const toolsList = await request("tools/list");
      settled = true;
      closeChild();
      const tools = Array.isArray(toolsList.result?.tools) ? toolsList.result.tools : [];
      return {
        ok: true,
        transport: "stdio",
        protocolVersion: initialize.result?.protocolVersion || "",
        serverInfo: initialize.result?.serverInfo || null,
        capabilities: initialize.result?.capabilities || null,
        tools: tools.map((tool) => normalizeTool(server.name, tool)),
        stderr: compact(stderr, 4000)
      };
    })(),
    timeoutMs,
    closeChild
  ).catch((error) => {
    settled = true;
    closeChild();
    error.stderr = stderr;
    throw error;
  });
}

async function probePersistentStdioServer(server, timeoutMs, emitProgress) {
  const session = await mcpSessionManager().getSession(server, { timeoutMs, emitProgress });
  const initialize = await session.initialize({ timeout: timeoutMs, emitProgress });
  const tools = await session.listTools({ timeout: timeoutMs, emitProgress });
  return {
    ok: true,
    transport: "stdio",
    protocolVersion: initialize.protocolVersion || "",
    serverInfo: initialize.serverInfo || null,
    capabilities: initialize.capabilities || null,
    tools: tools.map((tool) => normalizeTool(server.name, tool)),
    stderr: session.stats().stderr || ""
  };
}

async function probeRustSidecarStdioServer(server, timeoutMs, emitProgress) {
  emitProgress?.({ phase: "rust-sidecar.probe", serverId: server.id, name: server.name });
  const client = await readyMcpRustSidecarClient(timeoutMs);
  const result = await client.probeStdioServer(server, { timeoutMs });
  return {
    ok: true,
    transport: "stdio",
    sidecar: "rust",
    protocolVersion: result.protocolVersion || "",
    serverInfo: result.serverInfo || null,
    capabilities: result.capabilities || null,
    tools: (Array.isArray(result.tools) ? result.tools : []).map((tool) => normalizeTool(server.name, tool)),
    stderr: result.stderr || ""
  };
}

async function callStdioTool(server, toolName, toolArguments, timeoutMs, emitProgress) {
  if (!server.command) throw new Error("MCP stdio server command is empty.");
  let nextId = 1;
  let stdout = "";
  let stderr = "";
  let settled = false;
  const pending = new Map();
  const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
    cwd: server.cwd || process.cwd(),
    env: withCodebaseMemoryPath({ ...process.env, ...(server.env || {}) }),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const closeChild = () => {
    try { child.stdin?.end(); } catch {}
    try { child.kill(); } catch {}
  };

  function rejectAll(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function write(message) {
    emitProgress?.({ phase: "stdio.send", method: message.method, id: message.id });
    child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  function request(method, params) {
    const id = nextId++;
    const message = jsonRpcMessage(id, method, params);
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
    });
    write(message);
    return promise;
  }

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > MAX_STDIO_BUFFER) stdout = stdout.slice(-MAX_STDIO_BUFFER);
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      const message = safeJsonParse(line);
      if (message?.id !== undefined && pending.has(message.id)) {
        const pendingRequest = pending.get(message.id);
        pending.delete(message.id);
        emitProgress?.({ phase: "stdio.receive", method: pendingRequest.method, id: message.id });
        if (message.error) pendingRequest.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pendingRequest.resolve(message);
      }
      newline = stdout.indexOf("\n");
    }
  });

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > MAX_STDIO_BUFFER) stderr = stderr.slice(-MAX_STDIO_BUFFER);
    emitProgress?.({ phase: "stdio.stderr", text: compact(chunk.toString(), 500) });
  });

  child.on("error", (error) => rejectAll(error));
  child.on("exit", (code) => {
    if (settled) return;
    rejectAll(new Error(`MCP stdio server exited before tool call completed with code ${code ?? "unknown"}.`));
  });

  return withTimeout(
    (async () => {
      await request("initialize", initializeParams());
      write(jsonRpcMessage(undefined, "notifications/initialized"));
      const response = await request("tools/call", { name: toolName, arguments: toolArguments || {} });
      settled = true;
      closeChild();
      return { result: response.result || response, stderr: compact(stderr, 4000) };
    })(),
    timeoutMs,
    closeChild
  ).catch((error) => {
    settled = true;
    closeChild();
    error.stderr = stderr;
    throw error;
  });
}

async function callPersistentStdioTool(server, toolName, toolArguments, timeoutMs, emitProgress) {
  const session = await mcpSessionManager().getSession(server, { timeoutMs, emitProgress });
  const result = await session.callTool(toolName, toolArguments || {}, { timeout: timeoutMs, emitProgress });
  return { result, stderr: session.stats().stderr || "" };
}

async function callRustSidecarStdioTool(server, toolName, toolArguments, timeoutMs, emitProgress) {
  emitProgress?.({ phase: "rust-sidecar.call", serverId: server.id, name: server.name, toolName });
  const client = await readyMcpRustSidecarClient(timeoutMs);
  const result = await client.callTool(server, toolName, toolArguments || {}, { timeoutMs });
  return { result, stderr: client.stats().stderr || "", sidecar: "rust" };
}

function recordRustSidecarFailure(error) {
  rustMcpSidecarStats.failures += 1;
  rustMcpSidecarStats.fallbacks += 1;
  rustMcpSidecarStats.lastFailureAt = nowIso();
  rustMcpSidecarStats.lastError = compact(error?.message || error, 1000);
  rustMcpSidecarReady = false;
  rustMcpSidecarFailed = true;
}

async function fallbackProbeStdioServer(server, timeoutMs, emitProgress) {
  return isMcpPersistentSessionsEnabled()
    ? probePersistentStdioServer(server, timeoutMs, emitProgress)
    : probeStdioServer(server, timeoutMs, emitProgress);
}

async function fallbackCallStdioTool(server, toolName, toolArguments, timeoutMs, emitProgress) {
  return isMcpPersistentSessionsEnabled()
    ? callPersistentStdioTool(server, toolName, toolArguments, timeoutMs, emitProgress)
    : callStdioTool(server, toolName, toolArguments, timeoutMs, emitProgress);
}

async function probeConfiguredStdioServer(server, timeoutMs, emitProgress) {
  if (!isMcpRustSidecarEnabled()) return fallbackProbeStdioServer(server, timeoutMs, emitProgress);
  try {
    return await probeRustSidecarStdioServer(server, timeoutMs, emitProgress);
  } catch (error) {
    recordRustSidecarFailure(error);
    await closeRustMcpSidecar();
    return fallbackProbeStdioServer(server, timeoutMs, emitProgress);
  }
}

async function callConfiguredStdioTool(server, toolName, toolArguments, timeoutMs, emitProgress) {
  if (!isMcpRustSidecarEnabled()) return fallbackCallStdioTool(server, toolName, toolArguments, timeoutMs, emitProgress);
  try {
    return await callRustSidecarStdioTool(server, toolName, toolArguments, timeoutMs, emitProgress);
  } catch (error) {
    recordRustSidecarFailure(error);
    await closeRustMcpSidecar();
    return fallbackCallStdioTool(server, toolName, toolArguments, timeoutMs, emitProgress);
  }
}

export async function probeMcpServer(server = {}, { timeoutMs = 10000, emitProgress = null } = {}) {
  const startedAt = nowIso();
  const normalized = {
    ...server,
    id: cleanServerName(server.id || server.name),
    name: cleanServerName(server.name || server.id),
    type: server.type || "stdio",
    enabled: server.enabled !== false
  };
  if (!normalized.enabled) {
    return {
      ok: false,
      status: "disabled",
      server: publicMcpServers({ mcp: { servers: [normalized] } })[0],
      error: "MCP server is disabled.",
      tools: [],
      startedAt,
      completedAt: nowIso()
    };
  }

  try {
    const result = normalized.type === "stdio"
      ? await probeConfiguredStdioServer(normalized, timeoutMs, emitProgress)
      : await probeHttpServer(normalized, timeoutMs, emitProgress);
    return {
      ...result,
      ok: true,
      status: "connected",
      server: publicMcpServers({ mcp: { servers: [normalized] } })[0],
      toolCount: result.tools.length,
      startedAt,
      completedAt: nowIso()
    };
  } catch (error) {
    const status = error.status === 401 || error.status === 403 ? "needs-auth" : error.code === "ETIMEDOUT" ? "timeout" : "failed";
    return {
      ok: false,
      status,
      server: publicMcpServers({ mcp: { servers: [normalized] } })[0],
      error: error.message,
      stderr: compact(error.stderr || "", 4000),
      tools: [],
      toolCount: 0,
      startedAt,
      completedAt: nowIso()
    };
  }
}

export async function probeMcpServers(settings = {}, { serverId = "", timeoutMs = 0, emitProgress = null } = {}) {
  const servers = configuredMcpServers(settings).filter((server) => !serverId || server.id === serverId || server.name === serverId);
  const effectiveTimeout = timeoutMs || settings.mcp?.probeTimeoutMs || 10000;
  const results = [];
  for (const server of servers) {
    emitProgress?.({ phase: "server.start", serverId: server.id, name: server.name, type: server.type });
    const result = await probeMcpServer(server, { timeoutMs: effectiveTimeout, emitProgress });
    if (result.ok && result.tools?.length) {
      try { storeMcpTools(result.server?.name || server.name, result.tools); } catch {}
    }
    results.push(result);
    emitProgress?.({ phase: "server.done", serverId: server.id, status: result.status, toolCount: result.toolCount || 0 });
  }
  return {
    ok: results.every((item) => item.ok),
    configured: configuredMcpServers(settings).length,
    probed: results.length,
    results,
    tools: results.flatMap((item) => item.tools || []),
    generatedAt: nowIso()
  };
}

export async function callMcpTool(settings = {}, call = {}, { timeoutMs = 0, emitProgress = null } = {}) {
  const parsed = parseMcpFullName(call.fullName || call.name || "");
  const serverId = call.serverId || parsed.serverId;
  const toolName = call.toolName || parsed.toolName;
  const server = selectMcpServer(settings, serverId);
  const effectiveTimeout = timeoutMs || call.timeoutMs || settings.mcp?.callTimeoutMs || settings.mcp?.probeTimeoutMs || 10000;
  const startedAt = nowIso();

  if (!serverId || !server) {
    return {
      ok: false,
      status: "not-found",
      error: `MCP server not found: ${serverId || "(empty)"}`,
      server: null,
      toolName,
      content: [],
      startedAt,
      completedAt: nowIso()
    };
  }
  if (!toolName) {
    return {
      ok: false,
      status: "invalid-input",
      error: "MCP tool name is required.",
      server: publicMcpServers({ mcp: { servers: [server] } })[0],
      toolName: "",
      content: [],
      startedAt,
      completedAt: nowIso()
    };
  }
  if (server.enabled === false) {
    return {
      ok: false,
      status: "disabled",
      error: "MCP server is disabled.",
      server: publicMcpServers({ mcp: { servers: [server] } })[0],
      toolName,
      content: [],
      startedAt,
      completedAt: nowIso()
    };
  }

  try {
    emitProgress?.({ phase: "tool.call.start", serverId: server.id, name: server.name, toolName });
    const resultEnvelope = server.type === "stdio"
      ? await callConfiguredStdioTool(server, toolName, call.arguments || call.args || {}, effectiveTimeout, emitProgress)
      : { result: await callHttpTool(server, toolName, call.arguments || call.args || {}, effectiveTimeout, emitProgress) };
    const result = resultEnvelope.result || {};
    const content = Array.isArray(result.content) ? result.content : [];
    const ok = result.isError !== true;
    return {
      ok,
      status: ok ? "completed" : "tool-error",
      transport: server.type === "stdio" ? "stdio" : "http",
      server: publicMcpServers({ mcp: { servers: [server] } })[0],
      toolName,
      fullName: buildMcpToolName(server.name, toolName),
      content,
      result,
      error: ok ? "" : compact(mcpTextContent(content) || "MCP tool returned an error.", 1000),
      stderr: resultEnvelope.stderr || "",
      startedAt,
      completedAt: nowIso()
    };
  } catch (error) {
    const status = error.status === 401 || error.status === 403 ? "needs-auth" : error.code === "ETIMEDOUT" ? "timeout" : "failed";
    return {
      ok: false,
      status,
      transport: server.type === "stdio" ? "stdio" : "http",
      server: publicMcpServers({ mcp: { servers: [server] } })[0],
      toolName,
      fullName: buildMcpToolName(server.name, toolName),
      content: [],
      result: null,
      error: error.message,
      stderr: compact(error.stderr || "", 4000),
      startedAt,
      completedAt: nowIso()
    };
  }
}

export function mcpStatus(settings = {}) {
  const servers = publicMcpServers(settings);
  let cachedCount = 0;
  try { cachedCount = getCachedMcpTools().length; } catch {}
  return {
    ok: true,
    configured: servers.length,
    enabled: servers.filter((server) => server.enabled).length,
    servers,
    cachedTools: cachedCount,
    persistentSessions: getPersistentMcpSessionStats(),
    rustSidecar: getMcpRustSidecarStats(),
    probeTimeoutMs: settings.mcp?.probeTimeoutMs || 10000
  };
}
