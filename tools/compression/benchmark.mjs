#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { buildCompactSummaryInput } from "../../src/compactService.js";
import { estimateEventsTokenCount } from "../../src/contextBudget.js";
import { createSqliteEventStore } from "../../src/eventStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function numberArg(name, fallback) {
  const value = Number(stringArg(name, fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function integerArg(name, fallback, minimum) {
  const value = Number(stringArg(name, fallback));
  return Number.isFinite(value) && Number.isInteger(value) && value >= minimum ? value : fallback;
}

function flag(name) {
  return process.argv.includes(name);
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

function benchmark(kind, events, { rounds, warmup }) {
  for (let index = 0; index < warmup; index += 1) {
    buildCompactSummaryInput(events);
    estimateEventsTokenCount(events);
  }

  const summaryInput = [];
  const tokenEstimate = [];
  const combined = [];
  for (let index = 0; index < rounds; index += 1) {
    const summaryStartedAt = performance.now();
    buildCompactSummaryInput(events);
    const summaryMs = performance.now() - summaryStartedAt;

    const estimateStartedAt = performance.now();
    estimateEventsTokenCount(events);
    const estimateMs = performance.now() - estimateStartedAt;

    summaryInput.push(summaryMs);
    tokenEstimate.push(estimateMs);
    combined.push(summaryMs + estimateMs);
  }

  return {
    kind,
    events: events.length,
    textChars: events.reduce((sum, event) => sum + String(event.text || "").length, 0),
    summaryInput: timingStats(summaryInput),
    tokenEstimate: timingStats(tokenEstimate),
    combined: timingStats(combined)
  };
}

function syntheticEvents() {
  const text = "x".repeat(2000);
  return Array.from({ length: 1000 }, (_, index) => ({
    type: index % 2 ? "assistant" : "user",
    kind: index % 2 ? "assistant" : "user",
    text,
    payload: { text }
  }));
}

function realEvents(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    const owner = db.prepare(
      "SELECT task_id AS id FROM task_events GROUP BY task_id ORDER BY COUNT(*) DESC LIMIT 1"
    ).get();
    if (!owner?.id) return [];
    const store = createSqliteEventStore({ database: () => db });
    return store.listTaskEvents(String(owner.id), { after: 0, limit: 1000 });
  } finally {
    db.close();
  }
}

function printSummary(result) {
  console.log("Compression Node hot-path benchmark");
  for (const workload of result.workloads) {
    console.log(`- ${workload.kind}: ${workload.events} events, ${workload.textChars} text chars`);
    console.log(`  summary p95=${workload.summaryInput.p95Ms}ms, token p95=${workload.tokenEstimate.p95Ms}ms, combined p95=${workload.combined.p95Ms}ms`);
  }
  console.log(`- threshold: ${result.config.thresholdMs}ms combined p95`);
  console.log(`- production Rust routing justified: ${result.evaluation.productionRoutingJustified}`);
  console.log(`Result: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

function main() {
  const rounds = integerArg("--rounds", 200, 1);
  const warmup = integerArg("--warmup", 20, 0);
  const thresholdMs = numberArg("--threshold-ms", 10);
  const dbPath = path.resolve(stringArg(
    "--db",
    path.join(rootDir, ".agent-mobile-terminal", "mobile-agent.sqlite")
  ));
  const syntheticOnly = flag("--synthetic-only");
  const workloads = [];

  if (!syntheticOnly && fs.existsSync(dbPath)) {
    const events = realEvents(dbPath);
    if (events.length) workloads.push(benchmark("real-largest-task-stream", events, { rounds, warmup }));
  }
  if (flag("--require-real") && !workloads.some((item) => item.kind === "real-largest-task-stream")) {
    throw new Error(`Representative event-store data is unavailable: ${dbPath}`);
  }
  workloads.push(benchmark("synthetic-upper-bound", syntheticEvents(), { rounds, warmup }));

  const checks = workloads.map((workload) => ({
    name: `${workload.kind} combined p95`,
    pass: workload.combined.p95Ms <= thresholdMs,
    observedMs: workload.combined.p95Ms,
    thresholdMs
  }));
  const passed = checks.every((check) => check.pass);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      nodeProductionFunctions: ["buildCompactSummaryInput", "estimateEventsTokenCount"],
      rustProductionRouting: false
    },
    config: { rounds, warmup, thresholdMs },
    database: {
      representativeDataUsed: workloads.some((item) => item.kind === "real-largest-task-stream"),
      bytes: !syntheticOnly && fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0
    },
    workloads,
    evaluation: {
      passed,
      materialNodeBottleneckObserved: !passed,
      productionRoutingJustified: passed ? false : null,
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
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
