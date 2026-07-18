import assert from "node:assert/strict";
import test from "node:test";

import { createPersistentProviderCacheLoader } from "../src/providerCacheLoader.js";

function memoryStore(snapshot) {
  const value = structuredClone(snapshot);
  return {
    get: () => structuredClone(value),
    putCatalog: (_providerId, catalog) => { value.catalog = structuredClone(catalog); },
    putHealth: (_providerId, health) => { value.health = structuredClone(health); }
  };
}

const provider = { id: "codex", models: [{ id: "", label: "Default", default: true }] };

test("persistent loader serves cold-start cache before a deduplicated background refresh", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let catalogLoads = 0;
  let healthLoads = 0;
  const store = memoryStore({
    catalog: {
      models: [{ id: "gpt-persisted", label: "Persisted" }],
      catalog: { status: "fresh", source: "disk", fetchedAt: "2026-07-18T00:00:00.000Z", expiresAt: "2026-07-18T01:00:00.000Z", error: "" }
    },
    health: { ok: true, status: "ready", cacheStatus: "fresh", source: "disk", checkedAt: "2026-07-18T00:00:00.000Z", expiresAt: "2026-07-18T01:00:00.000Z", latencyMs: 5, version: "1", error: "" }
  });
  const loader = createPersistentProviderCacheLoader({
    store,
    now: () => Date.parse("2026-07-18T00:30:00.000Z"),
    catalogResolver: { resolve: async () => { catalogLoads += 1; await blocked; return { models: [{ id: "gpt-new" }], catalog: { status: "fresh", source: "runtime", fetchedAt: "new", expiresAt: "later", error: "" } }; } },
    healthResolver: { resolve: async () => { healthLoads += 1; await blocked; return { ok: true, status: "ready", cacheStatus: "fresh", source: "runtime", checkedAt: "new", expiresAt: "later", latencyMs: 2, version: "2", error: "" }; } }
  });

  const [catalog, health] = await Promise.all([
    loader.catalogResolver.resolve(provider),
    loader.healthResolver.resolve(provider)
  ]);
  assert.equal(catalog.catalog.status, "cached");
  assert.equal(catalog.models[0].id, "gpt-persisted");
  assert.equal(health.cacheStatus, "cached");
  await loader.catalogResolver.resolve(provider, { background: true });
  assert.equal(catalogLoads, 1);
  assert.equal(healthLoads, 1);

  release();
  await loader.drain();
  assert.equal(store.get().catalog.models[0].id, "gpt-new");
  assert.equal(store.get().health.version, "2");
});

test("failed catalog refresh keeps last-known-good models and persists stale error state", async () => {
  const store = memoryStore({
    catalog: {
      models: [{ id: "gpt-known-good" }],
      catalog: { status: "fresh", source: "runtime", fetchedAt: "old", expiresAt: "expired", error: "" }
    },
    health: null
  });
  const loader = createPersistentProviderCacheLoader({
    store,
    catalogResolver: { resolve: async () => ({ models: [{ id: "" }], catalog: { status: "fallback", source: "builtin", fetchedAt: "", expiresAt: "", error: "network offline" } }) },
    healthResolver: { resolve: async () => ({ ok: false }) }
  });

  const cold = await loader.catalogResolver.resolve(provider);
  assert.equal(cold.models[0].id, "gpt-known-good");
  await loader.drain();

  const persisted = store.get().catalog;
  assert.equal(persisted.models[0].id, "gpt-known-good");
  assert.equal(persisted.catalog.status, "stale");
  assert.equal(persisted.catalog.source, "runtime");
  assert.equal(persisted.catalog.error, "network offline");
});
