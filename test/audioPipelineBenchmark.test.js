import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("audio benchmark measures representative PCM frames without production routing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-audio-benchmark-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "audio-pipeline", "benchmark.mjs"),
      "--rounds", "10",
      "--warmup", "2",
      "--max-rust-p95-ms", "1000",
      "--node-bottleneck-p95-ms", "1000",
      "--output", output
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 60000 });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.source.productionRouting, false);
    assert.equal(result.evaluation.passed, true);
    assert.equal(result.evaluation.productionRoutingJustified, false);
    assert.deepEqual(result.workloads.map((item) => item.samplesPerFrame), [160, 320, 1600]);
    assert.equal(result.workloads.every((item) => item.node.samples === 10), true);
    assert.equal(result.workloads.every((item) => item.rustRoundTrip.samples === 10), true);
    assert.equal(result.workloads.every((item) => item.parity.maxRmsDelta <= 1e-12), true);
    assert.equal(result.runtime.starts, 1);
    assert.equal(result.runtime.droppedChunks, 0);
    assert.equal(result.runtime.backpressureRejects, 0);
    assert.equal(result.runtime.pending, 0);
    assert.equal(result.runtime.closed, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
