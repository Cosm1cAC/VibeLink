const PROVIDERS = [
  {
    id: "codex",
    label: "Codex",
    kind: "cli",
    settingKey: "codexCommand",
    keyName: "openai",
    defaultModel: "",
    models: [
      { id: "", label: "Default model", default: true },
      { id: "gpt-5.5", label: "gpt-5.5" },
      { id: "gpt-5.5[1m]", label: "gpt-5.5[1m]" },
      { id: "gpt-5.4", label: "gpt-5.4" }
    ],
    reasoningEfforts: ["", "low", "medium", "high", "xhigh"],
    capabilities: {
      modelOverride: true,
      reasoningEffort: true,
      resume: true,
      liveCallAssistant: true
    }
  },
  {
    id: "claude",
    label: "Claude",
    kind: "cli",
    settingKey: "claudeCommand",
    keyName: "anthropic",
    defaultModel: "",
    models: [
      { id: "", label: "Default model", default: true },
      { id: "opus", label: "opus" },
      { id: "sonnet", label: "sonnet" },
      { id: "fable", label: "fable" }
    ],
    reasoningEfforts: ["", "low", "medium", "high", "xhigh", "max"],
    capabilities: {
      modelOverride: true,
      reasoningEffort: true,
      resume: true,
      liveCallAssistant: true
    }
  },
  {
    id: "doubao",
    label: "Doubao",
    kind: "web",
    settingKey: "doubaoCommand",
    defaultModel: "doubao-web",
    models: [
      { id: "doubao-web", label: "Web default", default: true }
    ],
    reasoningEfforts: [""],
    capabilities: {
      modelOverride: false,
      reasoningEffort: false,
      resume: false,
      liveCallAssistant: true,
      browserBridge: true
    }
  },
  {
    id: "zhipu",
    label: "GLM",
    kind: "cli",
    keyName: "zhipu",
    defaultModel: "glm-5.2",
    models: [
      { id: "", label: "Default model", default: true },
      { id: "glm-5.2", label: "glm-5.2" },
      { id: "glm-5.1", label: "glm-5.1" },
      { id: "glm-5.0", label: "glm-5.0" },
      { id: "glm-4.7", label: "glm-4.7" },
      { id: "glm-4.6", label: "glm-4.6" }
    ],
    reasoningEfforts: ["", "low", "medium", "high", "xhigh"],
    capabilities: {
      modelOverride: true,
      reasoningEffort: true,
      resume: false,
      liveCallAssistant: true
    }
  }
];

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function cleanCatalogText(value, maxLength) {
  return String(value || "").replace(CONTROL_CHARACTERS, "").trim().slice(0, maxLength);
}

function builtinCatalog(provider, status = "builtin", error = "") {
  return {
    models: provider.models.map((model) => ({ ...model })),
    catalog: {
      status,
      source: "builtin",
      fetchedAt: "",
      expiresAt: "",
      error
    }
  };
}

function normalizeCatalogModels(provider, value) {
  if (!Array.isArray(value)) throw new Error("Provider model catalog must be an array.");

  const models = [];
  const seen = new Set();
  for (const model of provider.models.filter((item) => item.default)) {
    models.push({ ...model });
    seen.add(model.id);
  }
  for (const item of value.slice(0, 200)) {
    if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
    const rawId = item.id.trim();
    if (!rawId || CONTROL_CHARACTER_PATTERN.test(rawId)) continue;
    const id = rawId.slice(0, 160);
    if (seen.has(id)) continue;
    seen.add(id);
    const label = cleanCatalogText(item.label, 160);
    models.push({
      id,
      label: label || id,
      ...(id === provider.defaultModel ? { default: true } : {})
    });
  }
  if (models.length === provider.models.filter((item) => item.default).length) {
    throw new Error("Provider model catalog did not contain a valid model.");
  }
  return models;
}

export function createProviderCatalogResolver({ loaders = {}, ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const cache = new Map();

  return {
    async resolve(provider, { fresh = false } = {}) {
      const loader = loaders[provider.id];
      if (typeof loader !== "function") return builtinCatalog(provider);

      const current = Number(now());
      const cached = cache.get(provider.id);
      if (!fresh && cached && cached.expiresAtMs > current) {
        return {
          models: cached.models.map((model) => ({ ...model })),
          catalog: { ...cached.catalog, status: "cached" }
        };
      }

      try {
        const loaded = await loader({ providerId: provider.id });
        const models = normalizeCatalogModels(provider, loaded?.models);
        const fetchedAt = new Date(current).toISOString();
        const expiresAtMs = current + Math.max(1000, Number(ttlMs) || 0);
        const result = {
          models,
          catalog: {
            status: "fresh",
            source: cleanCatalogText(loaded?.source, 120) || provider.id,
            fetchedAt,
            expiresAt: new Date(expiresAtMs).toISOString(),
            error: ""
          }
        };
        cache.set(provider.id, { ...result, expiresAtMs });
        return result;
      } catch (error) {
        const message = cleanCatalogText(error?.message || error || "Provider model catalog refresh failed.", 500);
        if (!cached) return builtinCatalog(provider, "fallback", message);
        return {
          models: cached.models.map((model) => ({ ...model })),
          catalog: { ...cached.catalog, status: "stale", error: message }
        };
      }
    }
  };
}

function commandConfigured(settings = {}, provider) {
  if (!provider.settingKey) return true;
  const value = settings[provider.settingKey];
  return value !== "disabled" && value !== false;
}

function keyConfigured(settings = {}, provider) {
  if (!provider.keyName) return true;
  return Boolean(settings.apiKeys?.[provider.keyName]);
}

function readinessFor(provider, settings = {}, probes = {}) {
  if (!commandConfigured(settings, provider)) {
    return {
      available: false,
      status: "disabled",
      reason: `${provider.label} is disabled in settings.`
    };
  }

  const probe = probes[provider.id];
  if (probe && probe.ok === false) {
    return {
      available: false,
      status: "unavailable",
      reason: probe.error || probe.reason || `${provider.label} is not ready.`
    };
  }

  if (probe && probe.ok === true) {
    return {
      available: true,
      status: "ready",
      reason: ""
    };
  }

  if (keyConfigured(settings, provider)) {
    return {
      available: true,
      status: "configured",
      reason: ""
    };
  }

  return {
    available: provider.id === "codex" || provider.id === "doubao",
    status: provider.id === "codex" || provider.id === "doubao" ? "configured" : "missing_credentials",
    reason: provider.keyName ? `${provider.label} API key is not configured.` : ""
  };
}

export async function buildProviderRegistry({ settings = {}, probes = {}, catalogResolver = null, freshCatalogs = false } = {}) {
  const providers = await Promise.all(PROVIDERS.map(async (provider) => {
    const readiness = readinessFor(provider, settings, probes);
    const catalog = catalogResolver
      ? await catalogResolver.resolve(provider, { fresh: freshCatalogs })
      : builtinCatalog(provider);
    return {
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      available: readiness.available,
      status: readiness.status,
      reason: readiness.reason,
      defaultModel: provider.defaultModel,
      models: catalog.models,
      catalog: catalog.catalog,
      reasoningEfforts: provider.reasoningEfforts,
      capabilities: provider.capabilities
    };
  }));

  const defaultProvider =
    providers.find((provider) => provider.id === "codex" && provider.available)?.id ||
    providers.find((provider) => provider.available)?.id ||
    "codex";

  return {
    version: 1,
    catalogVersion: 1,
    defaultProvider,
    providers,
    generatedAt: new Date().toISOString()
  };
}

export function providerIds() {
  return PROVIDERS.map((provider) => provider.id);
}
