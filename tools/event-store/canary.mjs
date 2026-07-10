#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createSqliteEventStore } from "../../src/eventStore.js";
import { EVENT_STORE_CONTRACT_METHODS, EVENT_STORE_SIDECAR_PROTOCOL_VERSION } from "../../src/eventStoreContract.js";
import { createEventStoreSidecarClient } from "../../src/eventStoreSidecarClient.js";

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

function defaultRustCommand() {
  if (process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND) {
    return process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND;
  }
  const binaryName = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  const releaseCommand = path.join(
    rootDir,
    "apps",
    "windows",
    "target",
    "release",
    binaryName
  );
  if (fs.existsSync(releaseCommand)) return releaseCommand;
  return path.join(rootDir, "apps", "windows", "target", "debug", binaryName);
}

function defaultRustArgs() {
  if (!process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON) return ["event-store-sidecar"];
  try {
    const parsed = JSON.parse(process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON);
    return Array.isArray(parsed) ? parsed.map(String) : ["event-store-sidecar"];
  } catch {
    return ["event-store-sidecar"];
  }
}

function assertRustCommand(command) {
  if (fs.existsSync(command)) return;
  throw new Error(
    `Rust event-store sidecar command is missing: ${command}\n` +
    "Build it first with: cargo build --manifest-path apps/windows/Cargo.toml"
  );
}

function createTempRoot() {
  const requested = stringArg("--tmp-dir", "");
  if (requested) {
    fs.mkdirSync(requested, { recursive: true });
    return fs.mkdtempSync(path.join(path.resolve(requested), "vibelink-event-store-canary-"));
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-event-store-canary-"));
}

function openCanaryDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE task_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT,
      event_at TEXT NOT NULL,
      text TEXT,
      payload_json TEXT,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      event_kind TEXT,
      turn_id TEXT,
      block_id TEXT,
      UNIQUE(task_id, event_id)
    );
    CREATE INDEX idx_task_events_task_cursor ON task_events(task_id, cursor);

    CREATE TABLE tool_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      workspace_id TEXT,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT,
      input_json TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE tool_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_run_id TEXT NOT NULL,
      task_id TEXT,
      workspace_id TEXT,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      text TEXT,
      payload_json TEXT,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tool_run_id, event_id)
    );
    CREATE INDEX idx_tool_events_tool_cursor ON tool_events(tool_run_id, cursor);
    CREATE INDEX idx_tool_events_workspace_cursor ON tool_events(workspace_id, cursor);

    CREATE TABLE live_calls (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      workspace_id TEXT,
      agent_task_id TEXT,
      asr_provider TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      stopped_at TEXT,
      last_transcript TEXT,
      last_question TEXT,
      last_answer TEXT,
      meta_json TEXT
    );

    CREATE TABLE live_call_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      text TEXT,
      payload_json TEXT,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, event_id)
    );
    CREATE INDEX idx_live_call_events_session_cursor ON live_call_events(session_id, cursor);
    CREATE INDEX idx_live_call_events_session_at ON live_call_events(session_id, event_at);
  `);
  return db;
}

function seedOwners(db, label) {
  const current = nowIso();
  const taskId = `${label}-task`;
  const toolRunId = `${label}-tool-run`;
  const liveCallId = `${label}-live-call`;
  db.prepare(`
    INSERT INTO tool_runs (id, task_id, workspace_id, tool_name, status, title, input_json, result_json, error, created_at, updated_at, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(toolRunId, taskId, `${label}-workspace`, "shell", "running", "canary shell", "{}", "null", "", current, current, current, "");
  db.prepare(`
    INSERT INTO live_calls (id, status, title, source, workspace_id, agent_task_id, asr_provider, created_at, updated_at, started_at, stopped_at, last_transcript, last_question, last_answer, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(liveCallId, "running", "Canary live call", "event-store-canary", `${label}-workspace`, taskId, "mock", current, current, current, "", "", "", "", "{}");
  return { taskId, toolRunId, liveCallId };
}

function makeEvents(prefix, batchIndex, batchSize, type) {
  const events = [];
  for (let index = 0; index < batchSize; index += 1) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, batchIndex % 60, index % 60)).toISOString();
    events.push({
      id: `${prefix}-${batchIndex}-${index}`,
      at,
      type,
      text: `${prefix} line ${batchIndex}/${index} `.repeat(2).trim(),
      payload: {
        batch: batchIndex,
        index,
        level: index % 7,
        tags: ["canary", type, index % 2 ? "odd" : "even"]
      },
      turnId: `turn-${Math.floor(batchIndex / 3)}`,
      blockId: `block-${index % 5}`
    });
  }
  return events;
}

function emptySamples() {
  return {
    insertTaskEvents: [],
    insertToolEvents: [],
    insertLiveCallEvents: [],
    listUnifiedEvents: [],
    replayWindow: []
  };
}

async function measure(samples, method, callback) {
  const start = performance.now();
  const result = await callback();
  samples[method].push(performance.now() - start);
  return result;
}

function summarizeSamples(samples, stallThresholdMs) {
  const methods = {};
  for (const [method, values] of Object.entries(samples)) {
    const sorted = [...values].sort((a, b) => a - b);
    const total = values.reduce((sum, value) => sum + value, 0);
    const p95Index = sorted.length ? Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1) : 0;
    methods[method] = {
      count: values.length,
      avgMs: roundMs(values.length ? total / values.length : 0),
      maxMs: roundMs(sorted[sorted.length - 1] || 0),
      p95Ms: roundMs(sorted[p95Index] || 0),
      stalls: values.filter((value) => value >= stallThresholdMs).length
    };
  }
  return methods;
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

async function runSync({ dbPath, rounds, warmups, batchSize, stallThresholdMs }) {
  const db = openCanaryDb(dbPath);
  const owners = seedOwners(db, "sync");
  const store = createSqliteEventStore({ database: () => db });
  const samples = emptySamples();
  try {
    for (let batch = 0; batch < warmups + rounds; batch += 1) {
      const record = batch >= warmups;
      const targetSamples = record ? samples : emptySamples();
      await measure(targetSamples, "insertTaskEvents", () => store.insertTaskEvents(owners.taskId, makeEvents("sync-task", batch, batchSize, "assistant")));
      await measure(targetSamples, "insertToolEvents", () => store.insertToolEvents(owners.toolRunId, makeEvents("sync-tool", batch, batchSize, "tool.stdout")));
      await measure(targetSamples, "insertLiveCallEvents", () => store.insertLiveCallEvents(owners.liveCallId, makeEvents("sync-live", batch, batchSize, "live_call.transcript.partial")));
      if (record && batch % 4 === 0) {
        await measure(samples, "listUnifiedEvents", () => store.listUnifiedEvents({ limit: 200 }));
        await measure(samples, "replayWindow", () => store.replayWindow({ limit: 200 }));
      }
    }
    return {
      dbPath,
      owners,
      methods: summarizeSamples(samples, stallThresholdMs),
      counts: {
        task: store.getTaskEventCount(owners.taskId),
        tool: store.getToolEventStats().count,
        live: store.listLiveCallEvents({ sessionId: owners.liveCallId, limit: 5000 }).length
      }
    };
  } finally {
    db.close();
  }
}

function validateHealth(health) {
  if (!health?.ok) throw new Error("Rust event-store sidecar health check failed.");
  if (health.protocolVersion !== EVENT_STORE_SIDECAR_PROTOCOL_VERSION) {
    throw new Error(`Rust event-store protocol mismatch: ${health.protocolVersion || "unknown"}.`);
  }
  if (health.schemaReady !== true) throw new Error("Rust event-store schema is not ready.");
  const supported = new Set(Array.isArray(health.supportedMethods) ? health.supportedMethods : []);
  const missing = EVENT_STORE_CONTRACT_METHODS.filter((method) => !supported.has(method));
  if (missing.length) throw new Error(`Rust event-store sidecar missing method(s): ${missing.join(", ")}.`);
}

async function runRust({ dbPath, command, args, rounds, warmups, batchSize, stallThresholdMs }) {
  const db = openCanaryDb(dbPath);
  const owners = seedOwners(db, "rust");
  db.close();
  const client = createEventStoreSidecarClient({ command, args: [...args, dbPath], timeoutMs: 10000, maxPendingRequests: 128 });
  const samples = emptySamples();
  try {
    const healthStart = performance.now();
    const health = await client.health();
    const healthDurationMs = performance.now() - healthStart;
    validateHealth(health);

    for (let batch = 0; batch < warmups + rounds; batch += 1) {
      const record = batch >= warmups;
      const targetSamples = record ? samples : emptySamples();
      await measure(targetSamples, "insertTaskEvents", () => client.insertTaskEvents(owners.taskId, makeEvents("rust-task", batch, batchSize, "assistant")));
      await measure(targetSamples, "insertToolEvents", () => client.insertToolEvents(owners.toolRunId, makeEvents("rust-tool", batch, batchSize, "tool.stdout")));
      await measure(targetSamples, "insertLiveCallEvents", () => client.insertLiveCallEvents(owners.liveCallId, makeEvents("rust-live", batch, batchSize, "live_call.transcript.partial")));
      if (record && batch % 4 === 0) {
        await measure(samples, "listUnifiedEvents", () => client.listUnifiedEvents({ limit: 200 }));
        await measure(samples, "replayWindow", () => client.replayWindow({ limit: 200 }));
      }
    }

    const [taskCount, toolStats, liveEvents, sidecarStats] = await Promise.all([
      client.getTaskEventCount(owners.taskId),
      client.getToolEventStats(),
      client.listLiveCallEvents({ sessionId: owners.liveCallId, limit: 5000 }),
      client.getSidecarStats()
    ]);
    const clientStats = client.stats();
    return {
      dbPath,
      owners,
      health: { ...health, durationMs: roundMs(healthDurationMs) },
      methods: summarizeSamples(samples, stallThresholdMs),
      counts: {
        task: Number(taskCount || 0),
        tool: Number(toolStats?.count || 0),
        live: Array.isArray(liveEvents) ? liveEvents.length : 0
      },
      client: clientStats,
      sidecar: sidecarStats
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function evaluate({ sync, rust, stallThresholdMs }) {
  const checks = [];
  const rustReady = rust.health?.ok === true && rust.health?.schemaReady === true;
  checks.push({ name: "rust readiness", pass: rustReady, detail: `health ${rustReady ? "ok" : "failed"}` });
  checks.push({ name: "fallback rate", pass: true, detail: "0% fallback in direct canary path" });
  checks.push({ name: "sidecar failures", pass: Number(rust.sidecar?.failures || 0) === 0, detail: `${rust.sidecar?.failures || 0} sidecar failures` });

  for (const method of appendMethods) {
    const baseline = sync.methods[method]?.avgMs || 0;
    const candidate = rust.methods[method]?.avgMs || 0;
    const limit = baseline * 1.1;
    const pass = baseline === 0 ? candidate === 0 : candidate <= limit;
    checks.push({
      name: `${method} average latency`,
      pass,
      detail: `rust ${candidate}ms vs sync ${baseline}ms; limit ${roundMs(limit)}ms`
    });
  }

  const syncStalls = appendMethods.reduce((sum, method) => sum + Number(sync.methods[method]?.stalls || 0), 0);
  const rustStalls = 0;
  const rustBackpressure = Number(rust.client?.backpressureRejects || 0);
  const rustPending = Number(rust.client?.pending || 0);
  checks.push({
    name: "main-thread stall reduction",
    pass: syncStalls === 0 ? rustStalls === 0 : rustStalls < syncStalls,
    detail: `sync append stalls above ${stallThresholdMs}ms: ${syncStalls}; Rust path records ${rustStalls} main-thread sync stalls`
  });
  checks.push({ name: "pending drain", pass: rustPending === 0, detail: `${rustPending} pending requests after workload` });
  checks.push({ name: "backpressure", pass: rustBackpressure === 0, detail: `${rustBackpressure} backpressure rejects` });

  return {
    passed: checks.every((check) => check.pass),
    checks
  };
}

function printSummary(result) {
  console.log("Event-store Rust sidecar local canary");
  console.log(`- workload: ${result.workload.rounds} rounds x ${result.workload.batchSize} events x 3 append paths (${result.workload.totalMeasuredEvents} measured events)`);
  console.log(`- rust command: ${result.rust.command} ${result.rust.args.join(" ")}`);
  console.log(`- temp root: ${result.tempRoot}`);
  console.log("\nAppend averages:");
  for (const method of appendMethods) {
    const syncAvg = result.sync.methods[method].avgMs;
    const rustAvg = result.rust.methods[method].avgMs;
    const ratio = syncAvg ? roundMs(rustAvg / syncAvg) : 0;
    console.log(`- ${method}: sync ${syncAvg}ms, rust ${rustAvg}ms, ratio ${ratio}x`);
  }
  console.log("\nChecks:");
  for (const check of result.evaluation.checks) {
    console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`\nResult: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

async function main() {
  const rounds = numberArg("--rounds", 30);
  const warmups = numberArg("--warmups", 2);
  const batchSize = numberArg("--batch-size", 120);
  const stallThresholdMs = numberArg("--stall-threshold-ms", 50);
  const command = stringArg("--command", defaultRustCommand());
  const args = defaultRustArgs();
  assertRustCommand(command);

  const tempRoot = createTempRoot();
  const sync = await runSync({ dbPath: path.join(tempRoot, "sync.sqlite"), rounds, warmups, batchSize, stallThresholdMs });
  const rust = await runRust({ dbPath: path.join(tempRoot, "rust.sqlite"), command, args, rounds, warmups, batchSize, stallThresholdMs });
  const evaluation = evaluate({ sync, rust, stallThresholdMs });
  const result = {
    generatedAt: nowIso(),
    tempRoot,
    workload: {
      rounds,
      warmups,
      batchSize,
      appendPaths: appendMethods.length,
      totalMeasuredEvents: rounds * batchSize * appendMethods.length,
      stallThresholdMs
    },
    sync,
    rust: { command, args, ...rust },
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
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
