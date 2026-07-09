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
  const cargo = cargoPath();
  if (!cargo) t.skip("cargo is not available");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-rust-mcp-session-sidecar-"));
  const spawnLog = path.join(dir, "spawns.log");
  const methodLog = path.join(dir, "methods.log");
  const client = createMcpSessionSidecarClient({
    command: cargo,
    args: [
      "run",
      "--quiet",
      "--manifest-path",
      path.join(process.cwd(), "apps", "windows", "Cargo.toml"),
      "--",
      "mcp-session-sidecar"
    ],
    timeoutMs: 10000
  });
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
    const result = await first;

    assert.deepEqual(JSON.parse(result.content[0].text), { name: "echo", arguments: { q: "first" } });
  } finally {
    await client.close();
  }
});
