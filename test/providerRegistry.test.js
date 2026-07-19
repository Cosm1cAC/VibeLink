import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderRegistry,
  createProviderCatalogResolver,
  createProviderHealthResolver
} from "../src/providerRegistry.js";

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
  assert.equal(byId.get("codex").executionOwnership, "vibelink-host");
  assert.equal(byId.get("codex").capabilities.reattach, true);
  assert.equal(byId.get("codex").capabilities.approvalContinuation, false);
  assert.equal(byId.get("codex").fidelity.structuredToolEvents, "observed");
  assert.equal(byId.get("doubao").executionOwnership, "external");
  assert.equal(byId.get("doubao").fidelity.toolOutput, "sampled");
  assert.equal(registry.version, 2);
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

test("provider health resolver deduplicates concurrent probes and caches readiness", async () => {
  let current = Date.parse("2026-07-17T00:00:00.000Z");
  let loadCount = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const healthResolver = createProviderHealthResolver({
    ttlMs: 60_000,
    now: () => current,
    loaders: {
      codex: async () => {
        loadCount += 1;
        await blocked;
        return { ok: true, source: "codex-cli", version: "codex-cli 1.2.3", latencyMs: 12.4 };
      }
    }
  });

  const first = buildProviderRegistry({ healthResolver, freshHealth: true });
  const second = buildProviderRegistry({ healthResolver, freshHealth: true });
  release();
  const [firstRegistry, secondRegistry] = await Promise.all([first, second]);
  const firstCodex = firstRegistry.providers.find((provider) => provider.id === "codex");
  const secondCodex = secondRegistry.providers.find((provider) => provider.id === "codex");

  assert.equal(loadCount, 1);
  assert.equal(firstCodex.available, true);
  assert.equal(firstCodex.health.status, "ready");
  assert.equal(firstCodex.health.cacheStatus, "fresh");
  assert.equal(firstCodex.health.version, "codex-cli 1.2.3");
  assert.equal(firstCodex.capabilities.protocolVersion, "codex-cli 1.2.3");
  assert.equal(secondCodex.health.status, "ready");

  current += 1000;
  const cachedRegistry = await buildProviderRegistry({ healthResolver });
  const cachedCodex = cachedRegistry.providers.find((provider) => provider.id === "codex");
  assert.equal(loadCount, 1);
  assert.equal(cachedCodex.health.cacheStatus, "cached");
  assert.equal(cachedCodex.available, true);
});

test("provider health failures override credential-only readiness", async () => {
  const healthResolver = createProviderHealthResolver({
    loaders: {
      zhipu: async () => ({
        ok: false,
        status: "unavailable",
        source: "zhipu-model-api",
        error: "remote health failed"
      })
    }
  });

  const registry = await buildProviderRegistry({
    settings: { apiKeys: { zhipu: "configured" } },
    healthResolver,
    freshHealth: true
  });
  const zhipu = registry.providers.find((provider) => provider.id === "zhipu");

  assert.equal(zhipu.available, false);
  assert.equal(zhipu.status, "unavailable");
  assert.equal(zhipu.reason, "remote health failed");
  assert.equal(zhipu.health.source, "zhipu-model-api");
});

test("provider catalog resolver deduplicates concurrent forced refreshes", async () => {
  let loadCount = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const catalogResolver = createProviderCatalogResolver({
    loaders: {
      codex: async () => {
        loadCount += 1;
        await blocked;
        return { source: "codex-runtime", models: [{ id: "gpt-shared" }] };
      }
    }
  });

  const first = buildProviderRegistry({ catalogResolver, freshCatalogs: true });
  const second = buildProviderRegistry({ catalogResolver, freshCatalogs: true });
  release();
  const registries = await Promise.all([first, second]);

  assert.equal(loadCount, 1);
  for (const registry of registries) {
    assert.ok(registry.providers.find((provider) => provider.id === "codex").models.some((model) => model.id === "gpt-shared"));
  }
});

test("disabled providers do not run catalog or health loaders", async () => {
  let calls = 0;
  const catalogResolver = createProviderCatalogResolver({
    loaders: { claude: async () => { calls += 1; return { models: [{ id: "claude-test" }] }; } }
  });
  const healthResolver = createProviderHealthResolver({
    loaders: { claude: async () => { calls += 1; return { ok: true }; } }
  });

  const registry = await buildProviderRegistry({
    settings: { claudeCommand: "disabled" },
    catalogResolver,
    healthResolver,
    freshCatalogs: true,
    freshHealth: true
  });
  const claude = registry.providers.find((provider) => provider.id === "claude");

  assert.equal(calls, 0);
  assert.equal(claude.available, false);
  assert.equal(claude.status, "disabled");
  assert.equal(claude.health.source, "settings");
  assert.equal(claude.catalog.status, "builtin");
});

test("background refresh returns immediately and shares the pending refresh", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let catalogLoads = 0;
  let healthLoads = 0;
  const catalogResolver = createProviderCatalogResolver({
    loaders: {
      codex: async () => {
        catalogLoads += 1;
        await blocked;
        return { source: "codex-runtime", models: [{ id: "gpt-background" }] };
      }
    }
  });
  const healthResolver = createProviderHealthResolver({
    loaders: {
      codex: async () => {
        healthLoads += 1;
        await blocked;
        return { ok: true, source: "codex-cli" };
      }
    }
  });

  const background = await buildProviderRegistry({ catalogResolver, healthResolver, backgroundRefresh: true });
  const refreshingCodex = background.providers.find((provider) => provider.id === "codex");
  assert.equal(refreshingCodex.catalog.status, "refreshing");
  assert.equal(refreshingCodex.health.cacheStatus, "refreshing");

  const waiting = buildProviderRegistry({ catalogResolver, healthResolver });
  release();
  const refreshed = await waiting;
  const codex = refreshed.providers.find((provider) => provider.id === "codex");

  assert.equal(catalogLoads, 1);
  assert.equal(healthLoads, 1);
  assert.equal(codex.catalog.status, "fresh");
  assert.equal(codex.health.status, "ready");
  assert.ok(codex.models.some((model) => model.id === "gpt-background"));
});
