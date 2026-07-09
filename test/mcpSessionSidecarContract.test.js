import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMcpSessionSidecarClient } from "../src/mcpSessionSidecarClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function cargoPath() {
  if (process.platform === "win32") {
    const result = spawnSync("where.exe", ["cargo"], { encoding: "utf8", windowsHide: true });
    return result.status === 0 ? String(result.stdout || "").split(/\r?\n/).find(Boolean) || "" : "";
  }
  const result = spawnSync("sh", ["-lc", "command -v cargo"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout || "").trim().split(/\r?\n/)[0] || "" : "";
}

function rustSidecarClient(t, options = {}) {
  const cargo = cargoPath();
  if (!cargo) t.skip("cargo is not available");
  return createMcpSessionSidecarClient({
    command: cargo,
    args: [
      "run",
      "--quiet",
      "--manifest-path",
      path.join(process.cwd(), "apps", "windows", "Cargo.toml"),
      "--",
      "mcp-session-sidecar"
    ],
    timeoutMs: 10000,
    ...options
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("MCP session JSON sidecar contract reuses stdio sessions for probe and calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-mcp-session-sidecar-"));
  const spawnLog = path.join(dir, "spawns.log");
  const methodLog = path.join(dir, "methods.log");
  const client = createMcpSessionSidecarClient({
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "mcp-session-json-sidecar.js")],
    timeoutMs: 5000
  });
  const server = {
    id: "fake-sidecar",
    name: "fake-sidecar",
    type: "stdio",
    command: process.execPath,
    env: {
      FAKE_MCP_SPAWN_LOG: spawnLog,
      FAKE_MCP_METHOD_LOG: methodLog
    },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const probe = await client.probeStdioServer(server, { timeoutMs: 5000 });
    const first = await client.callTool(server, "echo", { q: "first" }, { timeoutMs: 5000 });
    const second = await client.callTool(server, "echo", { q: "second" }, { timeoutMs: 5000 });
    const remoteStats = await client.getSessionStats();
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const methods = fs.readFileSync(methodLog, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.equal(probe.ok, true);
    assert.equal(probe.transport, "stdio");
    assert.deepEqual(probe.tools.map((tool) => tool.name), ["echo"]);
    assert.deepEqual(JSON.parse(first.content[0].text), { name: "echo", arguments: { q: "first" } });
    assert.deepEqual(JSON.parse(second.content[0].text), { name: "echo", arguments: { q: "second" } });
    assert.equal(spawns.length, 1);
    assert.equal(methods.filter((method) => method === "tools/list").length, 1);
    assert.equal(remoteStats.sessions, 1);
    assert.equal(remoteStats.activeSessions, 1);
    assert.equal(client.stats().pending, 0);
    await assert.rejects(
      client.request("missingMethod", []),
      /Unsupported MCP session sidecar method: missingMethod/
    );
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP session JSON sidecar contract works against the Rust sidecar", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-rust-mcp-session-sidecar-"));
  const spawnLog = path.join(dir, "spawns.log");
  const methodLog = path.join(dir, "methods.log");
  const client = rustSidecarClient(t);
  const server = {
    id: "fake-rust-sidecar",
    name: "fake-rust-sidecar",
    type: "stdio",
    command: process.execPath,
    env: {
      FAKE_MCP_SPAWN_LOG: spawnLog,
      FAKE_MCP_METHOD_LOG: methodLog
    },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const probe = await client.probeStdioServer(server, { timeoutMs: 10000 });
    const result = await client.callTool(server, "echo", { q: "rust" }, { timeoutMs: 10000 });
    const remoteStats = await client.getSessionStats();
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const methods = fs.readFileSync(methodLog, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.equal(probe.ok, true);
    assert.equal(probe.transport, "stdio");
    assert.deepEqual(probe.tools.map((tool) => tool.name), ["echo"]);
    assert.deepEqual(JSON.parse(result.content[0].text), { name: "echo", arguments: { q: "rust" } });
    assert.equal(spawns.length, 1);
    assert.equal(methods.filter((method) => method === "tools/list").length, 1);
    assert.equal(remoteStats.sessions, 1);
    assert.equal(remoteStats.activeSessions, 1);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust MCP session sidecar handles a burst of queued tool calls", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-rust-mcp-session-burst-"));
  const spawnLog = path.join(dir, "spawns.log");
  const client = rustSidecarClient(t, { maxPendingRequests: 16 });
  const server = {
    id: "fake-rust-sidecar-burst",
    name: "fake-rust-sidecar-burst",
    type: "stdio",
    command: process.execPath,
    env: {
      FAKE_MCP_SPAWN_LOG: spawnLog,
      FAKE_MCP_RESPONSE_DELAY_MS: "10"
    },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const calls = Array.from({ length: 8 }, (_, index) =>
      client.callTool(server, "echo", { index }, { timeoutMs: 10000 })
    );
    const results = await Promise.all(calls);
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.deepEqual(
      results.map((result) => JSON.parse(result.content[0].text).arguments.index),
      [0, 1, 2, 3, 4, 5, 6, 7]
    );
    assert.equal(spawns.length, 1);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust MCP session sidecar reports multi-server burst metrics", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-rust-mcp-session-multi-burst-"));
  const firstSpawnLog = path.join(dir, "first-spawns.log");
  const secondSpawnLog = path.join(dir, "second-spawns.log");
  const client = rustSidecarClient(t, { maxPendingRequests: 32 });
  const firstServer = {
    id: "fake-rust-sidecar-multi-a",
    name: "fake-rust-sidecar-multi-a",
    type: "stdio",
    command: process.execPath,
    env: {
      FAKE_MCP_SPAWN_LOG: firstSpawnLog,
      FAKE_MCP_RESPONSE_DELAY_MS: "5"
    },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };
  const secondServer = {
    id: "fake-rust-sidecar-multi-b",
    name: "fake-rust-sidecar-multi-b",
    type: "stdio",
    command: process.execPath,
    env: {
      FAKE_MCP_SPAWN_LOG: secondSpawnLog,
      FAKE_MCP_RESPONSE_DELAY_MS: "5"
    },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const calls = [];
    for (let index = 0; index < 6; index += 1) {
      calls.push(client.callTool(firstServer, "echo", { server: "a", index }, { timeoutMs: 10000 }));
      calls.push(client.callTool(secondServer, "echo", { server: "b", index }, { timeoutMs: 10000 }));
    }

    const results = await Promise.all(calls);
    const stats = await client.getSessionStats();
    const first = stats.items.find((entry) => entry.id === "fake-rust-sidecar-multi-a");
    const second = stats.items.find((entry) => entry.id === "fake-rust-sidecar-multi-b");
    const firstSpawns = fs.readFileSync(firstSpawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const secondSpawns = fs.readFileSync(secondSpawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.equal(results.length, 12);
    assert.equal(stats.sessions, 2);
    assert.equal(stats.activeSessions, 2);
    assert.equal(stats.totalRequests >= 14, true);
    assert.equal(stats.totalResponses >= 14, true);
    assert.equal(stats.totalFailures, 0);
    assert.equal(stats.totalTimeouts, 0);
    assert.equal(stats.totalBackpressureRejects, 0);
    assert.equal(first.requests >= 7, true);
    assert.equal(second.requests >= 7, true);
    assert.equal(first.maxPendingObserved >= 1, true);
    assert.equal(second.maxPendingObserved >= 1, true);
    assert.equal(firstSpawns.length, 1);
    assert.equal(secondSpawns.length, 1);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust MCP session sidecar times out slow stdio requests and reports counters", async (t) => {
  const client = rustSidecarClient(t, { timeoutMs: 1000 });
  const server = {
    id: "fake-rust-sidecar-timeout",
    name: "fake-rust-sidecar-timeout",
    type: "stdio",
    command: process.execPath,
    env: { FAKE_MCP_RESPONSE_DELAY_MS: "200" },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    await client.probeStdioServer(server, { timeoutMs: 1000 });
    await assert.rejects(
      client.callTool(server, "echo", { q: "timeout" }, { timeoutMs: 50 }),
      /timed out/i
    );
    const stats = await client.getSessionStats();
    const item = stats.items.find((entry) => entry.id === "fake-rust-sidecar-timeout");

    assert.equal(item.timeouts, 1);
    assert.equal(item.failures, 1);
  } finally {
    await client.close();
  }
});

test("Rust MCP session sidecar serves stats while a tool call is in flight", async (t) => {
  const client = rustSidecarClient(t);
  const server = {
    id: "fake-rust-sidecar-inflight-stats",
    name: "fake-rust-sidecar-inflight-stats",
    type: "stdio",
    command: process.execPath,
    env: { FAKE_MCP_RESPONSE_DELAY_MS: "500" },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const slowCall = client.callTool(server, "echo", { q: "slow" }, { timeoutMs: 10000 });
    await sleep(75);

    const startedAt = Date.now();
    const stats = await client.getSessionStats();
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 500, `expected stats before slow call completed, got ${elapsedMs}ms`);
    assert.ok(stats.activeRequests >= 1, `expected activeRequests >= 1, got ${stats.activeRequests}`);
    assert.ok(stats.maxActiveObserved >= 1, `expected maxActiveObserved >= 1, got ${stats.maxActiveObserved}`);

    const result = await slowCall;
    assert.deepEqual(JSON.parse(result.content[0].text), { name: "echo", arguments: { q: "slow" } });
  } finally {
    await client.close();
  }
});

test("Rust MCP session sidecar rejects calls over the global active request cap", async (t) => {
  const client = rustSidecarClient(t, {
    env: {
      ...process.env,
      VIBELINK_MCP_SESSION_SIDECAR_MAX_ACTIVE_REQUESTS: "1"
    }
  });
  const slowServer = {
    id: "fake-rust-sidecar-cap-a",
    name: "fake-rust-sidecar-cap-a",
    type: "stdio",
    command: process.execPath,
    env: { FAKE_MCP_RESPONSE_DELAY_MS: "500" },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };
  const secondServer = {
    id: "fake-rust-sidecar-cap-b",
    name: "fake-rust-sidecar-cap-b",
    type: "stdio",
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const slowCall = client.callTool(slowServer, "echo", { q: "slow" }, { timeoutMs: 10000 });
    await sleep(75);

    await assert.rejects(
      client.callTool(secondServer, "echo", { q: "rejected" }, { timeoutMs: 10000 }),
      /backpressure/i
    );

    const result = await slowCall;
    assert.deepEqual(JSON.parse(result.content[0].text), { name: "echo", arguments: { q: "slow" } });

    const stats = await client.getSessionStats();
    assert.equal(stats.sidecarBackpressureRejects, 1);
    assert.equal(stats.maxActiveRequests, 1);
    assert.ok(stats.maxActiveObserved >= 1);
  } finally {
    await client.close();
  }
});

test("Rust MCP session sidecar replaces a crashed stdio session", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-rust-mcp-session-restart-"));
  const spawnLog = path.join(dir, "spawns.log");
  const onceFile = path.join(dir, "once.txt");
  const client = rustSidecarClient(t);
  const server = {
    id: "fake-rust-sidecar-restart",
    name: "fake-rust-sidecar-restart",
    type: "stdio",
    command: process.execPath,
    env: {
      FAKE_MCP_SPAWN_LOG: spawnLog,
      FAKE_MCP_EXIT_ON_TOOL_CALL_ONCE_FILE: onceFile
    },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    await assert.rejects(client.callTool(server, "echo", { q: "crash" }, { timeoutMs: 10000 }));
    const result = await client.callTool(server, "echo", { q: "after-crash" }, { timeoutMs: 10000 });
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.deepEqual(JSON.parse(result.content[0].text), { name: "echo", arguments: { q: "after-crash" } });
    assert.equal(spawns.length, 2);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP session sidecar client rejects requests above the pending cap", async () => {
  const client = createMcpSessionSidecarClient({
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "mcp-session-json-sidecar.js")],
    timeoutMs: 5000,
    maxPendingRequests: 1
  });
  const server = {
    id: "fake-sidecar-backpressure",
    name: "fake-sidecar-backpressure",
    type: "stdio",
    command: process.execPath,
    env: { FAKE_MCP_RESPONSE_DELAY_MS: "100" },
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
  };

  try {
    const first = client.callTool(server, "echo", { q: "first" }, { timeoutMs: 5000 });
    await assert.rejects(
      client.callTool(server, "echo", { q: "second" }, { timeoutMs: 5000 }),
      (error) => error.code === "EMCPSESSIONBACKPRESSURE"
    );
    const rejectedStats = client.stats();
    assert.equal(rejectedStats.pending, 1);
    assert.equal(rejectedStats.requests, 1);
    assert.equal(rejectedStats.backpressureRejects, 1);
    assert.equal(rejectedStats.maxPendingObserved, 1);
    assert.equal(Boolean(rejectedStats.lastBackpressureAt), true);
    const result = await first;
    const finalStats = client.stats();

    assert.deepEqual(JSON.parse(result.content[0].text), { name: "echo", arguments: { q: "first" } });
    assert.equal(finalStats.pending, 0);
    assert.equal(finalStats.responses, 1);
    assert.equal(finalStats.failures, 0);
  } finally {
    await client.close();
  }
});
