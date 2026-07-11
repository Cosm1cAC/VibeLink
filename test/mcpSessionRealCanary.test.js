import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configuredMcpServers } from "../src/mcpRuntime.js";

function rustCommand() {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  const release = path.join(process.cwd(), "apps", "windows", "target", "release", binary);
  if (fs.existsSync(release)) return release;
  return path.join(process.cwd(), "apps", "windows", "target", "debug", binary);
}

test("MCP real canary reuses the Rust session for codebase-memory", (t) => {
  const command = rustCommand();
  const server = configuredMcpServers({}).find((item) => item.id === "codebase-memory-mcp");
  const artifact = path.join(process.cwd(), ".codebase-memory", "artifact.json");
  if (!fs.existsSync(command) || !server?.command || !fs.existsSync(server.command) || !fs.existsSync(artifact)) {
    t.skip("local codebase-memory MCP runtime or indexed project is unavailable");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-mcp-real-canary-test-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "mcp-session", "real-canary.mjs"),
      "--calls", "2", "--command", command, "--output", output
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 180000 });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.evaluation.passed, true);
    assert.equal(result.runtime.starts, 1);
    assert.equal(result.runtime.failures, 0);
    assert.equal(result.runtime.fallbacks, 0);
    assert.equal(result.runtime.drain.closed, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("MCP real canary accepts an explicit second server implementation", (t) => {
  const command = rustCommand();
  if (!fs.existsSync(command)) {
    t.skip("built Rust MCP sidecar is unavailable");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-mcp-second-real-canary-test-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "mcp-session", "real-canary.mjs"),
      "--server", "second-mcp",
      "--server-command", process.execPath,
      "--server-arg", path.join(process.cwd(), "test", "fixtures", "fake-mcp-server.js"),
      "--tool", "echo",
      "--calls", "2",
      "--command", command,
      "--output", output
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 180000 });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.evaluation.passed, true);
    assert.equal(result.server.id, "second-mcp");
    assert.equal(result.workload.tool, "echo");
    assert.deepEqual(result.workload.argumentKeys, []);
    assert.equal(result.calls.length, 2);
    assert.equal(result.runtime.starts, 1);
    assert.equal(result.runtime.failures, 0);
    assert.equal(result.runtime.fallbacks, 0);
    assert.equal(result.runtime.drain.closed, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
