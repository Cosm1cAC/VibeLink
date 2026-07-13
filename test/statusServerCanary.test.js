import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function rustCommand() {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["debug", "release"]) {
    const command = path.join(process.cwd(), "apps", "windows", "target", profile, binary);
    if (fs.existsSync(command)) return command;
  }
  return "";
}

test("status server canary routes authenticated responses through one Rust sidecar", (t) => {
  const command = rustCommand();
  if (!command) {
    t.skip("a built VibeLink Rust binary is unavailable");
    return;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-status-canary-test-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "status", "server-canary.mjs"),
      "--command", command,
      "--output", output,
      "--delete-temp"
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 120000 });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.passed, true);
    assert.equal(result.source.route, "/api/status");
    assert.equal(result.runtime.mode, "rust-sidecar");
    assert.equal(result.runtime.rustResponses, 2);
    assert.equal(result.runtime.fallbacks, 0);
    assert.equal(result.runtime.client.requests, 3);
    assert.equal(result.runtime.client.pending, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
