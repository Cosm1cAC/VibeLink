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

test("MCP session manager rejects requests above the pending cap", async () => {
  let spawns = 0;
  const manager = createMcpSessionManager({
    spawnFn: (...args) => {
      spawns += 1;
      return spawn(...args);
    }
  });
  const server = {
    id: "fake-backpressure",
    name: "fake-backpressure",
    type: "stdio",
    command: process.execPath,
    env: { FAKE_MCP_RESPONSE_DELAY_MS: "100" },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const session = await manager.getSession(server, { timeoutMs: 5000, maxPendingRequests: 1 });
    const first = session.callTool("echo", { q: "first" });
    await assert.rejects(
      session.callTool("echo", { q: "second" }),
      (error) => error.code === "EMCPBACKPRESSURE"
    );
    const result = await first;

    assert.equal(spawns, 1);
    assert.deepEqual(JSON.parse(result.content[0].text), { name: "echo", arguments: { q: "first" } });
  } finally {
    await manager.closeAll();
  }
});

test("MCP session manager replaces a closed stdio session", async () => {
  let spawns = 0;
  const manager = createMcpSessionManager({
    spawnFn: (...args) => {
      spawns += 1;
      return spawn(...args);
    }
  });
  const server = {
    id: "fake-restart",
    name: "fake-restart",
    type: "stdio",
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const firstSession = await manager.getSession(server, { timeoutMs: 5000 });
    const first = await firstSession.callTool("echo", { q: "before-close" });
    await firstSession.close();

    const nextSession = await manager.getSession(server, { timeoutMs: 5000 });
    const second = await nextSession.callTool("echo", { q: "after-close" });

    assert.equal(spawns, 2);
    assert.notEqual(firstSession, nextSession);
    assert.deepEqual(JSON.parse(first.content[0].text), { name: "echo", arguments: { q: "before-close" } });
    assert.deepEqual(JSON.parse(second.content[0].text), { name: "echo", arguments: { q: "after-close" } });
  } finally {
    await manager.closeAll();
  }
});
