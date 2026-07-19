import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createContentSearchIndexer } from "../src/contentSearchIndexer.js";
import { createSearchStore } from "../src/searchStore.js";

function jsonlEntry(role, text, timestamp) {
  return JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
}

test("content index tails agent JSONL and task event cursors without rereading old events", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-content-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logPath = path.join(root, "session.jsonl");
  fs.writeFileSync(logPath, `${jsonlEntry("user", "first durable marker", "2026-01-01T00:00:00Z")}\n`, "utf8");
  const db = new DatabaseSync(":memory:");
  const store = createSearchStore({ database: () => db });
  const histories = [{ id: "s1", provider: "codex", sessionOrigin: "vibelink-cli", title: "Durable session", preview: "first durable marker", updatedAt: "2026-01-01T00:00:00Z", filePath: logPath }];
  const tasks = [{ id: "t1", agent: "codex", sessionId: "s1", title: "Durable task", updatedAt: "2026-01-01T00:00:00Z" }];
  const taskEvents = [
    { cursor: 4, type: "assistant", text: "task cursor marker", at: "2026-01-01T00:00:01Z" }
  ];
  const reads = [];
  const indexer = createContentSearchIndexer({
    store,
    getHistories: () => histories,
    getTasks: () => tasks,
    listTaskEvents: (_id, { after }) => { reads.push(after); return taskEvents.filter((event) => event.cursor > after); }
  });

  await indexer.refresh();
  assert.equal(store.queryContent("first durable", { kinds: ["message"] }).length, 1);
  assert.equal(store.queryContent("first durable", { kinds: ["message"], sessionOrigin: "vibelink-cli" }).length, 1);
  assert.equal(store.queryContent("first durable", { kinds: ["message"], sessionOrigin: "codex-desktop" }).length, 0);
  assert.equal(store.queryContent("task cursor", { kinds: ["message"] }).length, 1);
  assert.equal(store.queryContent("task cursor", { kinds: ["task"] })[0].id, "t1");
  assert.equal(store.getContentSource("agent:codex:s1").eventCursor, 1);
  assert.equal(store.getContentSource("task:codex:t1").eventCursor, 4);

  fs.appendFileSync(logPath, `${jsonlEntry("assistant", "second appended marker", "2026-01-01T00:00:02Z")}\n`, "utf8");
  taskEvents.push({ cursor: 9, type: "assistant", text: "later task marker", at: "2026-01-01T00:00:03Z" });
  await indexer.refresh();
  assert.equal(store.queryContent("second appended", { kinds: ["message"] }).length, 1);
  assert.equal(store.queryContent("later task", { kinds: ["message"] }).length, 1);
  assert.equal(store.queryContent("later task", { kinds: ["task"] })[0].id, "t1");
  assert.deepEqual(reads, [0, 4]);
});

test("content index removes missing sources and rebuilds truncated or corrupt indexes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-content-rebuild-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logPath = path.join(root, "session.jsonl");
  fs.writeFileSync(logPath, `${jsonlEntry("user", "obsolete source token", "2026-01-01T00:00:00Z")}\n`, "utf8");
  const db = new DatabaseSync(":memory:");
  const store = createSearchStore({ database: () => db });
  const histories = [{ id: "s1", provider: "codex", title: "Source", updatedAt: "2026-01-01T00:00:00Z", filePath: logPath }];
  const indexer = createContentSearchIndexer({ store, getHistories: () => histories, getTasks: () => [], listTaskEvents: () => [] });

  await indexer.refresh();
  fs.writeFileSync(logPath, `${jsonlEntry("user", "new token", "2026-01-02T00:00:00Z")}\n`, "utf8");
  await indexer.refresh();
  assert.equal(store.queryContent("obsolete source").length, 0);
  assert.equal(store.queryContent("new token").length, 1);

  db.exec("DROP TABLE content_search_fts; CREATE TABLE content_search_fts (broken TEXT)");
  assert.equal(store.queryContent("new token").length, 1);

  histories.length = 0;
  await indexer.refresh();
  assert.deepEqual(store.queryContent("new token"), []);
  assert.deepEqual(store.contentStats(), { sessions: 0, tasks: 0, messages: 0 });
});

test("content FTS relevance favors a title match", () => {
  const db = new DatabaseSync(":memory:");
  const store = createSearchStore({ database: () => db });
  store.applyContentChanges({ sourceKey: "agent:codex:one", provider: "codex", sessionId: "one", sourceKind: "agent" }, {
    upserts: [{ eventCursor: 0, kind: "history", id: "one", provider: "codex", title: "needle", content: "short", updatedAt: "2026-01-01" }]
  });
  store.applyContentChanges({ sourceKey: "agent:codex:two", provider: "codex", sessionId: "two", sourceKind: "agent" }, {
    upserts: [{ eventCursor: 0, kind: "history", id: "two", provider: "codex", title: "Other", content: "needle appears in body", updatedAt: "2026-01-02" }]
  });
  assert.deepEqual(store.queryContent("needle").map((item) => item.id), ["one", "two"]);
});
