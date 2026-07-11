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

test("event-store real-data canary preserves read-only replay parity", (t) => {
  const command = rustCommand();
  const dbPath = path.resolve(process.env.VIBELINK_EVENT_STORE_REAL_DB || path.join(".agent-mobile-terminal", "mobile-agent.sqlite"));
  if (!fs.existsSync(command) || !fs.existsSync(dbPath) || fs.statSync(dbPath).size < 10 * 1024 * 1024) {
    t.skip("a representative existing event-store database is unavailable");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-event-store-real-data-test-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "event-store", "real-data-canary.mjs"),
      "--db", dbPath, "--command", command, "--limit", "50", "--output", output
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 180000 });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.evaluation.passed, true);
    assert.equal(result.workload.streamTypes, 3);
    assert.equal(result.sidecar.readOnly, true);
    assert.equal(result.sidecar.failures, 0);
    assert.equal(result.sidecar.pending, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
