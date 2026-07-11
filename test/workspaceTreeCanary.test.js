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
  const base = path.join(
    process.cwd(),
    "apps",
    "windows",
    "target"
  );
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  const release = path.join(base, "release", binary);
  return fs.existsSync(release) ? release : path.join(base, "debug", binary);
}

test("workspace-tree canary validates auto mode parity, cache reuse, and fallback", (t) => {
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-tree-canary-test-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "workspace-tree", "canary.mjs"),
      "--command", command,
      "--warm-scans", "2",
      "--max-cold-ms", "1000",
      "--max-warm-ms", "100",
      "--tmp-dir", tempRoot,
      "--output", output,
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
    assert.equal(result.parity.initial, true);
    assert.equal(result.parity.afterGitignoreChange, true);
    assert.equal(result.rust.available.failures, 0);
    assert.equal(result.rust.available.fallbacks, 0);
    assert.equal(result.rust.available.firstLaunchStarts, 1);
    assert.equal(result.rust.available.firstLaunchFailures, 0);
    assert.equal(result.rust.available.firstLaunchFallbacks, 0);
    assert.equal(result.rust.available.additionalStartsDuringWarmScans, 0);
    assert.equal(result.rust.available.firstLaunchMs <= 1000, true);
    assert.equal(result.rust.missingCommand.failureDelta, 0);
    assert.equal(result.rust.missingCommand.fallbackDelta, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
