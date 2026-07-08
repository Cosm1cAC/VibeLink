import { spawn } from "node:child_process";
import { withCodebaseMemoryPath } from "./codebaseMemoryRuntime.js";

const MAX_STDIO_BUFFER = 1024 * 1024;
const MCP_PROTOCOL_VERSION = "2024-11-05";

function compact(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeJsonParse(line = "") {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
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

function serverKey(server = {}) {
  return JSON.stringify({
    id: server.id || server.name || "",
    name: server.name || server.id || "",
    command: server.command || "",
    args: Array.isArray(server.args) ? server.args : [],
    cwd: server.cwd || "",
    env: server.env || {}
  });
}

function timeoutError(method, timeoutMs) {
  const error = new Error(`MCP session request timed out: ${method} after ${timeoutMs}ms.`);
  error.code = "ETIMEDOUT";
  return error;
}

function maxPendingRequestsValue(value = process.env.VIBELINK_MCP_SESSION_MAX_PENDING_REQUESTS) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 32;
}

function backpressureError(method, maxPendingRequests) {
  const error = new Error(
    `MCP session backpressure: ${method} rejected because ${maxPendingRequests} request(s) are already pending.`
  );
  error.code = "EMCPBACKPRESSURE";
  error.maxPendingRequests = maxPendingRequests;
  return error;
}

function createStdioSession(
  server = {},
  { timeoutMs = 10000, spawnFn = spawn, emitProgress = null, maxPendingRequests = maxPendingRequestsValue() } = {}
) {
  if (!server.command) throw new Error("MCP stdio server command is empty.");

  let nextId = 1;
  let stdout = "";
  let stderr = "";
  let closed = false;
  let initialized = null;
  const pending = new Map();
  const defaultEmitProgress = emitProgress;
  const child = spawnFn(server.command, Array.isArray(server.args) ? server.args : [], {
    cwd: server.cwd || process.cwd(),
    env: withCodebaseMemoryPath({ ...process.env, ...(server.env || {}) }),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });

  function rejectAll(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  function progress(callback, event) {
    try { (callback || defaultEmitProgress)?.(event); } catch {}
  }

  function write(message, callback = null) {
    if (closed) throw new Error("MCP session is closed.");
    progress(callback, { phase: "stdio.send", method: message.method, id: message.id });
    child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  function request(method, params, options = {}) {
    if (closed) return Promise.reject(new Error("MCP session is closed."));
    const { timeout = timeoutMs, emitProgress: requestEmitProgress = null } = options;
    const pendingLimit = maxPendingRequestsValue(options.maxPendingRequests ?? maxPendingRequests);
    if (pending.size >= pendingLimit) return Promise.reject(backpressureError(method, pendingLimit));
    const id = nextId++;
    const message = jsonRpcMessage(id, method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(timeoutError(method, timeout));
      }, Math.max(1, Number(timeout || timeoutMs)));
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, method, emitProgress: requestEmitProgress });
      write(message, requestEmitProgress);
    });
  }

  function notify(method, params, callback = null) {
    write(jsonRpcMessage(undefined, method, params), callback);
  }

  async function ensureInitialized(options = {}) {
    if (!initialized) {
      initialized = (async () => {
        const response = await request("initialize", initializeParams(), options);
        notify("notifications/initialized", undefined, options.emitProgress || null);
        return response.result || response;
      })();
    }
    return initialized;
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
        clearTimeout(pendingRequest.timer);
        progress(pendingRequest.emitProgress, { phase: "stdio.receive", method: pendingRequest.method, id: message.id });
        if (message.error) pendingRequest.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pendingRequest.resolve(message);
      }
      newline = stdout.indexOf("\n");
    }
  });

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > MAX_STDIO_BUFFER) stderr = stderr.slice(-MAX_STDIO_BUFFER);
    const callbacks = new Set([...pending.values()].map((item) => item.emitProgress).filter(Boolean));
    if (callbacks.size === 0) progress(null, { phase: "stdio.stderr", text: compact(chunk.toString(), 500) });
    for (const callback of callbacks) progress(callback, { phase: "stdio.stderr", text: compact(chunk.toString(), 500) });
  });

  child.on("error", (error) => rejectAll(error));
  child.on("exit", (code) => {
    closed = true;
    rejectAll(new Error(`MCP stdio session exited with code ${code ?? "unknown"}.`));
  });

  return {
    async initialize(options = {}) {
      return ensureInitialized(options);
    },
    async listTools(options = {}) {
      await ensureInitialized(options);
      const response = await request("tools/list", undefined, options);
      return Array.isArray(response.result?.tools) ? response.result.tools : [];
    },
    async callTool(name, toolArguments = {}, options = {}) {
      await ensureInitialized(options);
      const response = await request("tools/call", { name, arguments: toolArguments || {} }, options);
      return response.result || response;
    },
    async close() {
      if (closed) return;
      closed = true;
      rejectAll(new Error("MCP session closed."));
      try { child.stdin?.end(); } catch {}
      try { child.kill(); } catch {}
    },
    stats() {
      return {
        closed,
        pending: pending.size,
        maxPendingRequests: maxPendingRequestsValue(maxPendingRequests),
        stderr: compact(stderr, 4000)
      };
    }
  };
}

export function createMcpSessionManager({ spawnFn = spawn } = {}) {
  const sessions = new Map();

  return {
    async getSession(
      server = {},
      { timeoutMs = 10000, emitProgress = null, maxPendingRequests = maxPendingRequestsValue() } = {}
    ) {
      const key = serverKey(server);
      const existing = sessions.get(key);
      if (!existing || existing.stats().closed) {
        sessions.set(key, createStdioSession(server, { timeoutMs, spawnFn, emitProgress, maxPendingRequests }));
      }
      return sessions.get(key);
    },
    async closeAll() {
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.all(active.map((session) => session.close().catch(() => {})));
    },
    stats() {
      return {
        sessions: sessions.size
      };
    }
  };
}
