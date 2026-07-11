#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { createSqliteEventStore } from "../../src/eventStore.js";
import { createEventStoreSidecarClient } from "../../src/eventStoreSidecarClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function numberArg(name, fallback) {
  const parsed = Number(stringArg(name, fallback));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function defaultRustCommand() {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  const release = path.join(rootDir, "apps", "windows", "target", "release", binary);
  if (fs.existsSync(release)) return release;
  return path.join(rootDir, "apps", "windows", "target", "debug", binary);
}

function cursorRange(items = []) {
  const cursors = items.map((item) => Number(item.cursor || 0)).filter((value) => value > 0);
  return { firstCursor: cursors[0] || 0, lastCursor: cursors[cursors.length - 1] || 0 };
}

function printSummary(result) {
  console.log("Event-store Rust real-data replay canary");
  console.log(`- database: ${result.database.path} (${result.database.bytes} bytes)`);
  for (const stream of result.streams) {
    console.log(`- ${stream.kind}: ${stream.rows} rows, ${stream.unifiedRows} unified, ${stream.windowRows} window`);
  }
  console.log("\nChecks:");
  for (const check of result.evaluation.checks) {
    console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`\nResult: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

async function main() {
  const dbPath = path.resolve(stringArg("--db", path.join(rootDir, ".agent-mobile-terminal", "mobile-agent.sqlite")));
  const command = path.resolve(stringArg("--command", defaultRustCommand()));
  const limit = numberArg("--limit", 50);
  if (!fs.existsSync(dbPath)) throw new Error(`Real event-store database is missing: ${dbPath}`);
  if (!fs.existsSync(command)) throw new Error(`Rust event-store sidecar command is missing: ${command}`);

  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  const store = createSqliteEventStore({ database: () => db });
  const client = createEventStoreSidecarClient({
    command,
    args: ["event-store-sidecar", dbPath, "--read-only"],
    timeoutMs: numberArg("--timeout-ms", 120000)
  });

  function latestOwner(table, column) {
    return String(db.prepare(`SELECT ${column} AS id FROM ${table} ORDER BY cursor DESC LIMIT 1`).get()?.id || "");
  }

  try {
    const owners = {
      task: latestOwner("task_events", "task_id"),
      tool: latestOwner("tool_events", "tool_run_id"),
      live: latestOwner("live_call_events", "session_id")
    };
    const health = await client.health();
    const descriptors = [
      {
        kind: "task",
        id: owners.task,
        listNode: () => store.listTaskEvents(owners.task, { after: 0, limit }),
        listRust: () => client.listTaskEvents(owners.task, { after: 0, limit }),
        filter: { taskId: owners.task, after: 0, limit }
      },
      {
        kind: "tool",
        id: owners.tool,
        listNode: () => store.listToolEvents({ toolRunId: owners.tool, after: 0, limit }),
        listRust: () => client.listToolEvents({ toolRunId: owners.tool, after: 0, limit }),
        filter: { toolRunId: owners.tool, after: 0, limit }
      },
      {
        kind: "live",
        id: owners.live,
        listNode: () => store.listLiveCallEvents({ sessionId: owners.live, after: 0, limit }),
        listRust: () => client.listLiveCallEvents({ sessionId: owners.live, after: 0, limit }),
        filter: { liveCallSessionId: owners.live, after: 0, limit }
      }
    ];
    const streams = [];
    const checks = [
      { name: "read-only readiness", pass: health.ok === true && health.schemaReady === true && health.readOnly === true, detail: `ok=${health.ok}, schemaReady=${health.schemaReady}, readOnly=${health.readOnly}` },
      { name: "real stream owners", pass: descriptors.every((item) => Boolean(item.id)), detail: `${descriptors.filter((item) => item.id).length}/3 stream owners available` }
    ];

    for (const descriptor of descriptors) {
      if (!descriptor.id) continue;
      const nodeRows = descriptor.listNode();
      const rustRows = await descriptor.listRust();
      const nodeUnified = store.listUnifiedEvents(descriptor.filter);
      const rustUnified = await client.listUnifiedEvents(descriptor.filter);
      const nodeWindow = store.replayWindow(descriptor.filter);
      const rustWindow = await client.replayWindow(descriptor.filter);
      const listParity = isDeepStrictEqual(rustRows, nodeRows);
      const unifiedParity = isDeepStrictEqual(rustUnified, nodeUnified);
      const windowParity = isDeepStrictEqual(rustWindow, nodeWindow);
      checks.push({ name: `${descriptor.kind} list parity`, pass: listParity && nodeRows.length > 0, detail: `${rustRows.length} Rust rows vs ${nodeRows.length} Node rows` });
      checks.push({ name: `${descriptor.kind} unified parity`, pass: unifiedParity && nodeUnified.length > 0, detail: `${rustUnified.length} Rust rows vs ${nodeUnified.length} Node rows` });
      checks.push({ name: `${descriptor.kind} window parity`, pass: windowParity && nodeWindow.items.length > 0, detail: `${rustWindow.items.length} Rust rows vs ${nodeWindow.items.length} Node rows` });
      streams.push({
        kind: descriptor.kind,
        rows: nodeRows.length,
        unifiedRows: nodeUnified.length,
        windowRows: nodeWindow.items.length,
        ...cursorRange(nodeRows)
      });
    }

    const stats = await client.getSidecarStats();
    checks.push({ name: "sidecar health", pass: stats.readOnly === true && stats.failures === 0 && stats.pending === 0 && !stats.lastError, detail: `failures=${stats.failures}, pending=${stats.pending}, readOnly=${stats.readOnly}` });
    const result = {
      generatedAt: new Date().toISOString(),
      database: { path: dbPath, bytes: fs.statSync(dbPath).size },
      command,
      workload: { limit, streamTypes: streams.length },
      owners: Object.fromEntries(Object.entries(owners).map(([kind, id]) => [kind, Boolean(id)])),
      streams,
      sidecar: { requests: stats.requests, responses: stats.responses, failures: stats.failures, pending: stats.pending, readOnly: stats.readOnly },
      evaluation: { passed: checks.every((check) => check.pass), checks }
    };

    const output = stringArg("--output", "");
    if (output) {
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    if (flag("--json")) console.log(JSON.stringify(result, null, 2));
    else printSummary(result);
    process.exitCode = result.evaluation.passed ? 0 : 1;
  } finally {
    await client.close();
    db.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
