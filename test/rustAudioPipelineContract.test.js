import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import {
  AUDIO_PIPELINE_CONTROL_METHODS,
  AUDIO_PIPELINE_METHODS,
  AUDIO_PIPELINE_PROTOCOL_VERSION,
  audioPipelineErrorFromPayload
} from "../src/audioPipelineContract.js";

function rustRunner(t) {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["release", "debug"]) {
    const command = path.join(process.cwd(), "apps", "windows", "target", profile, binary);
    if (fs.existsSync(command)) return { command, args: ["audio-pipeline-sidecar", "--max-buffered-samples", "4", "--max-samples-per-chunk", "4"] };
  }
  const lookup = process.platform === "win32"
    ? spawnSync("where.exe", ["cargo"], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-lc", "command -v cargo"], { encoding: "utf8", windowsHide: true });
  if (lookup.status !== 0) {
    t.skip("cargo and a built VibeLink binary are unavailable");
    return null;
  }
  return {
    command: String(lookup.stdout || "").trim().split(/\r?\n/)[0],
    args: ["run", "--quiet", "--manifest-path", path.join(process.cwd(), "apps", "windows", "Cargo.toml"), "--", "audio-pipeline-sidecar", "--max-buffered-samples", "4", "--max-samples-per-chunk", "4"]
  };
}

function client({ command, args, timeoutMs = 30000 }) {
  const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(audioPipelineErrorFromPayload(message.error));
    else request.resolve(message.result);
  });
  child.on("exit", (code) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`audio sidecar exited with code ${code}: ${stderr}`));
    }
    pending.clear();
  });
  return {
    request(method, args = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`audio sidecar timed out: ${method}; ${stderr}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
      });
    },
    stop() {
      if (!child.killed) child.kill();
    }
  };
}

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.equal(Math.abs(actual - expected) <= tolerance, true, `${actual} not within ${tolerance} of ${expected}`);
}

async function verifyContract(sidecar, implementation) {
  const health = await sidecar.request("__health");
  assert.equal(health.ok, true);
  assert.equal(health.implementation, implementation);
  assert.equal(health.protocolVersion, AUDIO_PIPELINE_PROTOCOL_VERSION);
  assert.deepEqual(health.supportedMethods, [...AUDIO_PIPELINE_METHODS]);
  assert.deepEqual(health.controlMethods, [...AUDIO_PIPELINE_CONTROL_METHODS]);
  assert.equal(health.maxBufferedSamples, 4);
  assert.equal(health.maxSamplesPerChunk, 4);

  const first = await sidecar.request("processPcm16", [{ sequence: 10, samples: [0, 16384] }]);
  assert.equal(first.sequence, 10);
  assert.equal(first.samples, 2);
  assert.equal(first.bytes, 4);
  closeTo(first.peak, 0.5);
  closeTo(first.rms, Math.sqrt(0.125));
  closeTo(first.level, first.rms);
  assert.equal(first.silence, false);
  assert.equal(first.sequenceGap, 0);
  assert.equal(first.expectedSequence, 11);

  const gap = await sidecar.request("processPcm16", [{ sequence: 12, samples: [-16384, 32767] }]);
  assert.equal(gap.sequenceGap, 1);
  assert.equal(gap.expectedSequence, 13);
  assert.equal(gap.bufferedSamples, 4);

  const duplicate = await sidecar.request("processPcm16", [{ sequence: 12, samples: [0, 0] }]);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.silence, true);
  assert.equal(duplicate.evictedChunks, 1);
  const outOfOrder = await sidecar.request("processPcm16", [{ sequence: 11, samples: [1, -1] }]);
  assert.equal(outOfOrder.outOfOrder, true);
  assert.equal(outOfOrder.evictedChunks, 2);

  await assert.rejects(
    sidecar.request("processPcm16", [{ sequence: 13, samples: [0, 0, 0, 0, 0] }]),
    /backpressure|maxSamplesPerChunk/i
  );
  await assert.rejects(
    sidecar.request("processPcm16", [{ sequence: 13, samples: [32768] }]),
    /signed 16-bit/i
  );
  await assert.rejects(
    sidecar.request("processPcm16", [{ sequence: Number.MAX_SAFE_INTEGER + 1, samples: [0] }]),
    /safe integer/i
  );
  const stats = await sidecar.request("stats");
  assert.equal(stats.requests, 9);
  assert.equal(stats.responses, 5);
  assert.equal(stats.failures, 3);
  assert.equal(stats.processedChunks, 4);
  assert.equal(stats.processedSamples, 8);
  assert.equal(stats.processedBytes, 16);
  assert.equal(stats.droppedChunks, 1);
  assert.equal(stats.backpressureRejects, 1);
  assert.equal(stats.sequenceGaps, 1);
  assert.equal(stats.duplicateSequences, 1);
  assert.equal(stats.outOfOrderSequences, 1);
  assert.equal(stats.bufferedChunks, 2);
  assert.equal(stats.bufferedSamples, 4);
  assert.equal(stats.evictedChunks, 2);
  assert.equal(stats.pending, 0);
  assert.equal(await sidecar.request("__close"), true);
}

test("audio pipeline JSONL fixture satisfies protocol v1", async () => {
  const sidecar = client({
    command: process.execPath,
    args: [path.join(process.cwd(), "test", "fixtures", "audio-pipeline-json-sidecar.js"), "--max-buffered-samples", "4", "--max-samples-per-chunk", "4"]
  });
  try {
    await verifyContract(sidecar, "node-fixture");
  } finally {
    sidecar.stop();
  }
});

test("Rust audio pipeline sidecar satisfies protocol v1", async (t) => {
  const runner = rustRunner(t);
  if (!runner) return;
  const sidecar = client(runner);
  try {
    await verifyContract(sidecar, "rust");
  } finally {
    sidecar.stop();
  }
});
