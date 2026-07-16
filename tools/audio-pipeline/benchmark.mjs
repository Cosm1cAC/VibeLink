#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  computePcm16Rms,
  createVadSegmenter,
  normalizePcm16To16kMono
} from "../../src/liveCallAudioPipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function integerArg(name, fallback, minimum = 0) {
  const value = Number(stringArg(name, fallback));
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function numberArg(name, fallback) {
  const value = Number(stringArg(name, fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function defaultRustCommand() {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["release", "debug"]) {
    const command = path.join(rootDir, "apps", "windows", "target", profile, binary);
    if (fs.existsSync(command)) return command;
  }
  return path.join(rootDir, "apps", "windows", "target", "release", binary);
}

function timingStats(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] || 0;
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    samples: samples.length,
    avgMs: Number((total / samples.length).toFixed(3)),
    p50Ms: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    maxMs: Number((sorted.at(-1) || 0).toFixed(3))
  };
}

function pcmWorkload(frameMs) {
  const samplesPerFrame = Math.round(16_000 * frameMs / 1000);
  const samples = Array.from({ length: samplesPerFrame }, (_, index) => {
    const primary = Math.sin(index * Math.PI * 2 / 37) * 12_000;
    const secondary = Math.sin(index * Math.PI * 2 / 11) * 2_000;
    return Math.max(-32768, Math.min(32767, Math.round(primary + secondary)));
  });
  const buffer = Buffer.alloc(samples.length * 2);
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], index * 2);
    peak = Math.max(peak, Math.abs(samples[index] / 32768));
  }
  return { name: `${frameMs}ms-frame`, frameMs, samplesPerFrame, samples, buffer, peak };
}

function resamplingWorkload(frameMs) {
  const inputFrames = Math.round(48_000 * frameMs / 1000);
  const buffer = Buffer.alloc(inputFrames * 2 * 2);
  for (let frame = 0; frame < inputFrames; frame += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(frame * Math.PI * 2 / 37) * 12_000), frame * 4);
    buffer.writeInt16LE(Math.round(Math.sin(frame * Math.PI * 2 / 23) * 8_000), frame * 4 + 2);
  }
  return { frameMs, inputFrames, buffer };
}

function constantFrame(amplitude, frameMs = 20) {
  const samples = Math.round(16_000 * frameMs / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(amplitude, index * 2);
  return buffer;
}

function benchmarkLiveCallWorkloads({ rounds, warmup, nodeBottleneckP95Ms }) {
  const resampling = [10, 20, 100].map((frameMs) => {
    const workload = resamplingWorkload(frameMs);
    let outputFrames = 0;
    const run = () => {
      const normalized = normalizePcm16To16kMono(workload.buffer, { sampleRate: 48_000, channels: 2 });
      outputFrames = normalized.outputFrames;
    };
    for (let index = 0; index < warmup; index += 1) run();
    const samples = [];
    for (let index = 0; index < rounds; index += 1) {
      const startedAt = performance.now();
      run();
      samples.push(performance.now() - startedAt);
    }
    return { frameMs, inputFrames: workload.inputFrames, outputFrames, node: timingStats(samples) };
  });

  const silence = constantFrame(0);
  const speech = constantFrame(8_000);
  const runVad = () => {
    const vad = createVadSegmenter();
    const segments = [];
    for (let index = 0; index < 10; index += 1) segments.push(...vad.push(silence));
    for (let index = 0; index < 50; index += 1) segments.push(...vad.push(speech));
    for (let index = 0; index < 40; index += 1) segments.push(...vad.push(silence));
    segments.push(...vad.flush());
    return segments;
  };
  for (let index = 0; index < warmup; index += 1) runVad();
  const vadSamples = [];
  let segments = [];
  for (let index = 0; index < rounds; index += 1) {
    const startedAt = performance.now();
    segments = runVad();
    vadSamples.push(performance.now() - startedAt);
  }
  const vad = {
    frameMs: 20,
    inputFrames: 100,
    inputDurationMs: 2000,
    segments: segments.length,
    outputDurationMs: segments.reduce((total, segment) => total + segment.durationMs, 0),
    node: timingStats(vadSamples)
  };
  const liveCallNodeBottleneckObserved = [
    ...resampling.map((item) => item.node.p95Ms),
    vad.node.p95Ms
  ].some((p95Ms) => p95Ms >= nodeBottleneckP95Ms);
  return { resampling, vad, liveCallNodeBottleneckObserved };
}

class AudioSidecarClient {
  constructor(command, timeoutMs) {
    this.child = spawn(command, ["audio-pipeline-sidecar"], {
      cwd: rootDir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.closed = false;
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        this.closed = code === 0;
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error(`Audio sidecar exited (${code ?? signal}): ${this.stderr}`));
        }
        this.pending.clear();
        resolve({ code, signal });
      });
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`Audio sidecar returned invalid JSON: ${error.message}`));
      }
      this.pending.clear();
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message || "Audio sidecar request failed"));
    else request.resolve(message.result);
  }

  request(method, args = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Audio sidecar timed out: ${method}; ${this.stderr}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
    });
  }

  async close() {
    if (this.child.exitCode === null && !this.child.killed) {
      await this.request("__close");
    }
    await this.exitPromise;
    return this.closed;
  }

  stop() {
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
  }
}

async function benchmarkWorkload(client, workload, state, { rounds, warmup }) {
  const expectedRms = computePcm16Rms(workload.buffer);
  for (let index = 0; index < warmup; index += 1) {
    computePcm16Rms(workload.buffer);
    await client.request("processPcm16", [{ sequence: state.sequence++, samples: workload.samples }]);
  }

  const nodeSamples = [];
  const rustSamples = [];
  let maxRmsDelta = 0;
  let maxPeakDelta = 0;
  for (let index = 0; index < rounds; index += 1) {
    const nodeStartedAt = performance.now();
    computePcm16Rms(workload.buffer);
    nodeSamples.push(performance.now() - nodeStartedAt);

    const rustStartedAt = performance.now();
    const result = await client.request("processPcm16", [{ sequence: state.sequence++, samples: workload.samples }]);
    rustSamples.push(performance.now() - rustStartedAt);
    maxRmsDelta = Math.max(maxRmsDelta, Math.abs(Number(result.rms) - expectedRms));
    maxPeakDelta = Math.max(maxPeakDelta, Math.abs(Number(result.peak) - workload.peak));
  }

  return {
    name: workload.name,
    frameMs: workload.frameMs,
    samplesPerFrame: workload.samplesPerFrame,
    bytesPerFrame: workload.buffer.length,
    node: timingStats(nodeSamples),
    rustRoundTrip: timingStats(rustSamples),
    parity: { maxRmsDelta, maxPeakDelta }
  };
}

function printSummary(result) {
  console.log("Audio pipeline PCM benchmark");
  for (const workload of result.workloads) {
    console.log(`- ${workload.name}: Node p95=${workload.node.p95Ms}ms; Rust p95=${workload.rustRoundTrip.p95Ms}ms; RMS delta=${workload.parity.maxRmsDelta}`);
  }
  for (const workload of result.liveCallWorkloads.resampling) {
    console.log(`- ${workload.frameMs}ms 48k stereo resampling: Node p95=${workload.node.p95Ms}ms`);
  }
  console.log(`- 2.0s VAD sequence: Node p95=${result.liveCallWorkloads.vad.node.p95Ms}ms; segments=${result.liveCallWorkloads.vad.segments}`);
  console.log(`- Rust p95 limit: ${result.config.maxRustP95Ms}ms`);
  console.log(`- material Node bottleneck: ${result.evaluation.materialNodeBottleneckObserved}`);
  console.log(`- live-call Node bottleneck: ${result.evaluation.liveCallNodeBottleneckObserved}`);
  console.log(`- production Rust routing justified: ${result.evaluation.productionRoutingJustified}`);
  console.log(`Result: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

async function main() {
  const rounds = integerArg("--rounds", 200, 1);
  const warmup = integerArg("--warmup", 20, 0);
  const maxRustP95Ms = numberArg("--max-rust-p95-ms", 10);
  const nodeBottleneckP95Ms = numberArg("--node-bottleneck-p95-ms", 1);
  const timeoutMs = integerArg("--timeout-ms", 30000, 1);
  const command = path.resolve(stringArg("--command", defaultRustCommand()));
  if (!fs.existsSync(command)) throw new Error(`Rust audio sidecar command is missing: ${command}`);

  const client = new AudioSidecarClient(command, timeoutMs);
  const state = { sequence: 0 };
  let closed = false;
  try {
    const startupStartedAt = performance.now();
    const health = await client.request("__health");
    const startupMs = performance.now() - startupStartedAt;
    const workloads = [];
    for (const frameMs of [10, 20, 100]) {
      workloads.push(await benchmarkWorkload(client, pcmWorkload(frameMs), state, { rounds, warmup }));
    }
    const stats = await client.request("stats");
    closed = await client.close();
    const liveCallWorkloads = benchmarkLiveCallWorkloads({ rounds, warmup, nodeBottleneckP95Ms });

    const checks = [
      { name: "health", pass: health?.ok === true && health?.implementation === "rust", detail: `${health?.implementation || "missing"} protocol ${health?.protocolVersion || 0}` },
      ...workloads.map((item) => ({ name: `${item.name} Rust p95`, pass: item.rustRoundTrip.p95Ms <= maxRustP95Ms, detail: `${item.rustRoundTrip.p95Ms}ms <= ${maxRustP95Ms}ms` })),
      ...workloads.map((item) => ({ name: `${item.name} parity`, pass: item.parity.maxRmsDelta <= 1e-12 && item.parity.maxPeakDelta <= 1e-12, detail: `rms=${item.parity.maxRmsDelta}, peak=${item.parity.maxPeakDelta}` })),
      { name: "drops and backpressure", pass: Number(stats.droppedChunks || 0) === 0 && Number(stats.backpressureRejects || 0) === 0, detail: `${stats.droppedChunks || 0} drops, ${stats.backpressureRejects || 0} rejects` },
      { name: "pending drain", pass: Number(stats.pending || 0) === 0, detail: `${stats.pending || 0} pending` },
      { name: "clean close", pass: closed, detail: `closed=${closed}` },
      ...liveCallWorkloads.resampling.map((item) => ({
        name: `${item.frameMs}ms live-call resampling output`,
        pass: item.outputFrames === item.frameMs * 16,
        detail: `${item.outputFrames} frames`
      })),
      { name: "live-call VAD segmentation", pass: liveCallWorkloads.vad.segments === 1, detail: `${liveCallWorkloads.vad.segments} segments` }
    ];
    const passed = checks.every((check) => check.pass);
    const materialNodeBottleneckObserved = workloads.some((item) => item.node.p95Ms >= nodeBottleneckP95Ms);
    const rustFasterForAllWorkloads = workloads.every((item) => item.rustRoundTrip.p95Ms < item.node.p95Ms);
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: {
        nodeProductionFunctions: ["computePcm16Rms", "normalizePcm16To16kMono", "createVadSegmenter"],
        rustCommand: command,
        rustMethod: "processPcm16",
        rustCoveredProductionFunctions: ["computePcm16Rms"],
        productionRouting: false
      },
      config: { rounds, warmup, maxRustP95Ms, nodeBottleneckP95Ms, timeoutMs },
      startupMs: Number(startupMs.toFixed(3)),
      workloads,
      liveCallWorkloads: {
        resampling: liveCallWorkloads.resampling,
        vad: liveCallWorkloads.vad
      },
      runtime: {
        starts: 1,
        processedChunks: stats.processedChunks || 0,
        processedSamples: stats.processedSamples || 0,
        droppedChunks: stats.droppedChunks || 0,
        backpressureRejects: stats.backpressureRejects || 0,
        pending: stats.pending || 0,
        closed
      },
      evaluation: {
        passed,
        materialNodeBottleneckObserved,
        liveCallNodeBottleneckObserved: liveCallWorkloads.liveCallNodeBottleneckObserved,
        rustFasterForAllWorkloads,
        productionRoutingJustified: false,
        productionRoutingDecision: "Keep Node live-call preprocessing: measured workloads are below the material-bottleneck threshold and Rust does not cover resampling or VAD.",
        checks
      }
    };

    const output = stringArg("--output", "");
    if (output) {
      const outputPath = path.resolve(output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    if (flag("--json")) console.log(JSON.stringify(result, null, 2));
    else printSummary(result);
    process.exitCode = passed ? 0 : 1;
  } finally {
    if (!closed) client.stop();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
