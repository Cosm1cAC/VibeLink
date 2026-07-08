import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createEventStoreWorkerClient } from "../src/eventStoreWorkerClient.js";

function createWorkerDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-event-store-worker-"));
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
    .run("tool-worker", "task-worker", "workspace-worker", "shell", "running", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO live_calls (id) VALUES (?)").run("session-worker");
  db.close();
  return { dir, dbPath };
}

test("event store worker handles append and replay requests", async () => {
  const { dir, dbPath } = createWorkerDb();
  const client = createEventStoreWorkerClient({ dbPath, timeoutMs: 5000 });
  try {
    await client.insertTaskEvent("task-worker", {
      id: "task-event-worker",
      at: "2026-01-01T00:00:00.000Z",
      type: "assistant",
      text: "task"
    });
    await client.insertToolEvent("tool-worker", {
      id: "tool-event-worker",
      at: "2026-01-01T00:00:01.000Z",
      type: "tool.stdout",
      text: "tool"
    });
    await client.insertLiveCallEvent("session-worker", {
      id: "live-event-worker",
      at: "2026-01-01T00:00:02.000Z",
      type: "live_call.transcript.final",
      text: "live"
    });

    assert.equal(await client.getTaskEventCount("task-worker"), 1);
    assert.deepEqual((await client.listTaskEvents("task-worker", { after: 0, limit: 10 })).map((event) => event.text), ["task"]);
    assert.deepEqual((await client.listUnifiedEvents({ after: 0, limit: 10 })).map((event) => event.kind), ["assistant", "tool", "live_call"]);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
