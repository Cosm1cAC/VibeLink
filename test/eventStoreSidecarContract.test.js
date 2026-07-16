import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EVENT_STORE_CONTRACT_METHODS,
  EVENT_STORE_SIDECAR_PROTOCOL_VERSION
} from "../src/eventStoreContract.js";
import { createEventStoreSidecarClient } from "../src/eventStoreSidecarClient.js";

function cargoPath() {
  if (process.platform === "win32") {
    const result = spawnSync("where.exe", ["cargo"], { encoding: "utf8", windowsHide: true });
    return result.status === 0 ? String(result.stdout || "").split(/\r?\n/).find(Boolean) || "" : "";
  }
  const result = spawnSync("sh", ["-lc", "command -v cargo"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout || "").trim().split(/\r?\n/)[0] || "" : "";
}

function parseRustSidecarArgs() {
  if (!process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON) return ["event-store-sidecar"];
  try {
    const parsed = JSON.parse(process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON);
    return Array.isArray(parsed) ? parsed.map(String) : ["event-store-sidecar"];
  } catch {
    return ["event-store-sidecar"];
  }
}

function rustSidecarTimeoutMs(fallback) {
  const parsed = Number(process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function rustSidecarRunner(dbPath, extraArgs = []) {
  if (process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND) {
    return {
      command: process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND,
      args: [...parseRustSidecarArgs(), dbPath, ...extraArgs],
      timeoutMs: rustSidecarTimeoutMs(30000)
    };
  }

  const binaryName = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["release", "debug"]) {
    const command = path.join(process.cwd(), "apps", "windows", "target", profile, binaryName);
    if (fs.existsSync(command)) {
      return {
        command,
        args: ["event-store-sidecar", dbPath, ...extraArgs],
        timeoutMs: 30000
      };
    }
  }

  const cargo = cargoPath();
  if (!cargo) return null;
  return {
    command: cargo,
    args: [
      "run",
      "--quiet",
      "--manifest-path",
      path.join(process.cwd(), "apps", "windows", "Cargo.toml"),
      "--",
      "event-store-sidecar",
      dbPath,
      ...extraArgs
    ],
    timeoutMs: 120000
  };
}

function rustSidecarClient(t, dbPath, options = {}) {
  const { sidecarArgs = [], ...clientOptions } = options;
  const runner = rustSidecarRunner(dbPath, sidecarArgs);
  if (!runner) {
    t.skip("Rust event-store sidecar is not available");
    return null;
  }
  return createEventStoreSidecarClient({
    ...runner,
    ...clientOptions
  });
}

function createSidecarDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-event-store-sidecar-"));
  const dbPath = path.join(dir, "events.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
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
    CREATE TABLE tool_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      workspace_id TEXT,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
    CREATE TABLE live_calls (id TEXT PRIMARY KEY);
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
  `);
  db.prepare("INSERT INTO tool_runs (id, task_id, workspace_id, tool_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("tool-sidecar", "task-sidecar", "workspace-sidecar", "shell", "running", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO live_calls (id) VALUES (?)").run("session-sidecar");
  db.close();
  return { dir, dbPath };
}

test("event store JSON sidecar contract handles append and replay requests", async () => {
  const { dir, dbPath } = createSidecarDb();
  const client = createEventStoreSidecarClient({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/event-store-json-sidecar.js", import.meta.url)), dbPath],
    timeoutMs: 5000
  });

  try {
    const health = await client.health();
    assert.equal(health.ok, true);
    assert.equal(health.implementation, "node-fixture");
    assert.equal(health.protocolVersion, EVENT_STORE_SIDECAR_PROTOCOL_VERSION);
    assert.deepEqual(health.supportedMethods, EVENT_STORE_CONTRACT_METHODS);
    assert.equal(health.schemaReady, true);

    const taskCursors = await client.insertTaskEvents("task-sidecar", [
      {
        id: "task-event-sidecar-1",
        at: "2026-01-01T00:00:00.000Z",
        type: "stdout",
        text: "task one"
      },
      {
        id: "task-event-sidecar-2",
        at: "2026-01-01T00:00:01.000Z",
        type: "assistant",
        text: "task two"
      }
    ]);
    await client.insertToolEvent("tool-sidecar", {
      id: "tool-event-sidecar",
      at: "2026-01-01T00:00:02.000Z",
      type: "tool.stdout",
      text: "tool"
    });
    await client.insertLiveCallEvent("session-sidecar", {
      id: "live-event-sidecar",
      at: "2026-01-01T00:00:03.000Z",
      type: "live_call.transcript.final",
      text: "live"
    });

    assert.equal(taskCursors.length, 2);
    assert.ok(taskCursors[0] < taskCursors[1]);
    assert.deepEqual((await client.listTaskEvents("task-sidecar", { after: 0, limit: 10 })).map((event) => event.text), ["task one", "task two"]);
    assert.deepEqual((await client.listUnifiedEvents({ after: 0, limit: 10 })).map((event) => event.kind), ["output", "tool", "live_call", "assistant"]);
    assert.equal((await client.replayWindow({ after: 0, limit: 2 })).hasMore, true);
    await assert.rejects(
      client.request("missingMethod", []),
      /Unsupported event store sidecar method: missingMethod/
    );
    const remoteStats = await client.getSidecarStats();
    assert.equal(remoteStats.implementation, "node-fixture");
    assert.equal(remoteStats.protocolVersion, EVENT_STORE_SIDECAR_PROTOCOL_VERSION);
    assert.equal(remoteStats.pending, 0);
    assert.equal(remoteStats.requests >= 7, true);
    assert.equal(remoteStats.responses >= 6, true);
    assert.equal(remoteStats.failures, 1);
    const localStats = client.stats();
    assert.equal(localStats.pending, 0);
    assert.equal(localStats.requests >= 8, true);
    assert.equal(localStats.responses >= 7, true);
    assert.equal(localStats.failures, 1);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("event store sidecar client rejects invalid JSON responses", async () => {
  const client = createEventStoreSidecarClient({
    command: process.execPath,
    args: ["-e", "process.stdin.resume(); process.stdout.write('not-json\\n'); setTimeout(() => {}, 1000);"],
    timeoutMs: 5000
  });

  try {
    await assert.rejects(
      client.health(),
      /Event store sidecar returned invalid JSON/
    );
    assert.equal(client.stats().failures, 1);
  } finally {
    await client.close();
  }
});

test("event store sidecar client times out unanswered requests", async () => {
  const client = createEventStoreSidecarClient({
    command: process.execPath,
    args: ["-e", "process.stdin.resume();"],
    timeoutMs: 25
  });

  try {
    await assert.rejects(
      client.health(),
      /Event store sidecar request timed out: __health/
    );
    assert.equal(client.stats().timeouts, 1);
    assert.equal(client.stats().failures, 1);
  } finally {
    await client.close();
  }
});

test("event store JSON sidecar contract works against the Rust sidecar", async (t) => {
  const { dir, dbPath } = createSidecarDb();
  const client = rustSidecarClient(t, dbPath);
  if (!client) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }

  try {
    const health = await client.health();
    assert.equal(health.ok, true);
    assert.equal(health.implementation, "rust");
    assert.equal(health.protocolVersion, EVENT_STORE_SIDECAR_PROTOCOL_VERSION);
    assert.deepEqual(health.supportedMethods, EVENT_STORE_CONTRACT_METHODS);
    assert.equal(health.schemaReady, true);

    const taskCursors = await client.insertTaskEvents("task-sidecar", [
      {
        id: "task-event-rust-sidecar-1",
        at: "2026-01-01T00:00:00.000Z",
        type: "stdout",
        text: "task one"
      },
      {
        id: "task-event-rust-sidecar-2",
        at: "2026-01-01T00:00:01.000Z",
        type: "assistant",
        text: "task two"
      }
    ]);
    await client.insertToolEvent("tool-sidecar", {
      id: "tool-event-rust-sidecar",
      at: "2026-01-01T00:00:02.000Z",
      type: "tool.stdout",
      text: "tool"
    });
    await client.insertLiveCallEvent("session-sidecar", {
      id: "live-event-rust-sidecar",
      at: "2026-01-01T00:00:03.000Z",
      type: "live_call.transcript.final",
      text: "live"
    });

    assert.equal(taskCursors.length, 2);
    assert.ok(taskCursors[0] < taskCursors[1]);
    assert.deepEqual((await client.listTaskEvents("task-sidecar", { after: 0, limit: 10 })).map((event) => event.text), ["task one", "task two"]);
    assert.deepEqual((await client.listUnifiedEvents({ after: 0, limit: 10 })).map((event) => event.kind), ["output", "tool", "live_call", "assistant"]);
    assert.equal((await client.replayWindow({ after: 0, limit: 2 })).hasMore, true);
    await assert.rejects(
      client.request("missingMethod", []),
      /Unsupported event store sidecar method: missingMethod/
    );
    const remoteStats = await client.getSidecarStats();
    assert.equal(remoteStats.implementation, "rust");
    assert.equal(remoteStats.protocolVersion, EVENT_STORE_SIDECAR_PROTOCOL_VERSION);
    assert.equal(remoteStats.pending, 0);
    assert.equal(remoteStats.requests >= 7, true);
    assert.equal(remoteStats.responses >= 6, true);
    assert.equal(remoteStats.failures, 1);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust event store sidecar read-only mode serves replay and rejects writes", async (t) => {
  const { dir, dbPath } = createSidecarDb();
  const writer = rustSidecarClient(t, dbPath);
  if (!writer) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }

  try {
    await writer.insertTaskEvent("task-sidecar", {
      id: "task-event-read-only",
      at: "2026-01-01T00:00:00.000Z",
      type: "assistant",
      text: "read-only replay"
    });
  } finally {
    await writer.close();
  }

  const client = rustSidecarClient(t, dbPath, { sidecarArgs: ["--read-only"] });
  try {
    const health = await client.health();
    assert.equal(health.ok, true);
    assert.equal(health.readOnly, true);
    assert.equal((await client.listTaskEvents("task-sidecar", { after: 0, limit: 10 })).length, 1);

    const before = new DatabaseSync(dbPath, { readOnly: true });
    const beforeCount = before.prepare("SELECT COUNT(*) AS count FROM task_events").get().count;
    before.close();
    await assert.rejects(
      client.insertTaskEvent("task-sidecar", {
        id: "task-event-rejected",
        at: "2026-01-01T00:00:01.000Z",
        type: "assistant",
        text: "must not be written"
      }),
      /read-only/i
    );
    const after = new DatabaseSync(dbPath, { readOnly: true });
    const afterCount = after.prepare("SELECT COUNT(*) AS count FROM task_events").get().count;
    after.close();
    assert.equal(afterCount, beforeCount);

    const stats = await client.getSidecarStats();
    assert.equal(stats.readOnly, true);
    assert.equal(stats.failures, 1);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
