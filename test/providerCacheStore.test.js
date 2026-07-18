import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createProviderCacheStore, ensureProviderCacheSchema } from "../src/providerCacheStore.js";

test("provider cache store survives reopening SQLite with catalog and health metadata", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-provider-cache-"));
  const dbPath = path.join(directory, "cache.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let db = new DatabaseSync(dbPath);
  const store = createProviderCacheStore({ database: () => db, now: () => "2026-07-18T00:00:00.000Z" });
  store.putCatalog("codex", {
    models: [{ id: "gpt-persisted", label: "GPT persisted" }],
    catalog: {
      status: "stale",
      source: "codex-runtime",
      fetchedAt: "2026-07-17T23:00:00.000Z",
      expiresAt: "2026-07-17T23:05:00.000Z",
      error: "refresh timed out"
    }
  });
  store.putHealth("codex", {
    ok: false,
    status: "unavailable",
    cacheStatus: "fresh",
    source: "codex-cli",
    checkedAt: "2026-07-17T23:01:00.000Z",
    expiresAt: "2026-07-17T23:01:30.000Z",
    latencyMs: 42,
    version: "codex 1.2.3",
    error: "login required"
  });

  const expected = store.get("codex");
  db.close();
  db = new DatabaseSync(dbPath);
  const reopened = createProviderCacheStore({ database: () => db });
  assert.deepEqual(reopened.get("codex"), expected);
  assert.equal(reopened.get("codex").catalog.catalog.error, "refresh timed out");
  assert.equal(reopened.get("codex").health.error, "login required");
  db.close();
});

test("provider cache store ignores corrupt catalog JSON without losing health", () => {
  const db = new DatabaseSync(":memory:");
  ensureProviderCacheSchema(db);
  db.prepare(`
    INSERT INTO provider_cache (provider_id, catalog_models_json, health_ok, health_status, updated_at)
    VALUES ('codex', '{bad json', 1, 'ready', '2026-07-18T00:00:00.000Z')
  `).run();

  const value = createProviderCacheStore({ database: () => db }).get("codex");
  assert.equal(value.catalog, null);
  assert.equal(value.health.ok, true);
  assert.equal(value.health.status, "ready");
  db.close();
});
