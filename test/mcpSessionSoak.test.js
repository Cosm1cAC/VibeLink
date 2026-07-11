import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("MCP soak aggregates clean independent auto-mode sessions", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-mcp-soak-test-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "mcp-session", "soak.mjs"),
      "--sessions", "2",
      "--calls", "3",
      "--max-rust-request-ms", "10000",
      "--min-spawn-reduction-percent", "70",
      "--output", output,
      "--tmp-dir", tempRoot
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 120000 });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.evaluation.passed, true);
    assert.equal(result.config.sessions, 2);
    assert.equal(result.config.callsPerSession, 3);
    assert.equal(result.sessions.length, 2);
    assert.equal(result.totals.baselineServerSpawns, 8);
    assert.equal(result.totals.rustServerSpawns, 2);
    assert.equal(result.totals.sidecarStarts, 2);
    assert.equal(result.totals.failures, 0);
    assert.equal(result.totals.fallbacks, 0);
    assert.equal(result.totals.backpressureRejects, 0);
    assert.equal(result.totals.pendingAfterDrain, 0);
    assert.equal(result.sessions.every((item) => item.passed && item.cleanDrain), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
