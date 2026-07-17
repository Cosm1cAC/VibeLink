import assert from "node:assert/strict";
import test from "node:test";

import { buildProviderRegistry, createProviderCatalogResolver } from "../src/providerRegistry.js";

test("buildProviderRegistry exposes provider readiness and model catalog", async () => {
  const registry = await buildProviderRegistry({
    settings: {
      codexCommand: "auto",
      claudeCommand: "claude",
      doubaoCommand: "auto",
      apiKeys: {
        openai: "configured",
        anthropic: "",
        zhipu: "configured"
      }
    },
    probes: {
      codex: { ok: true },
      claude: { ok: false, error: "missing" },
      doubao: { ok: true },
      zhipu: { ok: true }
    }
  });

  const byId = new Map(registry.providers.map((provider) => [provider.id, provider]));

  assert.equal(registry.defaultProvider, "codex");
  assert.equal(byId.get("codex").available, true);
  assert.equal(byId.get("claude").available, false);
  assert.equal(byId.get("doubao").models[0].id, "doubao-web");
  assert.equal(byId.get("doubao").capabilities.modelOverride, false);
  assert.ok(byId.get("zhipu").models.some((model) => model.id === "glm-5.2"));
});

test("buildProviderRegistry uses a validated dynamic model catalog", async () => {
  let loadCount = 0;
  const catalogResolver = createProviderCatalogResolver({
    ttlMs: 60_000,
    now: () => Date.parse("2026-07-17T00:00:00.000Z"),
    loaders: {
      codex: async () => {
        loadCount += 1;
        return {
          source: "codex-runtime",
          models: [
            { id: "gpt-dynamic", label: "Dynamic model" },
            { id: "gpt-dynamic", label: "Duplicate model" },
            { id: "", label: "Untrusted default override" }
          ]
        };
      }
    }
  });

  const registry = await buildProviderRegistry({
    settings: { codexCommand: "auto" },
    probes: { codex: { ok: true } },
    catalogResolver,
    freshCatalogs: true
  });
  const codex = registry.providers.find((provider) => provider.id === "codex");

  assert.equal(loadCount, 1);
  assert.deepEqual(codex.models.map((model) => model.id), ["", "gpt-dynamic"]);
  assert.equal(codex.models[0].label, "Default model");
  assert.equal(codex.catalog.status, "fresh");
  assert.equal(codex.catalog.source, "codex-runtime");
  assert.equal(registry.catalogVersion, 1);
});

test("provider model catalog falls back to the last successful refresh", async () => {
  let current = Date.parse("2026-07-17T00:00:00.000Z");
  let shouldFail = false;
  const catalogResolver = createProviderCatalogResolver({
    ttlMs: 60_000,
    now: () => current,
    loaders: {
      codex: async () => {
        if (shouldFail) throw new Error("catalog unavailable");
        return { source: "codex-runtime", models: [{ id: "gpt-last-good" }] };
      }
    }
  });

  await buildProviderRegistry({ catalogResolver, freshCatalogs: true });
  current += 60_001;
  shouldFail = true;
  const registry = await buildProviderRegistry({ catalogResolver });
  const codex = registry.providers.find((provider) => provider.id === "codex");

  assert.equal(codex.available, true);
  assert.deepEqual(codex.models.map((model) => model.id), ["", "gpt-last-good"]);
  assert.equal(codex.catalog.status, "stale");
  assert.equal(codex.catalog.source, "codex-runtime");
  assert.equal(codex.catalog.error, "catalog unavailable");
});

test("provider model catalog rejects control characters at the external boundary", async () => {
  const catalogResolver = createProviderCatalogResolver({
    loaders: {
      codex: async () => ({
        source: "runtime\u0000catalog",
        models: [
          { id: "unsafe\nmodel", label: "Unsafe model" },
          { id: "gpt-safe", label: "Safe\u0000 model", ignored: "do not expose" }
        ]
      })
    }
  });

  const registry = await buildProviderRegistry({ catalogResolver, freshCatalogs: true });
  const codex = registry.providers.find((provider) => provider.id === "codex");

  assert.deepEqual(codex.models.map((model) => model.id), ["", "gpt-safe"]);
  assert.deepEqual(codex.models[1], { id: "gpt-safe", label: "Safe model" });
  assert.equal(codex.catalog.source, "runtimecatalog");
});
