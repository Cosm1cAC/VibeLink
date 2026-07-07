import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callMcpTool, configuredMcpServers } from "../src/mcpRuntime.js";

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
