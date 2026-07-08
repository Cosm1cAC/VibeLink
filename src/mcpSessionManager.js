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

function createStdioSession(server = {}, { timeoutMs = 10000, spawnFn = spawn, emitProgress = null } = {}) {
  if (!server.command) throw new Error("MCP stdio server command is empty.");

  let nextId = 1;
  let stdout = "";
  let stderr = "";
  let closed = false;
  let initialized = null;
  const pending = new Map();
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

  function write(message) {
    if (closed) throw new Error("MCP session is closed.");
    emitProgress?.({ phase: "stdio.send", method: message.method, id: message.id });
    child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  function request(method, params, { timeout = timeoutMs } = {}) {
    if (closed) return Promise.reject(new Error("MCP session is closed."));
    const id = nextId++;
    const message = jsonRpcMessage(id, method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(timeoutError(method, timeout));
      }, Math.max(1, Number(timeout || timeoutMs)));
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, method });
      write(message);
    });
  }

  function notify(method, params) {
    write(jsonRpcMessage(undefined, method, params));
  }

  async function ensureInitialized() {
    if (!initialized) {
      initialized = (async () => {
        const response = await request("initialize", initializeParams());
        notify("notifications/initialized");
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
    closed = true;
    rejectAll(new Error(`MCP stdio session exited with code ${code ?? "unknown"}.`));
  });

  return {
    async listTools() {
      await ensureInitialized();
      const response = await request("tools/list");
      return Array.isArray(response.result?.tools) ? response.result.tools : [];
    },
    async callTool(name, toolArguments = {}) {
      await ensureInitialized();
      const response = await request("tools/call", { name, arguments: toolArguments || {} });
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
        stderr: compact(stderr, 4000)
      };
    }
  };
}

export function createMcpSessionManager({ spawnFn = spawn } = {}) {
  const sessions = new Map();

  return {
    async getSession(server = {}, { timeoutMs = 10000, emitProgress = null } = {}) {
      const key = serverKey(server);
      if (!sessions.has(key)) {
        sessions.set(key, createStdioSession(server, { timeoutMs, spawnFn, emitProgress }));
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
