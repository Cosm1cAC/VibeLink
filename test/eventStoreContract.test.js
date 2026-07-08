import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createSqliteEventStore, normalizeEventReplayLimit } from "../src/eventStore.js";

function createStore() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
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
  return { db, store: createSqliteEventStore({ database: () => db }) };
}

test("event store appends and replays task events by cursor", () => {
  const { store } = createStore();
  const first = store.insertTaskEvent("task-1", {
    id: "task-event-1",
    at: "2026-01-01T00:00:00.000Z",
    type: "assistant",
    text: "hello",
    payload: { tokens: 3 }
  });
  const duplicate = store.insertTaskEvent("task-1", {
    id: "task-event-1",
    at: "2026-01-01T00:00:00.000Z",
    type: "assistant",
    text: "ignored duplicate"
  });

  assert.equal(duplicate, first);
  const events = store.listTaskEvents("task-1", { after: 0, limit: 10 });
  assert.equal(events.length, 1);
  assert.equal(events[0].cursor, first);
  assert.equal(events[0].kind, "assistant");
  assert.equal(events[0].payload.tokens, 3);
  assert.deepEqual(store.listTaskEvents("task-1", { after: first, limit: 10 }), []);
});

test("event store filters and prunes tool events", () => {
  const { db, store } = createStore();
  db.prepare("INSERT INTO tool_runs (id, task_id, workspace_id, tool_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("tool-1", "task-1", "workspace-1", "shell", "running", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const first = store.insertToolEvent("tool-1", { id: "tool-event-1", at: "2026-01-01T00:00:00.000Z", type: "tool.stdout", text: "one" });
  const second = store.insertToolEvent("tool-1", { id: "tool-event-2", at: "2026-01-03T00:00:00.000Z", type: "tool.completed", text: "two" });

  assert.ok(first < second);
  assert.deepEqual(store.listToolEvents({ workspaceId: "other", after: 0, limit: 10 }), []);
  assert.deepEqual(store.listToolEvents({ workspaceId: "workspace-1", after: first, limit: 10 }).map((event) => event.id), ["tool-event-2"]);
  assert.equal(store.getToolEventStats().count, 2);

  const dryRun = store.pruneToolEvents({ before: "2026-01-02T00:00:00.000Z", keepLatest: 1, dryRun: true });
  assert.equal(dryRun.prunable, 1);
  assert.equal(dryRun.deleted, 0);
  const pruned = store.pruneToolEvents({ before: "2026-01-02T00:00:00.000Z", keepLatest: 1, dryRun: false });
  assert.equal(pruned.deleted, 1);
  assert.equal(store.getToolEventStats().count, 1);
});

test("event store appends and replays live call events", () => {
  const { db, store } = createStore();
  db.prepare("INSERT INTO live_calls (id) VALUES (?)").run("session-1");
  const cursor = store.insertLiveCallEvent("session-1", {
    id: "live-event-1",
    at: "2026-01-01T00:00:00.000Z",
    type: "live_call.transcript.final",
    text: "done"
  });

  const events = store.listLiveCallEvents({ sessionId: "session-1", after: 0, limit: 10 });
  assert.equal(events.length, 1);
  assert.equal(events[0].cursor, cursor);
  assert.equal(events[0].sessionId, "session-1");
  assert.equal(events[0].type, "live_call.transcript.final");
});

test("event store replays unified events with filters", () => {
  const { db, store } = createStore();
  db.prepare("INSERT INTO tool_runs (id, task_id, workspace_id, tool_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("tool-1", "task-1", "workspace-1", "shell", "running", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO live_calls (id) VALUES (?)").run("session-1");

  store.insertTaskEvent("task-1", { id: "task-event-1", at: "2026-01-01T00:00:00.000Z", type: "assistant", text: "task" });
  store.insertToolEvent("tool-1", { id: "tool-event-1", at: "2026-01-01T00:00:01.000Z", type: "tool.stdout", text: "tool" });
  store.insertLiveCallEvent("session-1", { id: "live-event-1", at: "2026-01-01T00:00:02.000Z", type: "live_call.transcript.final", text: "live" });

  const events = store.listUnifiedEvents({ after: 0, limit: 10 });
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.kind), ["assistant", "tool", "live_call"]);
  assert.deepEqual(store.listUnifiedEvents({ taskId: "task-1", limit: 10 }).map((event) => event.kind), ["assistant", "tool"]);
  assert.deepEqual(store.listUnifiedEvents({ liveCallSessionId: "session-1", limit: 10 }).map((event) => event.kind), ["live_call"]);
});

test("event store exposes a bounded replay window contract", () => {
  const { db, store } = createStore();
  db.prepare("INSERT INTO tool_runs (id, task_id, workspace_id, tool_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("tool-1", "task-1", "workspace-1", "shell", "running", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

  store.insertTaskEvent("task-1", { id: "task-event-1", at: "2026-01-01T00:00:00.000Z", type: "assistant", text: "task" });
  store.insertToolEvent("tool-1", { id: "tool-event-1", at: "2026-01-01T00:00:01.000Z", type: "tool.stdout", text: "tool" });

  const first = store.replayWindow({ taskId: "task-1", after: 0, limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, first.items[0].cursor);

  const second = store.replayWindow({ taskId: "task-1", after: first.nextCursor, limit: 1 });
  assert.deepEqual(second.items.map((event) => event.text), ["tool"]);
  assert.equal(second.hasMore, false);
});


test("event store normalizes replay limits", () => {
  assert.equal(normalizeEventReplayLimit(undefined), 500);
  assert.equal(normalizeEventReplayLimit(0), 500);
  assert.equal(normalizeEventReplayLimit(3.9), 3);
  assert.equal(normalizeEventReplayLimit(9000), 5000);
  assert.equal(normalizeEventReplayLimit(9000, { maxLimit: 2000 }), 2000);
});


test("event store batches appends in cursor order", () => {
  const { store } = createStore();
  const cursors = store.insertTaskEvents("task-batch", [
    { id: "batch-1", at: "2026-01-01T00:00:00.000Z", type: "stdout", text: "one" },
    { id: "batch-2", at: "2026-01-01T00:00:01.000Z", type: "stdout", text: "two" }
  ]);
  assert.equal(cursors.length, 2);
  assert.ok(cursors[0] < cursors[1]);
  assert.deepEqual(store.listTaskEvents("task-batch", { after: 0 }).map((event) => event.text), ["one", "two"]);
});
