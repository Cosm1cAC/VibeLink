import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function rustCommand() {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["release", "debug"]) {
    const command = path.join(process.cwd(), "apps", "windows", "target", profile, binary);
    if (fs.existsSync(command)) return command;
  }
  return "";
}

test("MCP server canary routes authenticated HTTP calls through Rust auto mode", (t) => {
  const command = rustCommand();
  if (!command) {
    t.skip("a built VibeLink Rust binary is unavailable");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-mcp-server-canary-test-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "mcp-session", "server-canary.mjs"),
      "--command", command,
      "--calls", "3",
      "--output", output,
      "--delete-temp"
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 120000 });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.evaluation.passed, true);
    assert.equal(result.source.route, "authenticated-http-api");
    assert.equal(result.workload.probes, 1);
    assert.equal(result.workload.calls, 3);
    assert.equal(result.runtime.serverSpawns, 1);
    assert.equal(result.runtime.rustSidecar.mode, "auto");
    assert.equal(result.runtime.rustSidecar.ready, true);
    assert.equal(result.runtime.rustSidecar.failures, 0);
    assert.equal(result.runtime.rustSidecar.fallbacks, 0);
    assert.equal(result.runtime.rustSidecar.client.backpressureRejects, 0);
    assert.equal(result.runtime.rustSidecar.client.pending, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
