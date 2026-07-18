import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createSearchStore } from "../src/searchStore.js";

function createStore() {
  const db = new DatabaseSync(":memory:");
  let tick = 0;
  const store = createSearchStore({
    database: () => db,
    now: () => `2026-01-01T00:00:0${tick++}.000Z`,
    uuid: () => "saved-1"
  });
  return { db, store };
}

test("workspace FTS replaces changed content and removes deleted files", () => {
  const { store } = createStore();
  store.applyWorkspaceChanges("w1", {
    upserts: [{ path: "src/alpha.txt", size: 5, mtimeMs: 1000, content: "obsolete token" }]
  });

  assert.deepEqual(store.queryWorkspaceFiles("obsolete").map((item) => item.path), ["src/alpha.txt"]);
  assert.deepEqual(store.queryWorkspaceFiles("ob").map((item) => item.path), ["src/alpha.txt"]);
  assert.equal(store.queryWorkspaceFiles("src/alpha")[0].workspaceId, "w1");

  store.applyWorkspaceChanges("w1", {
    upserts: [{ path: "src/alpha.txt", size: 4, mtimeMs: 2000, content: "beta value" }]
  });
  assert.deepEqual(store.queryWorkspaceFiles("obsolete"), []);
  assert.deepEqual(store.queryWorkspaceFiles("beta").map((item) => item.path), ["src/alpha.txt"]);

  store.applyWorkspaceChanges("w1", { deletedPaths: ["src/alpha.txt"] });
  assert.deepEqual(store.queryWorkspaceFiles("beta"), []);
  assert.deepEqual(store.stats(), { files: 0, workspaces: 0 });
});

test("saved searches round-trip sort options and search history deduplicates", () => {
  const { store } = createStore();
  const saved = store.saveSearch({
    name: "Recent files",
    query: "alpha",
    scope: "files",
    sort: "updatedAt",
    order: "desc"
  });
  assert.equal(saved.id, "saved-1");
  assert.equal(store.listSavedSearches()[0].sort, "updatedAt");

  const updated = store.updateSavedSearch(saved.id, { name: "Named search", order: "asc" });
  assert.equal(updated.name, "Named search");
  assert.equal(updated.order, "asc");

  store.recordSearch({ query: "alpha", scope: "files", sort: "updatedAt", order: "desc", resultCount: 2, deviceId: "d1" });
  store.recordSearch({ query: "alpha", scope: "files", sort: "updatedAt", order: "desc", resultCount: 3, deviceId: "d1" });
  const history = store.listSearchHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].useCount, 2);
  assert.equal(history[0].resultCount, 3);

  assert.equal(store.deleteSavedSearch(saved.id), true);
  assert.equal(store.clearSearchHistory(), 1);
});
