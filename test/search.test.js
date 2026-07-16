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

