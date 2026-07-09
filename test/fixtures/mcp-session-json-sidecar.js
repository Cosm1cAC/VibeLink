import { createInterface } from "node:readline";

import { MCP_SESSION_CONTRACT_METHODS, serializeMcpSessionError } from "../../src/mcpSessionContract.js";
import { createMcpSessionManager } from "../../src/mcpSessionManager.js";

const rl = createInterface({ input: process.stdin });
const manager = createMcpSessionManager();

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function sendError(id, error) {
  process.stdout.write(`${JSON.stringify({ id, error: serializeMcpSessionError(error) })}\n`);
}

function sidecarMethodError(method) {
  return new Error(`Unsupported MCP session sidecar method: ${method}`);
}

function sessionOptions(options = {}) {
  const timeoutMs = Number(options?.timeoutMs || options?.timeout || 10000);
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000,
    maxPendingRequests: options?.maxPendingRequests
  };
}

function requestOptions(options = {}) {
  const timeout = Number(options?.timeout || options?.timeoutMs || 10000);
  return {
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 10000,
    maxPendingRequests: options?.maxPendingRequests
  };
}

async function sessionFor(server, options = {}) {
  return manager.getSession(server, sessionOptions(options));
}

async function handle(method, args = []) {
  if (!MCP_SESSION_CONTRACT_METHODS.includes(method)) throw sidecarMethodError(method);
  if (method === "probeStdioServer") {
    const [server, options = {}] = args;
    const session = await sessionFor(server, options);
    const initialize = await session.initialize(requestOptions(options));
    const tools = await session.listTools(requestOptions(options));
    return {
      ok: true,
      transport: "stdio",
      protocolVersion: initialize.protocolVersion || "",
      serverInfo: initialize.serverInfo || null,
      capabilities: initialize.capabilities || null,
      tools,
      stderr: session.stats().stderr || ""
    };
  }
  if (method === "listTools") {
    const [server, options = {}] = args;
    const session = await sessionFor(server, options);
    return session.listTools(requestOptions(options));
  }
  if (method === "callTool") {
    const [server, toolName, toolArguments = {}, options = {}] = args;
    const session = await sessionFor(server, options);
    return session.callTool(toolName, toolArguments || {}, requestOptions(options));
  }
  if (method === "closeIdleSessions") {
    const [options = {}] = args;
    return manager.closeIdleSessions(options);
  }
  if (method === "closeAll") {
    await manager.closeAll();
    return { ok: true };
  }
  return manager.stats();
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let message = null;
  try {
    message = JSON.parse(line);
  } catch (error) {
    sendError(null, error);
    return;
  }

  if (message.method === "__close") {
    try {
      await manager.closeAll();
      send(message.id, { ok: true });
    } finally {
      setTimeout(() => process.exit(0), 0);
    }
    return;
  }

  try {
    send(message.id, await handle(message.method, message.args || []));
  } catch (error) {
    sendError(message.id, error);
  }
});
