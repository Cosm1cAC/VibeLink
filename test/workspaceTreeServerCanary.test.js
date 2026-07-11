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

test("workspace server canary routes authenticated tree and context requests through one Rust session", (t) => {
  const command = rustCommand();
  if (!command) {
    t.skip("a built VibeLink Rust binary is unavailable");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-server-canary-test-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "workspace-tree", "server-canary.mjs"),
      "--command", command,
      "--output", output,
      "--delete-temp"
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 120000 });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.evaluation.passed, true);
    assert.equal(result.source.route, "authenticated-http-api");
    assert.deepEqual(result.workload.contextPaths, ["src", "docs"]);
    assert.equal(result.parity.treeRepeated, true);
    assert.equal(result.parity.contextRepeated, true);
    assert.equal(result.runtime.hits, 3);
    assert.equal(result.runtime.cacheMisses, 3);
    assert.equal(result.runtime.cacheHits, 3);
    assert.equal(result.runtime.failures, 0);
    assert.equal(result.runtime.fallbacks, 0);
    assert.equal(result.runtime.session.starts, 1);
    assert.equal(result.runtime.session.failures, 0);
    assert.equal(result.runtime.session.fallbacks, 0);
    assert.equal(result.runtime.session.pending, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
