import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMcpSessionManager } from "../src/mcpSessionManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("MCP session manager reuses one stdio child for repeated requests", async () => {
  let spawns = 0;
  const manager = createMcpSessionManager({
    spawnFn: (...args) => {
      spawns += 1;
      return spawn(...args);
    }
  });
  const server = {
    id: "fake",
    name: "fake",
    type: "stdio",
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const session = await manager.getSession(server, { timeoutMs: 5000 });
    const tools = await session.listTools();
    const result = await session.callTool("echo", { q: "hello" });
    const again = await manager.getSession(server, { timeoutMs: 5000 });
    const second = await again.callTool("echo", { q: "again" });

    assert.equal(spawns, 1);
    assert.equal(session, again);
    assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);
    assert.deepEqual(JSON.parse(result.content[0].text), { name: "echo", arguments: { q: "hello" } });
    assert.deepEqual(JSON.parse(second.content[0].text), { name: "echo", arguments: { q: "again" } });
  } finally {
    await manager.closeAll();
  }
});
