import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("compression benchmark measures the current Node hot path without production routing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-compression-benchmark-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "compression", "benchmark.mjs"),
      "--synthetic-only",
      "--rounds", "20",
      "--warmup", "2",
      "--threshold-ms", "1000",
      "--output", output
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 30000 });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.evaluation.passed, true);
    assert.equal(result.evaluation.productionRoutingJustified, false);
    assert.equal(result.workloads.length, 1);
    assert.equal(result.workloads[0].kind, "synthetic-upper-bound");
    assert.equal(result.workloads[0].events, 1000);
    assert.equal(result.workloads[0].textChars, 2_000_000);
    assert.equal(result.workloads[0].combined.samples, 20);
    assert.equal(result.source.nodeProductionFunctions.length, 2);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compression benchmark keeps a positive default when rounds are fractional", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-compression-rounds-"));
  const output = path.join(tempRoot, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      path.join("tools", "compression", "benchmark.mjs"),
      "--synthetic-only",
      "--rounds", "0.5",
      "--warmup", "0",
      "--threshold-ms", "1000",
      "--output", output
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 30000 });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.config.rounds, 200);
    assert.equal(result.config.warmup, 0);
    assert.equal(result.workloads[0].combined.samples, 200);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
