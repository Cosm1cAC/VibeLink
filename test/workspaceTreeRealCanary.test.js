import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function rustCommand() {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  const release = path.join(process.cwd(), "apps", "windows", "target", "release", binary);
  if (fs.existsSync(release)) return release;
  return path.join(process.cwd(), "apps", "windows", "target", "debug", binary);
}

test("workspace-tree real canary preserves checkout metadata and context parity", (t) => {
  const command = rustCommand();
  if (!fs.existsSync(command)) {
    t.skip("a built VibeLink Rust binary is unavailable");
    return;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-real-canary-test-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "workspace-tree", "real-canary.mjs"),
      "--workspace", process.cwd(), "--paths", "src,docs", "--command", command,
      "--max-warm-ms", "200", "--tmp-dir", tempRoot, "--output", output, "--delete-temp"
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 120000 });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.evaluation.passed, true);
    assert.equal(result.rust.failures, 0);
    assert.equal(result.rust.fallbacks, 0);
    assert.equal(result.rust.hits, 3);
    assert.equal(result.rust.cacheHits, 3);
    assert.equal(result.rust.session.starts, 1);
    assert.equal(result.rust.session.failures, 0);
    assert.equal(result.rust.session.fallbacks, 0);
    assert.equal(result.rust.session.pending, 0);
    assert.equal(result.rust.session.terminated, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
