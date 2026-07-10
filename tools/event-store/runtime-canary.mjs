#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");
const appendMethods = ["insertTaskEvents", "insertToolEvents", "insertLiveCallEvents"];

function numberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return String(process.argv[index + 1] || fallback);
}

function flag(name) {
  return process.argv.includes(name);
}

function nowIso() {
  return new Date().toISOString();
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function defaultRustCommand() {
  if (process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND) {
    return process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND;
  }
  const binaryName = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  const releaseCommand = path.join(rootDir, "apps", "windows", "target", "release", binaryName);
  if (fs.existsSync(releaseCommand)) return releaseCommand;
  return path.join(rootDir, "apps", "windows", "target", "debug", binaryName);
}

function assertRustCommand(command) {
  if (fs.existsSync(command)) return;
  throw new Error(
    `Rust event-store sidecar command is missing: ${command}\n` +
    "Build it first with: cargo build --release --manifest-path apps/windows/Cargo.toml"
  );
}

function createTempRoot() {
  const requested = stringArg("--tmp-dir", "");
  if (requested) {
    fs.mkdirSync(requested, { recursive: true });
    return fs.mkdtempSync(path.join(path.resolve(requested), "vibelink-event-store-runtime-canary-"));
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-event-store-runtime-canary-"));
}

function configureRuntime({ dataDir, command, batchSize }) {
  process.env.VIBELINK_DATA_DIR = dataDir;
  process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR = "auto";
  process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND = command;
  process.env.VIBELINK_EVENT_STORE_BATCH_APPEND = "1";
  process.env.VIBELINK_EVENT_STORE_BATCH_TASK_APPEND = "1";
  process.env.VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND = "1";
  process.env.VIBELINK_EVENT_STORE_BATCH_DELAY_MS = "0";
  process.env.VIBELINK_EVENT_STORE_BATCH_MAX_SIZE = String(Math.max(batchSize * 2, 1));
}

function makeEvents(prefix, batchIndex, batchSize, type, extra = {}) {
  const events = [];
  for (let index = 0; index < batchSize; index += 1) {
    const at = new Date(Date.UTC(2026, 0, 2, 0, batchIndex % 60, index % 60)).toISOString();
    events.push({
      id: `${prefix}-${batchIndex}-${index}`,
      at,
      type,
      text: `${prefix} runtime line ${batchIndex}/${index}`,
      payload: {
        batch: batchIndex,
        index,
        source: "event-store-runtime-canary"
      },
      ...extra
    });
  }
  return events;
}

async function measure(samples, method, callback) {
  const start = performance.now();
  const result = await callback();
  samples[method].push(performance.now() - start);
  return result;
}

function summarizeSamples(samples) {
  const summary = {};
  for (const [method, values] of Object.entries(samples)) {
    const sorted = [...values].sort((a, b) => a - b);
    const total = values.reduce((sum, value) => sum + value, 0);
    const p95Index = sorted.length ? Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1) : 0;
    summary[method] = {
      count: values.length,
      avgMs: roundMs(values.length ? total / values.length : 0),
      maxMs: roundMs(sorted[sorted.length - 1] || 0),
      p95Ms: roundMs(sorted[p95Index] || 0)
    };
  }
  return summary;
}

function methodStats(stats, method) {
  return stats?.metrics?.methods?.[method] || {
    count: 0,
    failures: 0,
    fallbacks: 0,
    avgDurationMs: 0,
    maxDurationMs: 0,
    modeCounts: {}
  };
}

function evaluate({ stats, workload, maxAppendAvgMs }) {
  const checks = [];
  const rust = stats.rustSidecar || {};
  checks.push({
    name: "rust readiness",
    pass: rust.enabled === true && rust.available === true && rust.ready === true && rust.failed === false,
    detail: `enabled=${Boolean(rust.enabled)} available=${Boolean(rust.available)} ready=${Boolean(rust.ready)} failed=${Boolean(rust.failed)}`
  });
  checks.push({
    name: "runtime mode",
    pass: stats.mode === "rust-sidecar",
    detail: `mode=${stats.mode}`
  });
  checks.push({
    name: "fallback rate",
    pass: Number(stats.metrics?.fallbacks || 0) === 0 && Number(rust.fallbacks || 0) === 0,
    detail: `metrics=${stats.metrics?.fallbacks || 0}, rust=${rust.fallbacks || 0}`
  });
  checks.push({
    name: "failures",
    pass: Number(stats.metrics?.failures || 0) === 0 && Number(rust.failures || 0) === 0,
    detail: `metrics=${stats.metrics?.failures || 0}, rust=${rust.failures || 0}`
  });

  for (const method of appendMethods) {
    const item = methodStats(stats, method);
    const rustCount = Number(item.modeCounts?.["rust-sidecar"] || 0);
    checks.push({
      name: `${method} rust routing`,
      pass: rustCount >= workload.rounds,
      detail: `${rustCount} rust-sidecar calls for ${workload.rounds} rounds`
    });
    checks.push({
      name: `${method} average latency`,
      pass: Number(item.avgDurationMs || 0) <= maxAppendAvgMs,
      detail: `${item.avgDurationMs || 0}ms average; limit ${maxAppendAvgMs}ms`
    });
    checks.push({
      name: `${method} method health`,
      pass: Number(item.failures || 0) === 0 && Number(item.fallbacks || 0) === 0,
      detail: `${item.failures || 0} failures, ${item.fallbacks || 0} fallbacks`
    });
  }

  checks.push({
    name: "sync stalls",
    pass: Number(stats.metrics?.stalls?.count || 0) === 0,
    detail: `${stats.metrics?.stalls?.count || 0} sync stalls above ${stats.metrics?.stalls?.thresholdMs || 50}ms`
  });
  checks.push({
    name: "pending drain",
    pass: Number(rust.client?.pending || 0) === 0,
    detail: `${rust.client?.pending || 0} pending requests after workload`
  });
  checks.push({
    name: "backpressure",
    pass: Number(rust.client?.backpressureRejects || 0) === 0,
    detail: `${rust.client?.backpressureRejects || 0} backpressure rejects`
  });

  return {
    passed: checks.every((check) => check.pass),
    checks
  };
}

function printSummary(result) {
  console.log("Event-store Rust sidecar runtime canary");
  console.log(`- workload: ${result.workload.rounds} rounds x ${result.workload.batchSize} events x 3 append paths (${result.workload.totalEvents} queued events)`);
  console.log(`- data dir: ${result.dataDir}`);
  console.log(`- rust command: ${result.runtime.rustSidecar.command}`);
  console.log(`- mode: ${result.runtime.mode}`);
  console.log("\nRuntime append metrics:");
  for (const method of appendMethods) {
    const stats = result.runtime.metrics.methods[method] || {};
    console.log(`- ${method}: count ${stats.count || 0}, avg ${stats.avgDurationMs || 0}ms, max ${stats.maxDurationMs || 0}ms, modes ${JSON.stringify(stats.modeCounts || {})}`);
  }
  console.log("\nOuter flush timings:");
  for (const method of appendMethods) {
    const sample = result.flushTimings[method] || {};
    console.log(`- ${method}: avg ${sample.avgMs || 0}ms, p95 ${sample.p95Ms || 0}ms, max ${sample.maxMs || 0}ms`);
  }
  console.log("\nChecks:");
  for (const check of result.evaluation.checks) {
    console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`\nResult: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

async function main() {
  const rounds = numberArg("--rounds", 24);
  const batchSize = numberArg("--batch-size", 100);
  const maxAppendAvgMs = numberArg("--max-append-avg-ms", 50);
  const command = stringArg("--command", defaultRustCommand());
  assertRustCommand(command);

  const dataDir = createTempRoot();
  configureRuntime({ dataDir, command, batchSize });

  const db = await import("../../src/db.js");
  const taskId = "runtime-canary-task";
  const toolRunId = "runtime-canary-tool-run";
  const liveCallId = "runtime-canary-live-call";
  const samples = {
    insertTaskEvents: [],
    insertToolEvents: [],
    insertLiveCallEvents: []
  };

  try {
    db.upsertTask({
      id: taskId,
      agent: "canary",
      title: "Event store runtime canary",
      cwd: rootDir,
      status: "running",
      commandLabel: "event-store:runtime-canary"
    });
    db.createToolRun({
      id: toolRunId,
      taskId,
      toolName: "runtime.canary",
      status: "running",
      title: "Runtime canary tool stream",
      input: { source: "event-store-runtime-canary" },
      startedAt: nowIso()
    });
    db.createLiveCall({
      id: liveCallId,
      status: "running",
      title: "Runtime canary live stream",
      source: "event-store-runtime-canary",
      agentTaskId: taskId,
      startedAt: nowIso()
    });

    await db.getToolEventStatsAsync();
    const before = db.getEventStoreRuntimeStats();

    for (let batch = 0; batch < rounds; batch += 1) {
      await measure(samples, "insertTaskEvents", async () => {
        const promises = makeEvents("runtime-task", batch, batchSize, "assistant", {
          turnId: `turn-${Math.floor(batch / 3)}`,
          blockId: `block-${batch % 5}`
        }).map((event) => db.insertTaskEventBatchedAsync(taskId, event));
        await db.flushTaskEventBatches();
        await Promise.all(promises);
      });

      await measure(samples, "insertToolEvents", async () => {
        const promises = makeEvents("runtime-tool", batch, batchSize, "tool.stdout", {
          taskId,
          toolRunId
        }).map((event) => db.insertToolEventBatchedAsync(toolRunId, event));
        await db.flushToolEventBatches();
        await Promise.all(promises);
      });

      await measure(samples, "insertLiveCallEvents", async () => {
        const promises = makeEvents("runtime-live", batch, batchSize, "live_call.transcript.partial", {
          sessionId: liveCallId
        }).map((event) => db.insertLiveCallEventBatchedAsync(liveCallId, event));
        await db.flushLiveCallEventBatches();
        await Promise.all(promises);
      });

      if (batch % 4 === 0) {
        await db.listTaskEventsAsync(taskId, { limit: 200 });
        await db.listToolEventsAsync({ toolRunId, limit: 200 });
        await db.listLiveCallEventsAsync({ sessionId: liveCallId, limit: 200 });
        await db.replayEventWindowAsync({ taskId, toolRunId, liveCallSessionId: liveCallId, limit: 200 });
      }
    }

    await db.flushTaskEventBatches();
    await db.flushToolEventBatches();
    await db.flushLiveCallEventBatches();
    await db.getToolEventStatsAsync();

    const runtime = db.getEventStoreRuntimeStats();
    const workload = {
      rounds,
      batchSize,
      appendPaths: appendMethods.length,
      totalEvents: rounds * batchSize * appendMethods.length,
      maxAppendAvgMs
    };
    const evaluation = evaluate({ stats: runtime, workload, maxAppendAvgMs });
    const result = {
      generatedAt: nowIso(),
      dataDir,
      workload,
      before,
      runtime,
      flushTimings: summarizeSamples(samples),
      evaluation
    };

    const output = stringArg("--output", "");
    if (output) {
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    if (flag("--json")) console.log(JSON.stringify(result, null, 2));
    else printSummary(result);
    process.exitCode = evaluation.passed ? 0 : 1;
  } finally {
    await db.drainEventStoreRuntime().catch(() => {});
    if (flag("--delete-temp")) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[runtime-canary] temp cleanup skipped: ${error.message}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
