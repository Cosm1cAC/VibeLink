import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createEventStoreSidecarClient } from "../src/eventStoreSidecarClient.js";

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

test("event store sidecar client handles append and replay requests", async () => {
  const { dir, dbPath } = createSidecarDb();
  const client = createEventStoreSidecarClient({
    command: process.execPath,
    args: [path.join("test", "fixtures", "fake-event-store-sidecar.js")],
    dbPath,
    timeoutMs: 5000
  });

  try {
    await client.insertTaskEvent("task-sidecar", {
      id: "task-event-sidecar",
      at: "2026-01-01T00:00:00.000Z",
      type: "assistant",
      text: "task"
    });
    await client.insertToolEvent("tool-sidecar", {
      id: "tool-event-sidecar",
      at: "2026-01-01T00:00:01.000Z",
      type: "tool.stdout",
      text: "tool"
    });
    await client.insertLiveCallEvent("session-sidecar", {
      id: "live-event-sidecar",
      at: "2026-01-01T00:00:02.000Z",
      type: "live_call.transcript.final",
      text: "live"
    });

    assert.equal(await client.getTaskEventCount("task-sidecar"), 1);
    assert.deepEqual((await client.listTaskEvents("task-sidecar", { after: 0, limit: 10 })).map((event) => event.text), ["task"]);
    assert.deepEqual((await client.listUnifiedEvents({ after: 0, limit: 10 })).map((event) => event.kind), ["assistant", "tool", "live_call"]);
    assert.equal(client.stats().pending, 0);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("event store sidecar client rejects requests above the pending cap", async () => {
  const { dir, dbPath } = createSidecarDb();
  const client = createEventStoreSidecarClient({
    command: process.execPath,
    args: [path.join("test", "fixtures", "fake-event-store-sidecar.js")],
    dbPath,
    timeoutMs: 5000,
    maxPendingRequests: 1
  });

  try {
    const first = client.request("listTaskEvents", ["task-sidecar", { after: 0, limit: 10 }]);
    await assert.rejects(
      client.request("listTaskEvents", ["task-sidecar", { after: 0, limit: 10 }]),
      (error) => error.code === "EEVENTSTORESIDECARBACKPRESSURE"
    );
    assert.deepEqual(await first, []);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});