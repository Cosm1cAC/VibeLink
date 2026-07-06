import { spawn } from "node:child_process";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MAX_TOOL_DESCRIPTION = 2048;
const MAX_STDIO_BUFFER = 1024 * 1024;

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

export function configuredMcpServers(settings = {}) {
  return Array.isArray(settings.mcp?.servers)
    ? settings.mcp.servers.map((server) => ({
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

async function probeStdioServer(server, timeoutMs, emitProgress) {
  if (!server.command) throw new Error("MCP stdio server command is empty.");
  let nextId = 1;
  let stdout = "";
  let stderr = "";
  let settled = false;
  const pending = new Map();
  const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
    cwd: server.cwd || process.cwd(),
    env: { ...process.env, ...(server.env || {}) },
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
      ? await probeStdioServer(normalized, timeoutMs, emitProgress)
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

export function mcpStatus(settings = {}) {
  const servers = publicMcpServers(settings);
  return {
    ok: true,
    configured: servers.length,
    enabled: servers.filter((server) => server.enabled).length,
    servers,
    probeTimeoutMs: settings.mcp?.probeTimeoutMs || 10000
  };
}
