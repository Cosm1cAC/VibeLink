#!/usr/bin/env node
/**
 * MCP stdio JSON-RPC server for VibeLink.
 *
 * Usage:
 *   node src/mcp-server.js
 *
 * Or as a subprocess (configured in settings as an MCP server):
 *   command: "node"
 *   args: ["path/to/src/mcp-server.js"]
 *
 * Implements the Model Context Protocol (MCP) 2024-11-05 over stdio.
 * Exposes the VibeLink tool registry as MCP tools.
 */
import { createInterface } from "node:readline";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "vibelink", version: "0.1.0" };
const CAPABILITIES = { tools: {} };

// ── JSON-RPC helpers ──

function jsonRpc(id, result = null, error = null) {
  const msg = { jsonrpc: "2.0", id };
  if (error) msg.error = { code: error.code || -32603, message: error.message || "Internal error" };
  else msg.result = result;
  return msg;
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// ── Core request handler ──

async function handler(method, params) {
  switch (method) {
    // ── Lifecycle ──
    case "initialize":
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO
      };

    case "notifications/initialized":
      return null; // no response needed

    // ── Tools ──
    case "tools/list":
      return { tools: await loadTools() };

    case "tools/call": {
      return await executeToolCall(params);
    }

    // ── Resources ──
    case "resources/list":
      return { resources: [] };

    // ── Prompts ──
    case "prompts/list":
      return { prompts: [] };

    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

// ── Tool loading ──

async function loadTools() {
  // Try to load toolRegistry dynamically; fall back to empty list.
  try {
    const { listToolRegistry } = await import("./toolRegistry.js");
    let mcpTools = [];
    try {
      const db = await import("./db.js");
      mcpTools = db.getCachedMcpTools?.() || [];
    } catch {}
    const defs = listToolRegistry({ mcpTools });
    return defs
      .filter((t) => t.inputSchema)
      .map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema
      }));
  } catch {
    return [];
  }
}

// ── Tool execution ──

async function executeToolCall(params) {
  const name = params?.name || "";
  const args = params?.arguments || {};

  try {
    // Dynamic import to avoid pulling in all deps at startup
    const { getToolDefinition } = await import("./toolRegistry.js");

    const def = getToolDefinition(name);
    if (!def) {
      throw { code: -32602, message: `Unknown tool: ${name}` };
    }

    // Execute the tool through the VibeLink runtime (if available).
    // For now, return the tool metadata as a discovery result.
    // Full execution requires a running VibeLink server instance.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tool: name,
            description: def.description,
            matchedBy: def.matchedBy || "exact",
            note: "Executing this tool requires a running VibeLink server. POST to the HTTP API instead."
          }, null, 2)
        }
      ],
      isError: false
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: error.message || String(error) }],
      isError: true
    };
  }
}

// ── Main loop ──

const rl = createInterface({ input: process.stdin });

// Send server info as first stderr message (visible to the host)
process.stderr.write(`[vibelink-mcp] server ${SERVER_INFO.name} v${SERVER_INFO.version} ready\n`);

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // Malformed JSON — ignore
    return;
  }

  // Notification (no id) — fire and forget
  if (!msg.id) {
    try { await handler(msg.method, msg.params); } catch {}
    return;
  }

  // Request (has id) — must respond
  try {
    const result = await handler(msg.method, msg.params);
    // notifications return null result — don't respond
    if (result !== null) {
      send(jsonRpc(msg.id, result));
    }
  } catch (error) {
    send(jsonRpc(msg.id, null, {
      code: error.code || -32603,
      message: error.message || "Internal error"
    }));
  }
});

rl.on("close", () => {
  // stdin closed — exit gracefully
  process.exit(0);
});

// Handle SIGTERM from host
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
