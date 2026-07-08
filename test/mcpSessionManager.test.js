import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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

test("MCP session caches tools/list results after initialization", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-mcp-session-tools-"));
  const methodLog = path.join(dir, "methods.log");
  const manager = createMcpSessionManager();
  const server = {
    id: "fake-tools-cache",
    name: "fake-tools-cache",
    type: "stdio",
    command: process.execPath,
    env: { FAKE_MCP_METHOD_LOG: methodLog },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const session = await manager.getSession(server, { timeoutMs: 5000 });
    const first = await session.listTools();
    const second = await session.listTools();
    const methods = fs.readFileSync(methodLog, "utf8").trim().split(/\r?\n/);

    assert.deepEqual(first.map((tool) => tool.name), ["echo"]);
    assert.deepEqual(second.map((tool) => tool.name), ["echo"]);
    assert.equal(methods.filter((method) => method === "tools/list").length, 1);
  } finally {
    await manager.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP session manager exposes per-session runtime stats", async () => {
  const manager = createMcpSessionManager();
  const server = {
    id: "fake-stats",
    name: "fake-stats",
    type: "stdio",
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const session = await manager.getSession(server, { timeoutMs: 5000 });
    await session.listTools();

    const stats = manager.stats();
    assert.equal(stats.sessions, 1);
    assert.equal(stats.activeSessions, 1);
    assert.equal(stats.totalPending, 0);
    assert.equal(stats.items.length, 1);
    assert.equal(stats.items[0].id, "fake-stats");
    assert.equal(stats.items[0].closed, false);
    assert.equal(stats.items[0].pending, 0);
    assert.equal(stats.items[0].toolsCached, true);
    assert.equal(stats.items[0].toolCount, 1);
    assert.match(stats.items[0].lastUsedAt, /^\d{4}-\d{2}-\d{2}T/);
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

test("MCP session manager replaces a crashed stdio session", async () => {
  let spawns = 0;
  let firstSpawn = true;
  const manager = createMcpSessionManager({
    spawnFn: (command, args, options = {}) => {
      spawns += 1;
      const env = firstSpawn
        ? { ...(options.env || {}), FAKE_MCP_EXIT_ON_TOOL_CALL: "1" }
        : options.env;
      firstSpawn = false;
      return spawn(command, args, { ...options, env });
    }
  });
  const server = {
    id: "fake-crash",
    name: "fake-crash",
    type: "stdio",
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const firstSession = await manager.getSession(server, { timeoutMs: 5000 });
    await assert.rejects(firstSession.callTool("echo", { q: "crash" }));

    const nextSession = await manager.getSession(server, { timeoutMs: 5000 });
    const result = await nextSession.callTool("echo", { q: "after-crash" });

    assert.equal(spawns, 2);
    assert.notEqual(firstSession, nextSession);
    assert.deepEqual(JSON.parse(result.content[0].text), { name: "echo", arguments: { q: "after-crash" } });
  } finally {
    await manager.closeAll();
  }
});
