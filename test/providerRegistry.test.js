import assert from "node:assert/strict";
import test from "node:test";

import { buildProviderRegistry } from "../src/providerRegistry.js";

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
