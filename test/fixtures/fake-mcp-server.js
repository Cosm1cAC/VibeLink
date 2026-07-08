import { createInterface } from "node:readline";
import fs from "node:fs";

const rl = createInterface({ input: process.stdin });

if (process.env.FAKE_MCP_SPAWN_LOG) {
  try {
    fs.appendFileSync(process.env.FAKE_MCP_SPAWN_LOG, "spawn\n", "utf8");
  } catch {
    // Test instrumentation should not affect server behavior.
  }
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendLater(id, result) {
  const delayMs = Number(process.env.FAKE_MCP_RESPONSE_DELAY_MS || 0);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    setTimeout(() => send(id, result), delayMs);
    return;
  }
  send(id, result);
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
  if (process.env.FAKE_MCP_METHOD_LOG) {
    try {
      fs.appendFileSync(process.env.FAKE_MCP_METHOD_LOG, `${message.method}\n`, "utf8");
    } catch {
      // Test instrumentation should not affect server behavior.
    }
  }

  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "fake-mcp", version: "0.0.0" },
      capabilities: { tools: {} }
    });
    return;
  }

  if (message.method === "tools/list") {
    send(message.id, {
      tools: [
        {
          name: "echo",
          description: "Echo arguments.",
          inputSchema: { type: "object" }
        }
      ]
    });
    return;
  }

  if (message.method === "tools/call") {
    sendLater(message.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({ name: message.params?.name, arguments: message.params?.arguments || {} })
        }
      ],
      isError: false
    });
  }
});
