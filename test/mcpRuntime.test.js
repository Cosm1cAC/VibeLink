import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callMcpTool, closePersistentMcpSessions, configuredMcpServers } from "../src/mcpRuntime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
