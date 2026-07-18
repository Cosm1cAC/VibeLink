import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createWorkspaceSearchIndexer } from "../src/searchIndexer.js";
import { createSearchStore } from "../src/searchStore.js";

test("workspace index refresh reads only added or changed files and prunes deletions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-search-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "one.txt"), "first marker", "utf8");
  fs.writeFileSync(path.join(root, "src", "two.txt"), "second marker", "utf8");

  const db = new DatabaseSync(":memory:");
  const store = createSearchStore({ database: () => db });
  const workspace = { id: "w1", path: root, title: "Fixture" };
  const indexer = createWorkspaceSearchIndexer({ store, getWorkspaces: () => [workspace] });

  const initial = await indexer.refreshWorkspace(workspace);
  assert.equal(initial.changed, 2);
  assert.equal((await indexer.refreshWorkspace(workspace)).changed, 0);
  assert.deepEqual(store.queryWorkspaceFiles("marker").map((item) => item.path), ["src/one.txt", "src/two.txt"]);

  fs.writeFileSync(path.join(root, "src", "one.txt"), "replacement phrase", "utf8");
  const changedAt = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(root, "src", "one.txt"), changedAt, changedAt);
  const changed = await indexer.refreshWorkspace(workspace);
  assert.equal(changed.changed, 1);
  assert.deepEqual(store.queryWorkspaceFiles("first marker"), []);
  assert.deepEqual(store.queryWorkspaceFiles("replacement").map((item) => item.path), ["src/one.txt"]);

  fs.unlinkSync(path.join(root, "src", "two.txt"));
  const deleted = await indexer.refreshWorkspace(workspace);
  assert.equal(deleted.deleted, 1);
  assert.deepEqual(store.queryWorkspaceFiles("second marker"), []);
});
