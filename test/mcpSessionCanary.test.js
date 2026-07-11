import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function cargoPath() {
  const lookup = process.platform === "win32"
    ? spawnSync("where.exe", ["cargo"], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-lc", "command -v cargo"], { encoding: "utf8", windowsHide: true });
  return lookup.status === 0 ? String(lookup.stdout || "").trim().split(/\r?\n/)[0] || "" : "";
}

function rustCommand() {
  const target = path.join(process.cwd(), "apps", "windows", "target");
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  const release = path.join(target, "release", binary);
  return fs.existsSync(release) ? release : path.join(target, "debug", binary);
}

test("MCP session canary proves runtime spawn reduction and clean drain", (t) => {
  const command = rustCommand();
  if (!fs.existsSync(command)) {
    const cargo = cargoPath();
    if (!cargo) {
      t.skip("cargo is not available");
      return;
    }
    const build = spawnSync(cargo, ["build", "--manifest-path", "apps/windows/Cargo.toml"], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-mcp-session-canary-test-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "mcp-session", "canary.mjs"),
      "--command", command,
      "--calls", "4",
      "--output", output,
      "--tmp-dir", tempRoot,
      "--delete-temp"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000
    });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.evaluation.passed, true);
    assert.equal(result.baseline.serverSpawns, 5);
    assert.equal(result.rust.serverSpawns, 1);
    assert.equal(result.rust.toolsListCalls, 1);
    assert.equal(result.rust.failures, 0);
    assert.equal(result.rust.fallbacks, 0);
    assert.equal(result.rust.backpressureRejects, 0);
    assert.equal(result.rust.pendingBeforeDrain, 0);
    assert.equal(result.rust.activeAfterDrain, false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
