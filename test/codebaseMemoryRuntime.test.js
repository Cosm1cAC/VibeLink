import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  codebaseMemoryPathEntries,
  codebaseMemoryServerConfig,
  mergeCodebaseMemoryServer
} from "../src/codebaseMemoryRuntime.js";

test("codebaseMemoryServerConfig finds the Windows installed executable", () => {
  const home = "C:\\Users\\Ada";
  const localAppData = path.join(home, "AppData", "Local");
  const command = path.join(localAppData, "Programs", "codebase-memory-mcp", "codebase-memory-mcp.exe");
  const existingFiles = new Set([command.toLowerCase()]);
  const fsLike = {
    existsSync(value) {
      return existingFiles.has(path.resolve(value).toLowerCase());
    },
    statSync(value) {
      assert.equal(path.resolve(value).toLowerCase(), command.toLowerCase());
      return { isFile: () => true, isDirectory: () => false };
    }
  };

  const result = codebaseMemoryServerConfig({
    env: { USERPROFILE: home, LOCALAPPDATA: localAppData, PATH: "" },
    platform: "win32",
    fsLike
  });

  assert.deepEqual(result, {
    id: "codebase-memory-mcp",
    name: "codebase-memory-mcp",
    type: "stdio",
    enabled: true,
    command,
    args: []
  });
});

test("mergeCodebaseMemoryServer keeps a user configured server", () => {
  const settings = {
    mcp: {
      probeTimeoutMs: 5000,
      servers: [
        {
          id: "codebase-memory-mcp",
          name: "Code Graph",
          type: "stdio",
          enabled: false,
          command: "custom-cbm",
          args: ["--ui=false"]
        }
      ]
    }
  };

  const result = mergeCodebaseMemoryServer(settings, {
    id: "codebase-memory-mcp",
    name: "codebase-memory-mcp",
    type: "stdio",
    enabled: true,
    command: "auto-cbm",
    args: []
  });

  assert.equal(result.mcp.probeTimeoutMs, 5000);
  assert.deepEqual(result.mcp.servers, settings.mcp.servers);
});

test("codebaseMemoryPathEntries exposes likely install bin directories", () => {
  const home = "C:\\Users\\Ada";
  const localAppData = path.join(home, "AppData", "Local");
  const installDir = path.join(localAppData, "Programs", "codebase-memory-mcp");
  const localBin = path.join(home, ".local", "bin");
  const existingDirs = new Set([installDir.toLowerCase(), localBin.toLowerCase()]);
  const fsLike = {
    existsSync(value) {
      return existingDirs.has(path.resolve(value).toLowerCase());
    },
    statSync() {
      return { isFile: () => false, isDirectory: () => true };
    }
  };

  assert.deepEqual(
    codebaseMemoryPathEntries({ env: { USERPROFILE: home, LOCALAPPDATA: localAppData }, platform: "win32", fsLike }),
    [installDir, localBin]
  );
});
