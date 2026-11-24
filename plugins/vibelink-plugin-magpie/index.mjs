import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ANSI_RE = /\u001b\[[0-9;]*m/g;

const HOST_APP_NAMES = new Set([
  "vs code",
  "vscode",
  "t3 code",
  "claude desktop",
  "claude science",
  "grok app",
  "raycast",
  "cherry studio",
  "cindy",
  "aionui",
  "zed",
  "lody",
  "alma",
  "nowledge mem",
]);

const KNOWN_AGENT_PRESETS = {
  "claude code": {
    externalId: "claude",
    botId: "bot_claude",
    slug: "claude",
    handle: "Claude",
    displayName: "Claude Code",
    cliAlias: "claude",
    provider: "claude",
    executionMode: "t3_driver",
    roleTitle: "research",
    isolationMode: "shared",
    approvalMode: "plan",
    avatar: "preset:claude",
    pinned: true,
    department: "Magpie · T3 Code",
  },
  codex: {
    externalId: "codex",
    botId: "bot_codex",
    slug: "codex",
    handle: "Codex",
    displayName: "Codex",
    cliAlias: "codex",
    provider: "codex",
    executionMode: "t3_driver",
    roleTitle: "implementation",
    isolationMode: "worktree",
    approvalMode: "accept_edits",
    avatar: "/AI/openai.svg",
    pinned: true,
    department: "Magpie · T3 Code",
  },
  opencode: {
    externalId: "opencode",
    botId: "bot_opencode",
    slug: "opencode",
    handle: "OpenCode",
    displayName: "OpenCode",
    cliAlias: "opencode",
    provider: "opencode",
    executionMode: "t3_driver",
    roleTitle: "review",
    isolationMode: "shared",
    approvalMode: "ask",
    avatar: "preset:opencode",
    pinned: false,
    department: "Magpie · T3 Code",
    prefixMagpieOnSync: true,
  },
  antigravity: {
    externalId: "antigravity",
    botId: "bot_antigravity",
    slug: "antigravity",
    handle: "Antigravity",
    displayName: "Antigravity",
    cliAlias: "antigravity",
    provider: "antigravity",
    executionMode: "t3_driver",
    roleTitle: "general",
    isolationMode: "shared",
    approvalMode: "ask",
    avatar: "preset:antigravity",
    pinned: false,
    department: "Magpie · T3 Code",
  },
  "antigravity cli": {
    externalId: "antigravity-cli",
    botId: "bot_antigravity",
    slug: "antigravity",
    handle: "Antigravity",
    displayName: "Antigravity CLI",
    cliAlias: "antigravity-cli",
    provider: "antigravity",
    executionMode: "t3_driver",
    roleTitle: "general",
    isolationMode: "shared",
    approvalMode: "ask",
    avatar: "preset:antigravity",
    pinned: false,
    department: "Magpie · T3 Code",
  },
  "gemini cli": {
    externalId: "gemini",
    botId: "bot_gemini",
    slug: "gemini",
    handle: "Gemini",
    displayName: "Gemini CLI",
    cliAlias: "gemini",
    provider: "magpie-gateway",
    executionMode: "magpie_gateway",
    roleTitle: "general",
    isolationMode: "shared",
    approvalMode: "ask",
    avatar: "preset:gemini",
    pinned: false,
    department: "Magpie · Gateway",
  },
  "deepseek harness": {
    externalId: "dsh",
    botId: "bot_dsh",
    slug: "deepseek",
    handle: "DeepSeek",
    displayName: "DeepSeek Harness",
    cliAlias: "dsh",
    provider: "magpie-gateway",
    executionMode: "magpie_gateway",
    roleTitle: "general",
    isolationMode: "shared",
    approvalMode: "ask",
    avatar: "/AI/deepseek.png",
    pinned: false,
    department: "Magpie · Gateway",
    prefixMagpieOnSync: true,
  },
  "cursor cli": {
    externalId: "cursor",
    botId: "bot_cursor",
    slug: "cursor",
    handle: "Cursor",
    displayName: "Cursor",
    cliAlias: "cursor",
    provider: "cursor",
    executionMode: "t3_driver",
    roleTitle: "implementation",
    isolationMode: "shared",
    approvalMode: "ask",
    avatar: "preset:cursor",
    pinned: false,
    department: "Magpie · T3 Code",
  },
  "grok build": {
    externalId: "grok",
    botId: "bot_grok",
    slug: "grok",
    handle: "Grok",
    displayName: "Grok Build",
    cliAlias: "grok",
    provider: "grok",
    executionMode: "t3_driver",
    roleTitle: "general",
    isolationMode: "shared",
    approvalMode: "ask",
    avatar: "preset:grok",
    pinned: false,
    department: "Magpie · T3 Code",
  },
  "kiro crew": {
    externalId: "kiro",
    botId: "bot_kiro",
    slug: "kiro",
    handle: "Kiro",
    displayName: "Kiro",
    cliAlias: "kiro",
    provider: "kiro",
    executionMode: "t3_driver",
    roleTitle: "general",
    isolationMode: "shared",
    approvalMode: "ask",
    avatar: "preset:kiro",
    pinned: false,
    department: "Magpie · T3 Code",
  },
  pi: {
    externalId: "pi",
    botId: "bot_pi",
    slug: "pi",
    handle: "Pi",
    displayName: "Pi",
    cliAlias: "pi",
    provider: "pi",
    executionMode: "t3_driver",
    roleTitle: "general",
    isolationMode: "shared",
    approvalMode: "ask",
    avatar: "preset:pi",
    pinned: false,
    department: "Magpie · T3 Code",
  },
};

function sanitizeSlug(raw) {
  const cleaned = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "agent";
}

function makeCompactHandle(rawName) {
  const tokens = String(rawName || "")
    .trim()
    .replace(/[^a-zA-Z0-9\s_-]+/g, "")
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (tokens.length === 0) return "Agent";
  return tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join("");
}

function stripMagpiePrefix(modelId) {
  const trimmed = String(modelId || "").trim();
  return trimmed.startsWith("magpie/") ? trimmed.slice("magpie/".length) : trimmed;
}

function resolveGeminiFallbackModel(availableModels) {
  const ids = Array.isArray(availableModels)
    ? availableModels.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean)
    : [];
  const autoGemini = ids.find((id) => /^auto\/gemini/i.test(id));
  if (autoGemini) return autoGemini;
  const googleModel = ids.find((id) => /^google\//i.test(id));
  if (googleModel) return googleModel;
  const anyGemini = ids.find((id) => /gemini/i.test(id));
  return anyGemini || "gemini";
}

/**
 * Parses `magpie ls` output into configured coding agents, unconfigured agents, and host apps.
 */
export function parseMagpieLsOutput(stdout, options = {}) {
  const availableModels = options.availableModels ?? [];
  const cleanText = String(stdout || "").replace(ANSI_RE, "");
  const rawLines = cleanText.split(/\r?\n/);

  const parsedEntries = [];
  for (const rawLine of rawLines) {
    const trimmedRight = rawLine.replace(/\s+$/, "");
    const trimmed = trimmedRight.trim();
    if (!trimmed) continue;

    let left = trimmed;
    let configPath = "";
    let forcedStatus = "";

    const pathMatch = /^(.*?)\s{2,}((?:~[\\/]|[A-Za-z]:[\\/]|\/).+)$/.exec(trimmed);
    if (pathMatch) {
      left = pathMatch[1].trim();
      configPath = pathMatch[2].trim();
    } else {
      const notDetectedMatch = /^(.*?)\s{2,}(not detected)$/i.exec(trimmed);
      if (notDetectedMatch) {
        left = notDetectedMatch[1].trim();
        forcedStatus = "not detected";
      }
    }

    let agentName = left;
    let rawStatus = forcedStatus;
    if (!rawStatus) {
      const splitMatch = /^(.*?)\s{2,}(.+)$/.exec(left);
      if (splitMatch) {
        agentName = splitMatch[1].trim();
        rawStatus = splitMatch[2].trim();
      } else {
        agentName = left.trim();
        rawStatus = "";
      }
    }

    if (!agentName) continue;

    const lowerName = agentName.toLowerCase();
    const kind = HOST_APP_NAMES.has(lowerName) ? "host_app" : "coding_agent";
    const primaryToken = (rawStatus.split(/\s*·\s*/)[0] ?? "").trim();

    let configured = true;
    if (
      !primaryToken ||
      primaryToken === "—" ||
      primaryToken === "-" ||
      /^not detected$/i.test(primaryToken) ||
      /^provider\s+[—-]$/i.test(primaryToken) ||
      /^magpie\s+\S+\s+add\b/i.test(primaryToken) ||
      /(?:not signed in|\bdisabled\b|\boff)$/i.test(primaryToken)
    ) {
      configured = false;
    }

    const preset = KNOWN_AGENT_PRESETS[lowerName];
    const slug = preset ? preset.slug : sanitizeSlug(agentName);
    const botId = preset ? preset.botId : `bot_${slug}`;
    const externalId = preset ? preset.externalId : slug;

    let model = "";
    if (configured) {
      if (lowerName === "gemini cli" && (/^auth\b/i.test(primaryToken) || !primaryToken)) {
        model = resolveGeminiFallbackModel(availableModels);
      } else if (primaryToken && !/^auth\b/i.test(primaryToken)) {
        model = stripMagpiePrefix(primaryToken);
      }
    }

    const descriptor = {
      externalId,
      botId,
      slug,
      handle: preset ? preset.handle : makeCompactHandle(agentName),
      displayName: preset ? preset.displayName : agentName,
      agentName,
      cliAlias: preset ? preset.cliAlias : slug,
      kind,
      configured,
      rawStatus: rawStatus || "—",
      configPath,
      provider: preset ? preset.provider : "magpie-gateway",
      executionMode: preset ? preset.executionMode : "magpie_gateway",
      model,
      roleTitle: preset ? preset.roleTitle : "general",
      isolationMode: preset ? preset.isolationMode : "shared",
      approvalMode: preset ? preset.approvalMode : "ask",
      avatar: preset ? preset.avatar : "preset:magpie-gateway",
      pinned: preset ? Boolean(preset.pinned) : false,
      department: preset ? preset.department : "Magpie · Gateway",
      description: configured
        ? `通过 Magpie 自动发现（${rawStatus}）${configPath ? ` · ${configPath}` : ""}`
        : `未配置 (${rawStatus || "未检出"})`,
    };

    parsedEntries.push(descriptor);
  }

  const hostApps = [];
  const rawCodingAgents = [];
  for (const entry of parsedEntries) {
    if (entry.kind === "host_app") {
      hostApps.push(entry);
    } else {
      rawCodingAgents.push(entry);
    }
  }

  // Deduplicate coding agents sharing the same botId (e.g. Antigravity GUI vs Antigravity CLI).
  // Prefer configured entries over unconfigured ones for the same botId.
  const configuredByBotId = new Map();
  const configuredAgents = [];
  const unconfiguredAgents = [];

  for (const agent of rawCodingAgents) {
    if (agent.configured) {
      if (!configuredByBotId.has(agent.botId)) {
        configuredByBotId.set(agent.botId, agent);
        configuredAgents.push(agent);
      } else {
        unconfiguredAgents.push(agent);
      }
    }
  }

  for (const agent of rawCodingAgents) {
    if (!agent.configured) {
      unconfiguredAgents.push(agent);
    }
  }

  return {
    configuredAgents,
    unconfiguredAgents,
    hostApps,
  };
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveMagpieConfigDir() {
  const fromEnv = process.env.MAGPIE_CONFIG_DIR || process.env.MAGPIE_HOME;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return path.join(os.homedir(), ".config", "magpie");
}

function resolveMagpieBinary() {
  if (process.env.MAGPIE_BIN && fs.existsSync(process.env.MAGPIE_BIN)) {
    return process.env.MAGPIE_BIN;
  }
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "magpie", "magpie.com"),
      path.join(os.homedir(), "AppData", "Local", "Programs", "magpie", "magpie.com"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return "magpie.com";
  }
  return "magpie";
}

function resolveGatewayUrl(configDir) {
  if (process.env.MAGPIE_ADDR) {
    const raw = process.env.MAGPIE_ADDR.trim();
    return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, "") : `http://${raw}`;
  }
  const gw = readJsonSafe(path.join(configDir, "gateway.json"));
  if (gw && typeof gw.addr === "string" && gw.addr.trim()) {
    const addr = gw.addr.trim();
    return /^https?:\/\//i.test(addr) ? addr.replace(/\/+$/, "") : `http://${addr}`;
  }
  return "http://127.0.0.1:3425";
}

async function resolveWindowsProxyEnv(baseEnv) {
  const env = { ...baseEnv };
  if (env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy) {
    return env;
  }
  if (process.platform !== "win32") return env;
  try {
    const { stdout: enableOut } = await execFileAsync(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
    );
    if (!/0x1\b/i.test(enableOut)) {
      return env;
    }
    const { stdout: serverOut } = await execFileAsync(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
    );
    const match = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(serverOut);
    const rawServer = match?.[1]?.trim();
    if (!rawServer) return env;
    let proxyUrl = rawServer;
    if (rawServer.includes("=")) {
      const pairs = rawServer.split(";");
      const httpsPair = pairs.find((p) => /^https=/i.test(p.trim()));
      const httpPair = pairs.find((p) => /^http=/i.test(p.trim()));
      const picked = (httpsPair || httpPair || pairs[0] || "").split("=").slice(1).join("=").trim();
      proxyUrl = picked;
    }
    if (proxyUrl) {
      const normalized = /^https?:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`;
      env.HTTP_PROXY = normalized;
      env.HTTPS_PROXY = normalized;
    }
  } catch {
    // Ignore registry read failure
  }
  return env;
}

async function execMagpieCli(binaryPath, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 6000;
  const env = options.withProxy ? await resolveWindowsProxyEnv(process.env) : process.env;
  return execFileAsync(binaryPath, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function extractCliAlias(externalId) {
  const raw = String(externalId || "").trim().toLowerCase();
  for (const preset of Object.values(KNOWN_AGENT_PRESETS)) {
    if (preset.externalId.toLowerCase() === raw || preset.cliAlias.toLowerCase() === raw) {
      return preset;
    }
  }
  return { cliAlias: sanitizeSlug(raw), prefixMagpieOnSync: false };
}

function formatExecError(err) {
  const parts = [];
  if (err && typeof err === "object") {
    const out = `${err.stdout || ""}\n${err.stderr || ""}`.replace(ANSI_RE, "").trim();
    if (out) parts.push(out);
    if (typeof err.message === "string" && err.message.trim()) {
      parts.push(err.message.trim());
    }
  } else if (err !== undefined) {
    parts.push(String(err));
  }
  return parts.join("\n") || "Unknown command error";
}

function buildGatewayHeaders(extra = {}) {
  const headers = { ...extra };
  const gwKey = (process.env.MAGPIE_GATEWAY_KEY || "").trim();
  if (gwKey) {
    headers.Authorization = `Bearer ${gwKey}`;
  }
  return headers;
}

export function createPlugin(context = {}) {
  const pluginDir = context.pluginDir || import.meta.dirname || "";

  const fetchModelsInternal = async (gatewayUrl) => {
    try {
      const res = await fetch(`${gatewayUrl}/v1/models`, {
        method: "GET",
        headers: buildGatewayHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const rows = Array.isArray(data?.data) ? data.data : [];
      const models = rows
        .map((m) => {
          const id = String(m?.id || "").trim();
          if (!id) return null;
          const isGroup = id.startsWith("auto/") || id.startsWith("group/");
          return {
            id,
            displayName: String(m?.display_name || id),
            ownedBy: String(m?.owned_by || (id.includes("/") ? id.split("/")[0] : "magpie")),
            isRoutingGroup: isGroup,
            reasoning: Boolean(m?.reasoning),
            toolCall: Boolean(m?.tool_call),
          };
        })
        .filter(Boolean);

      models.sort((a, b) => {
        if (a.isRoutingGroup !== b.isRoutingGroup) {
          return a.isRoutingGroup ? -1 : 1;
        }
        return a.id.localeCompare(b.id);
      });
      return models;
    } catch {
      return [];
    }
  };

  const health = async () => {
    const configDir = resolveMagpieConfigDir();
    const binaryPath = resolveMagpieBinary();
    const gatewayUrl = resolveGatewayUrl(configDir);

    let statusJson = null;
    try {
      const { stdout } = await execMagpieCli(binaryPath, ["status", "--json"], { timeoutMs: 4000 });
      statusJson = JSON.parse(String(stdout || "{}").trim());
    } catch {
      statusJson = null;
    }

    let version = typeof statusJson?.version === "string" ? statusJson.version : "";
    if (!version) {
      try {
        const { stdout } = await execMagpieCli(binaryPath, ["--version"], { timeoutMs: 3000 });
        const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(String(stdout || ""));
        if (match) version = match[1];
      } catch {
        // Check if binary doesn't exist
        const hasConfig = fs.existsSync(configDir);
        if (!hasConfig && !statusJson) {
          return {
            ok: false,
            status: "not_installed",
            version: "",
            gatewayUrl,
            configDir,
            binaryPath,
            message: "未检测到本机 Magpie CLI 或 ~/.config/magpie 配置目录",
          };
        }
      }
    }

    let gatewayReachable = false;
    try {
      const res = await fetch(`${gatewayUrl}/v1/models`, {
        method: "GET",
        headers: buildGatewayHeaders(),
        signal: AbortSignal.timeout(3000),
      });
      gatewayReachable = res.ok;
    } catch {
      gatewayReachable = false;
    }

    const isRunning = Boolean(statusJson?.running) || gatewayReachable;
    if (isRunning) {
      return {
        ok: true,
        status: "running",
        version,
        gatewayUrl,
        configDir,
        binaryPath,
        message: `Magpie ${version || ""} 运行中 (${gatewayUrl})`.trim(),
        details: statusJson ?? undefined,
      };
    }

    if (fs.existsSync(configDir) || version) {
      return {
        ok: true,
        status: "installed_idle",
        version,
        gatewayUrl,
        configDir,
        binaryPath,
        message: `Magpie ${version || ""} 已安装（网关未启动，仍可通过 magpie ls 发现已配置 Agent）`.trim(),
        details: statusJson ?? undefined,
      };
    }

    return {
      ok: false,
      status: "not_installed",
      version: "",
      gatewayUrl,
      configDir,
      binaryPath,
      message: "未检测到 Magpie 安装",
    };
  };

  const listModels = async () => {
    const configDir = resolveMagpieConfigDir();
    const gatewayUrl = resolveGatewayUrl(configDir);
    return fetchModelsInternal(gatewayUrl);
  };

  const discoverAgents = async () => {
    const configDir = resolveMagpieConfigDir();
    const binaryPath = resolveMagpieBinary();
    const gatewayUrl = resolveGatewayUrl(configDir);

    const [models, lsOut] = await Promise.all([
      fetchModelsInternal(gatewayUrl),
      execMagpieCli(binaryPath, ["ls"], { timeoutMs: 6000 })
        .then((r) => r.stdout)
        .catch(() => ""),
    ]);

    const parsed = parseMagpieLsOutput(lsOut, { availableModels: models });
    return {
      ...parsed,
      gatewayUrl,
      detectedAt: Date.now(),
    };
  };

  const syncBotModel = async ({ externalId, model }) => {
    const targetModel = String(model || "").trim();
    if (!targetModel) {
      return { ok: false, message: "Model cannot be empty" };
    }
    const binaryPath = resolveMagpieBinary();
    const preset = extractCliAlias(externalId);
    const cliModel =
      preset.prefixMagpieOnSync && !targetModel.startsWith("magpie/")
        ? `magpie/${targetModel}`
        : targetModel;
    try {
      const { stdout, stderr } = await execMagpieCli(
        binaryPath,
        [preset.cliAlias, cliModel],
        { timeoutMs: 8000 },
      );
      return {
        ok: true,
        message: (stdout || stderr || `已同步 ${preset.cliAlias} -> ${cliModel}`).trim(),
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const chatCompletion = async ({ model, systemPrompt, messages, signal }) => {
    const configDir = resolveMagpieConfigDir();
    const gatewayUrl = resolveGatewayUrl(configDir);
    const cleanModel = stripMagpiePrefix(model);
    if (!cleanModel) {
      throw new Error("Magpie Gateway 未指定模型名称");
    }

    const payloadMessages = [];
    if (systemPrompt && String(systemPrompt).trim()) {
      payloadMessages.push({ role: "system", content: String(systemPrompt) });
    }
    for (const msg of messages || []) {
      payloadMessages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: String(msg.content || ""),
      });
    }

    const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: buildGatewayHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: cleanModel,
        messages: payloadMessages,
        stream: false,
      }),
      signal: signal ?? AbortSignal.timeout(120000),
    });

    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const errMsg = parsed?.error?.message || text || `HTTP ${res.status}`;
      throw new Error(`Magpie Gateway 请求失败 (${res.status}): ${errMsg}`);
    }

    const choice = parsed?.choices?.[0];
    const rawContent = choice?.message?.content;
    let content = "";
    if (typeof rawContent === "string") {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      content = rawContent
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
    }

    return {
      content: content.trim(),
      model: String(parsed?.model || cleanModel),
      usage: parsed?.usage ?? undefined,
    };
  };

  const checkUpdate = async () => {
    const binaryPath = resolveMagpieBinary();
    let currentVersion = "";
    try {
      const { stdout } = await execMagpieCli(binaryPath, ["--version"], { timeoutMs: 3000 });
      const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(String(stdout || ""));
      if (match) currentVersion = match[1];
    } catch {
      currentVersion = "";
    }

    const hasPluginGitRepo = Boolean(pluginDir && fs.existsSync(path.join(pluginDir, ".git")));

    let ok = true;
    let updateAvailable = false;
    let latestVersion = currentVersion;
    let summary = "";

    try {
      const { stdout, stderr } = await execMagpieCli(
        binaryPath,
        ["update", "check"],
        { timeoutMs: 35000, withProxy: true },
      );
      const output = `${stdout || ""}\n${stderr || ""}`.replace(ANSI_RE, "").trim();
      summary = output;
      const isLatest = /up to date|is the latest|already latest|newest|no update/i.test(output);
      const candidates = [...output.matchAll(/(\d+\.\d+\.\d+[^\s,)]*)/g)].map((m) => m[1]);
      const nextCandidate = [...candidates].reverse().find((c) => c && c !== currentVersion);
      if (!isLatest && nextCandidate) {
        updateAvailable = true;
        latestVersion = nextCandidate;
      } else if (!isLatest && candidates.length > 0 && !latestVersion) {
        latestVersion = candidates[candidates.length - 1];
      }
      if (!isLatest && /available|new version|->|upgrade/i.test(output)) {
        updateAvailable = true;
      }
    } catch (err) {
      ok = false;
      summary = `检查更新失败: ${formatExecError(err)}`;
    }

    return {
      ok,
      currentVersion,
      latestVersion,
      updateAvailable,
      supportsHostUpdate: true,
      supportsPluginGitUpdate: hasPluginGitRepo,
      summary: summary || (updateAvailable ? "发现新版本" : "当前已是最新版本"),
    };
  };

  const runUpdate = async ({ target = "host", force = false } = {}) => {
    if (target === "plugin") {
      if (!pluginDir || !fs.existsSync(path.join(pluginDir, ".git"))) {
        return {
          ok: false,
          target: "plugin",
          beforeVersion: "",
          afterVersion: "",
          output: "当前插件目录不是独立 Git 仓库，可先点击「迁出到独立目录」或自行替换文件后点击「热重载」。",
        };
      }
      const env = await resolveWindowsProxyEnv(process.env);
      const before = readJsonSafe(path.join(pluginDir, "plugin.json"))?.version || "";
      try {
        const { stdout, stderr } = await execFileAsync(
          "git",
          ["pull", "--ff-only"],
          { cwd: pluginDir, encoding: "utf8", timeout: 30000, windowsHide: true, env },
        );
        const after = readJsonSafe(path.join(pluginDir, "plugin.json"))?.version || before;
        return {
          ok: true,
          target: "plugin",
          beforeVersion: String(before),
          afterVersion: String(after),
          output: `${stdout || ""}\n${stderr || ""}`.trim() || "插件已更新",
        };
      } catch (err) {
        return {
          ok: false,
          target: "plugin",
          beforeVersion: String(before),
          afterVersion: String(before),
          output: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const binaryPath = resolveMagpieBinary();
    const readVer = async () => {
      try {
        const { stdout } = await execMagpieCli(binaryPath, ["--version"], { timeoutMs: 3000 });
        return /(\d+\.\d+\.\d+[^\s]*)/.exec(String(stdout || ""))?.[1] || "";
      } catch {
        return "";
      }
    };

    const beforeVersion = await readVer();
    const args = ["update"];
    if (force) args.push("--force");

    try {
      const { stdout, stderr } = await execMagpieCli(binaryPath, args, {
        timeoutMs: 120000,
        withProxy: true,
      });
      const afterVersion = await readVer();
      return {
        ok: true,
        target: "host",
        beforeVersion,
        afterVersion: afterVersion || beforeVersion,
        output: `${stdout || ""}\n${stderr || ""}`.replace(ANSI_RE, "").trim() || "Magpie 更新完成",
      };
    } catch (err) {
      return {
        ok: false,
        target: "host",
        beforeVersion,
        afterVersion: beforeVersion,
        output: formatExecError(err),
      };
    }
  };

  const getWatchPaths = () => {
    const configDir = resolveMagpieConfigDir();
    return [
      path.join(configDir, "applied.json"),
      path.join(configDir, "gateway.json"),
    ];
  };

  return {
    health,
    listModels,
    discoverAgents,
    syncBotModel,
    chatCompletion,
    checkUpdate,
    runUpdate,
    getWatchPaths,
  };
}
