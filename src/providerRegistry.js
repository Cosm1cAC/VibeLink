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
      liveCallAssistant: true,
      reattach: false,
      structuredToolEvents: "observed",
      toolOutput: "complete",
      exitStatus: "authoritative",
      approvalContinuation: false,
      liveInput: false,
      protocol: "codex-cli-jsonl"
    },
    executionOwnership: "legacy-node",
    fidelity: {
      executionState: "authoritative",
      structuredToolEvents: "observed",
      toolOutput: "authoritative",
      exitStatus: "authoritative"
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
      liveCallAssistant: true,
      reattach: false,
      structuredToolEvents: "observed",
      toolOutput: "complete",
      exitStatus: "authoritative",
      approvalContinuation: false,
      liveInput: false,
      protocol: "claude-cli-stream-json"
    },
    executionOwnership: "legacy-node",
    fidelity: {
      executionState: "authoritative",
      structuredToolEvents: "observed",
      toolOutput: "authoritative",
      exitStatus: "authoritative"
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
      browserBridge: true,
      reattach: false,
      structuredToolEvents: "unavailable",
      toolOutput: "sampled",
      exitStatus: "observed",
      approvalContinuation: false,
      liveInput: false,
      protocol: "doubao-browser-bridge"
    },
    executionOwnership: "external",
    fidelity: {
      executionState: "observed",
      structuredToolEvents: "unavailable",
      toolOutput: "sampled",
      exitStatus: "observed"
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
      liveCallAssistant: true,
      reattach: false,
      structuredToolEvents: "unavailable",
      toolOutput: "complete",
      exitStatus: "authoritative",
      approvalContinuation: false,
      liveInput: false,
      protocol: "zhipu-http-cli"
    },
    executionOwnership: "legacy-node",
    fidelity: {
      executionState: "authoritative",
      structuredToolEvents: "unavailable",
      toolOutput: "authoritative",
      exitStatus: "authoritative"
    }
  }
];

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function cleanCatalogText(value, maxLength) {
  return String(value || "").replace(CONTROL_CHARACTERS, "").trim().slice(0, maxLength);
}

function cloneCatalog(result, status = result.catalog.status) {
  return {
    models: result.models.map((model) => ({ ...model })),
    catalog: { ...result.catalog, status }
  };
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
  let validExternalModels = 0;
  for (const model of provider.models.filter((item) => item.default)) {
    models.push({ ...model });
    seen.add(model.id);
  }
  for (const item of value.slice(0, 200)) {
    if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
    const rawId = item.id.trim();
    if (!rawId || CONTROL_CHARACTER_PATTERN.test(rawId)) continue;
    const id = rawId.slice(0, 160);
    validExternalModels += 1;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = cleanCatalogText(item.label, 160);
    models.push({
      id,
      label: label || id,
      ...(id === provider.defaultModel ? { default: true } : {})
    });
  }
  if (validExternalModels === 0) {
    throw new Error("Provider model catalog did not contain a valid model.");
  }
  return models;
}

export function createProviderCatalogResolver({ loaders = {}, ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();

  return {
    async resolve(provider, { fresh = false, background = false } = {}) {
      const loader = loaders[provider.id];
      if (typeof loader !== "function") return builtinCatalog(provider);

      const current = Number(now());
      const cached = cache.get(provider.id);
      if (!fresh && cached && cached.expiresAtMs > current) {
        return cloneCatalog(cached, "cached");
      }

      if (pending.has(provider.id)) {
        if (background && !fresh) return cached ? cloneCatalog(cached, "stale") : builtinCatalog(provider, "refreshing");
        return cloneCatalog(await pending.get(provider.id));
      }

      const refresh = (async () => {
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
        } finally {
          pending.delete(provider.id);
        }
      })();
      pending.set(provider.id, refresh);
      if (background && !fresh) return cached ? cloneCatalog(cached, "stale") : builtinCatalog(provider, "refreshing");
      return cloneCatalog(await refresh);
    }
  };
}

function unknownHealth() {
  return {
    ok: null,
    status: "unknown",
    cacheStatus: "builtin",
    source: "builtin",
    checkedAt: "",
    expiresAt: "",
    latencyMs: null,
    version: "",
    error: ""
  };
}

function disabledHealth(provider) {
  return {
    ...unknownHealth(),
    ok: false,
    status: "disabled",
    source: "settings",
    error: `${provider.label} is disabled in settings.`
  };
}

function normalizeHealth(value, providerId, current, ttlMs) {
  if (typeof value?.ok !== "boolean") throw new Error("Provider health loader must return an ok boolean.");
  const expiresAtMs = current + Math.max(1000, Number(ttlMs) || 0);
  const error = value.ok ? "" : cleanCatalogText(value.error || value.reason || "Provider is not ready.", 500);
  return {
    ok: value.ok,
    status: cleanCatalogText(value.status, 80) || (value.ok ? "ready" : "unavailable"),
    cacheStatus: "fresh",
    source: cleanCatalogText(value.source, 120) || providerId,
    checkedAt: new Date(current).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    latencyMs: Number.isFinite(Number(value.latencyMs)) ? Math.max(0, Math.round(Number(value.latencyMs))) : null,
    version: cleanCatalogText(value.version, 240),
    error,
    expiresAtMs
  };
}

function publicHealth(value, cacheStatus = value.cacheStatus) {
  const { expiresAtMs, ...health } = value;
  return { ...health, cacheStatus };
}

export function createProviderHealthResolver({ loaders = {}, ttlMs = 30 * 1000, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();

  return {
    async resolve(provider, { fresh = false, background = false } = {}) {
      const loader = loaders[provider.id];
      if (typeof loader !== "function") return unknownHealth();

      const current = Number(now());
      const cached = cache.get(provider.id);
      if (!fresh && cached && cached.expiresAtMs > current) return publicHealth(cached, "cached");
      if (pending.has(provider.id)) {
        if (background && !fresh) return cached
          ? publicHealth(cached, "stale")
          : { ...unknownHealth(), cacheStatus: "refreshing" };
        return publicHealth(await pending.get(provider.id));
      }

      const refresh = (async () => {
        let result;
        try {
          result = normalizeHealth(await loader({ providerId: provider.id }), provider.id, current, ttlMs);
        } catch (error) {
          result = normalizeHealth({
            ok: false,
            status: "unavailable",
            source: provider.id,
            error: error?.message || error || "Provider health check failed."
          }, provider.id, current, ttlMs);
        } finally {
          pending.delete(provider.id);
        }
        cache.set(provider.id, result);
        return result;
      })();
      pending.set(provider.id, refresh);
      if (background && !fresh) return cached
        ? publicHealth(cached, "stale")
        : { ...unknownHealth(), cacheStatus: "refreshing" };
      return publicHealth(await refresh);
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

function readinessFor(provider, settings = {}, health = null) {
  if (!commandConfigured(settings, provider)) {
    return {
      available: false,
      status: "disabled",
      reason: `${provider.label} is disabled in settings.`
    };
  }

  if (health && health.ok === false) {
    return {
      available: false,
      status: health.status,
      reason: health.error || health.reason || `${provider.label} is not ready.`
    };
  }

  if (health && health.ok === true) {
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

export async function buildProviderRegistry({
  settings = {},
  probes = {},
  catalogResolver = null,
  healthResolver = null,
  freshCatalogs = false,
  freshHealth = false,
  backgroundRefresh = false
} = {}) {
  const providers = await Promise.all(PROVIDERS.map(async (provider) => {
    const enabled = commandConfigured(settings, provider);
    const [catalog, health] = await Promise.all([
      catalogResolver && enabled
        ? catalogResolver.resolve(provider, { fresh: freshCatalogs, background: backgroundRefresh })
        : builtinCatalog(provider),
      !enabled
        ? Promise.resolve(disabledHealth(provider))
        : healthResolver
        ? healthResolver.resolve(provider, { fresh: freshHealth, background: backgroundRefresh })
        : Promise.resolve(probes[provider.id]
          ? {
              ...unknownHealth(),
              ...probes[provider.id],
              status: probes[provider.id].status || (probes[provider.id].ok ? "ready" : "unavailable"),
              source: probes[provider.id].source || "probe",
              error: probes[provider.id].error || probes[provider.id].reason || ""
            }
          : unknownHealth())
    ]);
    const readiness = readinessFor(provider, settings, health);
    return {
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      available: readiness.available,
      status: readiness.status,
      reason: readiness.reason,
      health,
      executionOwnership: provider.executionOwnership,
      defaultModel: provider.defaultModel,
      models: catalog.models,
      catalog: catalog.catalog,
      reasoningEfforts: provider.reasoningEfforts,
      capabilities: {
        ...provider.capabilities,
        protocolVersion: health.version || "unavailable"
      },
      fidelity: { ...provider.fidelity }
    };
  }));

  const defaultProvider =
    providers.find((provider) => provider.id === "codex" && provider.available)?.id ||
    providers.find((provider) => provider.available)?.id ||
    "codex";

  return {
    version: 2,
    catalogVersion: 1,
    defaultProvider,
    providers,
    generatedAt: new Date().toISOString()
  };
}

export function providerIds() {
  return PROVIDERS.map((provider) => provider.id);
}
