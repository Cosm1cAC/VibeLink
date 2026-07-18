import assert from "node:assert/strict";
import test from "node:test";
import { searchContent } from "../src/search.js";

test("unified search returns sessions, tasks, messages, files with scope and cursor", () => {
  const histories = [{ id: "h1", provider: "codex", title: "Build search", preview: "unified alpha", updatedAt: "2026-01-01" }];
  const tasks = [{ id: "t1", agent: "codex", title: "Search task", status: "running" }];
  const historyDetails = new Map([["codex:h1", { transcript: [{ text: "message alpha", turnId: "turn-1" }] }]]);
  const result = searchContent({ query: "alpha", limit: 1, histories, tasks, historyDetails });
  assert.equal(result.items.length, 1);
  assert.equal(result.nextCursor, "1");
  assert.equal(searchContent({ query: "alpha", scope: "messages", histories, tasks, historyDetails }).items[0].kind, "message");
});

test("file scope matches relative path and content without exposing absolute paths", () => {
  const result = searchContent({ query: "alpha", scope: "files", workspaces: [{ id: "w1", path: "C:/workspace" }] });
  assert.deepEqual(result.items, []);
});

test("favorite and tag filters use persisted thread metadata", () => {
  const result = searchContent({
    query: "alpha",
    favorite: true,
    tag: "work",
    histories: [{ id: "h1", provider: "codex", title: "alpha" }, { id: "h2", provider: "codex", title: "alpha" }],
    threadState: { items: { "history:codex:h1": { favorite: true, tags: ["work"] }, "history:codex:h2": { favorite: false, tags: ["work"] } } }
  });
  assert.deepEqual(result.items.map((item) => item.id), ["h1"]);
});

test("unified search sorts results without changing cursor pagination", () => {
  const histories = [
    { id: "h1", provider: "codex", title: "Zulu alpha", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "h2", provider: "codex", title: "Alpha first", updatedAt: "2026-02-01T00:00:00.000Z" }
  ];
  const first = searchContent({ query: "alpha", histories, sort: "title", order: "asc", limit: 1 });
  const second = searchContent({ query: "alpha", histories, sort: "title", order: "asc", limit: 1, cursor: first.nextCursor });

  assert.equal(first.items[0].id, "h2");
  assert.equal(second.items[0].id, "h1");
  assert.equal(first.total, 2);
  assert.equal(first.sort, "title");
  assert.equal(first.order, "asc");
});
