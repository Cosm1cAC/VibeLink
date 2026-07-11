import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  callMcpTool,
  closeIdlePersistentMcpSessions,
  closePersistentMcpSessions,
  configuredMcpServers,
  mcpStatus,
  probeMcpServer
} from "../src/mcpRuntime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

test("configuredMcpServers includes an auto-discovered codebase-memory server", () => {
  const home = "C:\\Users\\Ada";
  const localAppData = path.join(home, "AppData", "Local");
  const command = path.join(localAppData, "Programs", "codebase-memory-mcp", "codebase-memory-mcp.exe");
  const existingFiles = new Set([command.toLowerCase()]);
  const fsLike = {
    existsSync(value) {
      return existingFiles.has(path.resolve(value).toLowerCase());
    },
    statSync() {
      return { isFile: () => true, isDirectory: () => false };
    }
  };

  assert.deepEqual(
    configuredMcpServers(
      { mcp: { servers: [] } },
      { env: { USERPROFILE: home, LOCALAPPDATA: localAppData }, platform: "win32", fsLike }
    ),
    [
      {
        id: "codebase-memory-mcp",
        name: "codebase-memory-mcp",
        type: "stdio",
        enabled: true,
        command,
        args: []
      }
    ]
  );
});

test("callMcpTool executes a stdio MCP tools/call request", async () => {
  const result = await callMcpTool(
    {
      mcp: {
        servers: [
          {
            id: "fake",
            name: "fake",
            type: "stdio",
            command: process.execPath,
            args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
          }
        ]
      }
    },
    {
      serverId: "fake",
      toolName: "echo",
      arguments: { q: "hello" }
    },
    { timeoutMs: 5000 }
  );

  assert.equal(result.ok, true);
  assert.equal(result.server.name, "fake");
  assert.equal(result.toolName, "echo");
  assert.deepEqual(JSON.parse(result.content[0].text), { name: "echo", arguments: { q: "hello" } });
});

test("callMcpTool routes stdio calls through the Rust sidecar when enabled", async () => {
  const previousRustFlag = process.env.VIBELINK_MCP_RUST_SIDECAR;
  const previousCommand = process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND;
  const previousArgs = process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON;
  const previousPersistentFlag = process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const spawnLog = path.join(os.tmpdir(), `vibelink-rust-sidecar-runtime-spawns-${Date.now()}.log`);
  process.env.VIBELINK_MCP_RUST_SIDECAR = "1";
  process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND = process.execPath;
  process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON = JSON.stringify([path.join(__dirname, "fixtures", "mcp-session-json-sidecar.js")]);
  delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const settings = {
    mcp: {
      servers: [
        {
          id: "fake-rust-runtime",
          name: "fake-rust-runtime",
          type: "stdio",
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")],
          env: { FAKE_MCP_SPAWN_LOG: spawnLog }
        }
      ]
    }
  };

  try {
    const first = await callMcpTool(settings, { serverId: "fake-rust-runtime", toolName: "echo", arguments: { q: "one" } }, { timeoutMs: 5000 });
    const second = await callMcpTool(settings, { serverId: "fake-rust-runtime", toolName: "echo", arguments: { q: "two" } }, { timeoutMs: 5000 });
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(spawns.length, 1);
    assert.equal(mcpStatus(settings).rustSidecar.enabled, true);
  } finally {
    await closePersistentMcpSessions();
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR", previousRustFlag);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_COMMAND", previousCommand);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON", previousArgs);
    restoreEnv("VIBELINK_MCP_PERSISTENT_SESSIONS", previousPersistentFlag);
    fs.rmSync(spawnLog, { force: true });
  }
});

test("callMcpTool routes through the Rust sidecar in auto mode when readiness passes", async () => {
  const previousRustFlag = process.env.VIBELINK_MCP_RUST_SIDECAR;
  const previousCommand = process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND;
  const previousArgs = process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON;
  const previousPersistentFlag = process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const spawnLog = path.join(os.tmpdir(), `vibelink-rust-sidecar-auto-spawns-${Date.now()}.log`);
  process.env.VIBELINK_MCP_RUST_SIDECAR = "auto";
  process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND = process.execPath;
  process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON = JSON.stringify([path.join(__dirname, "fixtures", "mcp-session-json-sidecar.js")]);
  delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const settings = {
    mcp: {
      servers: [
        {
          id: "fake-rust-auto-runtime",
          name: "fake-rust-auto-runtime",
          type: "stdio",
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")],
          env: { FAKE_MCP_SPAWN_LOG: spawnLog }
        }
      ]
    }
  };

  try {
    const result = await callMcpTool(settings, { serverId: "fake-rust-auto-runtime", toolName: "echo", arguments: { q: "auto" } }, { timeoutMs: 5000 });
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const status = mcpStatus(settings).rustSidecar;

    assert.equal(result.ok, true);
    assert.equal(spawns.length, 1);
    assert.equal(status.mode, "auto");
    assert.equal(status.auto, true);
    assert.equal(status.available, true);
    assert.equal(status.ready, true);
    assert.equal(status.failed, false);
  } finally {
    await closePersistentMcpSessions();
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR", previousRustFlag);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_COMMAND", previousCommand);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON", previousArgs);
    restoreEnv("VIBELINK_MCP_PERSISTENT_SESSIONS", previousPersistentFlag);
    fs.rmSync(spawnLog, { force: true });
  }
});

test("callMcpTool skips the Rust sidecar in auto mode when the command is missing", async () => {
  const previousRustFlag = process.env.VIBELINK_MCP_RUST_SIDECAR;
  const previousCommand = process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND;
  const previousArgs = process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON;
  const previousPersistentFlag = process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const spawnLog = path.join(os.tmpdir(), `vibelink-rust-sidecar-auto-missing-spawns-${Date.now()}.log`);
  process.env.VIBELINK_MCP_RUST_SIDECAR = "auto";
  process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND = path.join(os.tmpdir(), `missing-mcp-sidecar-${Date.now()}.exe`);
  process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON = JSON.stringify([]);
  delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const settings = {
    mcp: {
      servers: [
        {
          id: "fake-rust-auto-missing-runtime",
          name: "fake-rust-auto-missing-runtime",
          type: "stdio",
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")],
          env: { FAKE_MCP_SPAWN_LOG: spawnLog }
        }
      ]
    }
  };

  try {
    const before = mcpStatus(settings).rustSidecar;
    const result = await callMcpTool(settings, { serverId: "fake-rust-auto-missing-runtime", toolName: "echo", arguments: { q: "auto-missing" } }, { timeoutMs: 5000 });
    const after = mcpStatus(settings).rustSidecar;
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.equal(result.ok, true);
    assert.equal(spawns.length, 1);
    assert.equal(after.mode, "auto");
    assert.equal(after.auto, true);
    assert.equal(after.enabled, false);
    assert.equal(after.available, false);
    assert.equal(after.failed, false);
    assert.equal(after.ready, false);
    assert.equal(after.starts, before.starts);
    assert.equal(after.failures, before.failures);
    assert.equal(after.fallbacks, before.fallbacks);
  } finally {
    await closePersistentMcpSessions();
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR", previousRustFlag);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_COMMAND", previousCommand);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON", previousArgs);
    restoreEnv("VIBELINK_MCP_PERSISTENT_SESSIONS", previousPersistentFlag);
    fs.rmSync(spawnLog, { force: true });
  }
});

test("callMcpTool falls back when Rust sidecar readiness fails in auto mode", async () => {
  const previousRustFlag = process.env.VIBELINK_MCP_RUST_SIDECAR;
  const previousCommand = process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND;
  const previousArgs = process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON;
  const previousPersistentFlag = process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const spawnLog = path.join(os.tmpdir(), `vibelink-rust-sidecar-auto-health-fallback-spawns-${Date.now()}.log`);
  process.env.VIBELINK_MCP_RUST_SIDECAR = "auto";
  process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND = process.execPath;
  process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON = JSON.stringify(["-e", "process.exit(42)"]);
  delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const settings = {
    mcp: {
      servers: [
        {
          id: "fake-rust-auto-health-fallback-runtime",
          name: "fake-rust-auto-health-fallback-runtime",
          type: "stdio",
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")],
          env: { FAKE_MCP_SPAWN_LOG: spawnLog }
        }
      ]
    }
  };

  try {
    const before = mcpStatus(settings).rustSidecar;
    const result = await callMcpTool(settings, { serverId: "fake-rust-auto-health-fallback-runtime", toolName: "echo", arguments: { q: "fallback" } }, { timeoutMs: 5000 });
    const after = mcpStatus(settings).rustSidecar;
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.equal(result.ok, true);
    assert.equal(spawns.length, 1);
    assert.equal(after.mode, "auto");
    assert.equal(after.auto, true);
    assert.equal(after.available, true);
    assert.equal(after.ready, false);
    assert.equal(after.failed, true);
    assert.equal(after.fallbacks, before.fallbacks + 1);
    assert.equal(after.failures, before.failures + 1);
    assert.match(after.lastError, /closed|exited|timeout/i);
  } finally {
    await closePersistentMcpSessions();
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR", previousRustFlag);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_COMMAND", previousCommand);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON", previousArgs);
    restoreEnv("VIBELINK_MCP_PERSISTENT_SESSIONS", previousPersistentFlag);
    fs.rmSync(spawnLog, { force: true });
  }
});

test("probeMcpServer routes stdio probes through the Rust sidecar when enabled", async () => {
  const previousRustFlag = process.env.VIBELINK_MCP_RUST_SIDECAR;
  const previousCommand = process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND;
  const previousArgs = process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON;
  const previousPersistentFlag = process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const spawnLog = path.join(os.tmpdir(), `vibelink-rust-sidecar-runtime-probe-spawns-${Date.now()}.log`);
  const methodLog = path.join(os.tmpdir(), `vibelink-rust-sidecar-runtime-probe-methods-${Date.now()}.log`);
  process.env.VIBELINK_MCP_RUST_SIDECAR = "1";
  process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND = process.execPath;
  process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON = JSON.stringify([path.join(__dirname, "fixtures", "mcp-session-json-sidecar.js")]);
  delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const server = {
    id: "fake-rust-probe-runtime",
    name: "fake-rust-probe-runtime",
    type: "stdio",
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")],
    env: {
      FAKE_MCP_SPAWN_LOG: spawnLog,
      FAKE_MCP_METHOD_LOG: methodLog
    }
  };

  try {
    const first = await probeMcpServer(server, { timeoutMs: 5000 });
    const second = await probeMcpServer(server, { timeoutMs: 5000 });
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const methods = fs.readFileSync(methodLog, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(second.tools.map((tool) => tool.name), ["echo"]);
    assert.equal(spawns.length, 1);
    assert.equal(methods.filter((method) => method === "tools/list").length, 1);
  } finally {
    await closePersistentMcpSessions();
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR", previousRustFlag);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_COMMAND", previousCommand);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON", previousArgs);
    restoreEnv("VIBELINK_MCP_PERSISTENT_SESSIONS", previousPersistentFlag);
    fs.rmSync(spawnLog, { force: true });
    fs.rmSync(methodLog, { force: true });
  }
});

test("callMcpTool falls back to Node stdio when the Rust sidecar fails", async () => {
  const previousRustFlag = process.env.VIBELINK_MCP_RUST_SIDECAR;
  const previousCommand = process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND;
  const previousArgs = process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON;
  const previousPersistentFlag = process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const spawnLog = path.join(os.tmpdir(), `vibelink-rust-sidecar-fallback-spawns-${Date.now()}.log`);
  process.env.VIBELINK_MCP_RUST_SIDECAR = "1";
  process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND = process.execPath;
  process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON = JSON.stringify(["-e", "process.exit(42)"]);
  delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const settings = {
    mcp: {
      servers: [
        {
          id: "fake-rust-fallback-runtime",
          name: "fake-rust-fallback-runtime",
          type: "stdio",
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")],
          env: { FAKE_MCP_SPAWN_LOG: spawnLog }
        }
      ]
    }
  };

  try {
    const before = mcpStatus(settings).rustSidecar;
    const result = await callMcpTool(settings, { serverId: "fake-rust-fallback-runtime", toolName: "echo", arguments: { q: "fallback" } }, { timeoutMs: 5000 });
    const after = mcpStatus(settings).rustSidecar;
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { name: "echo", arguments: { q: "fallback" } });
    assert.equal(spawns.length, 1);
    assert.equal(after.fallbacks, before.fallbacks + 1);
  } finally {
    await closePersistentMcpSessions();
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR", previousRustFlag);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_COMMAND", previousCommand);
    restoreEnv("VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON", previousArgs);
    restoreEnv("VIBELINK_MCP_PERSISTENT_SESSIONS", previousPersistentFlag);
    fs.rmSync(spawnLog, { force: true });
  }
});

test("callMcpTool reuses a persistent stdio MCP session when enabled", async () => {
  const previousFlag = process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const spawnLog = path.join(os.tmpdir(), `vibelink-fake-mcp-spawns-${Date.now()}.log`);
  process.env.VIBELINK_MCP_PERSISTENT_SESSIONS = "1";
  const settings = {
    mcp: {
      servers: [
        {
          id: "fake-persistent",
          name: "fake-persistent",
          type: "stdio",
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")],
          env: { FAKE_MCP_SPAWN_LOG: spawnLog }
        }
      ]
    }
  };

  try {
    const first = await callMcpTool(settings, { serverId: "fake-persistent", toolName: "echo", arguments: { q: "one" } }, { timeoutMs: 5000 });
    const second = await callMcpTool(settings, { serverId: "fake-persistent", toolName: "echo", arguments: { q: "two" } }, { timeoutMs: 5000 });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
    assert.equal(spawns.length, 1);
  } finally {
    await closePersistentMcpSessions();
    if (previousFlag === undefined) delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
    else process.env.VIBELINK_MCP_PERSISTENT_SESSIONS = previousFlag;
    fs.rmSync(spawnLog, { force: true });
  }
});

test("probeMcpServer reuses a persistent stdio MCP session when enabled", async () => {
  const previousFlag = process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  const spawnLog = path.join(os.tmpdir(), `vibelink-fake-mcp-probe-spawns-${Date.now()}.log`);
  process.env.VIBELINK_MCP_PERSISTENT_SESSIONS = "1";
  const server = {
    id: "fake-probe",
    name: "fake-probe",
    type: "stdio",
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")],
    env: { FAKE_MCP_SPAWN_LOG: spawnLog }
  };

  try {
    const first = await probeMcpServer(server, { timeoutMs: 5000 });
    const second = await probeMcpServer(server, { timeoutMs: 5000 });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(second.tools.map((tool) => tool.name), ["echo"]);
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
    assert.equal(spawns.length, 1);
  } finally {
    await closePersistentMcpSessions();
    if (previousFlag === undefined) delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
    else process.env.VIBELINK_MCP_PERSISTENT_SESSIONS = previousFlag;
    fs.rmSync(spawnLog, { force: true });
  }
});

test("mcpStatus reports persistent session state", async () => {
  const previousFlag = process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  process.env.VIBELINK_MCP_PERSISTENT_SESSIONS = "1";
  const settings = {
    mcp: {
      servers: [
        {
          id: "fake-status",
          name: "fake-status",
          type: "stdio",
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
        }
      ]
    }
  };

  try {
    await callMcpTool(settings, { serverId: "fake-status", toolName: "echo", arguments: { q: "status" } }, { timeoutMs: 5000 });
    const status = mcpStatus(settings);
    assert.equal(status.persistentSessions.enabled, true);
    assert.equal(status.persistentSessions.sessions >= 1, true);
  } finally {
    await closePersistentMcpSessions();
    if (previousFlag === undefined) delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
    else process.env.VIBELINK_MCP_PERSISTENT_SESSIONS = previousFlag;
  }
});

test("runtime closes idle persistent MCP sessions", async () => {
  const previousFlag = process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
  process.env.VIBELINK_MCP_PERSISTENT_SESSIONS = "1";
  const settings = {
    mcp: {
      servers: [
        {
          id: "fake-idle-runtime",
          name: "fake-idle-runtime",
          type: "stdio",
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "fake-mcp-server.js")]
        }
      ]
    }
  };

  try {
    await callMcpTool(settings, { serverId: "fake-idle-runtime", toolName: "echo", arguments: { q: "idle" } }, { timeoutMs: 5000 });
    assert.equal(mcpStatus(settings).persistentSessions.sessions, 1);

    const pruned = await closeIdlePersistentMcpSessions({ maxIdleMs: 0 });

    assert.equal(pruned.closed, 1);
    assert.equal(mcpStatus(settings).persistentSessions.sessions, 0);
  } finally {
    await closePersistentMcpSessions();
    if (previousFlag === undefined) delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
    else process.env.VIBELINK_MCP_PERSISTENT_SESSIONS = previousFlag;
  }
});
