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

export async function buildProviderRegistry({ settings = {}, probes = {} } = {}) {
  const providers = PROVIDERS.map((provider) => {
    const readiness = readinessFor(provider, settings, probes);
    return {
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      available: readiness.available,
      status: readiness.status,
      reason: readiness.reason,
      defaultModel: provider.defaultModel,
      models: provider.models,
      reasoningEfforts: provider.reasoningEfforts,
      capabilities: provider.capabilities
    };
  });

  const defaultProvider =
    providers.find((provider) => provider.id === "codex" && provider.available)?.id ||
    providers.find((provider) => provider.available)?.id ||
    "codex";

  return {
    version: 1,
    defaultProvider,
    providers,
    generatedAt: new Date().toISOString()
  };
}

export function providerIds() {
  return PROVIDERS.map((provider) => provider.id);
}
