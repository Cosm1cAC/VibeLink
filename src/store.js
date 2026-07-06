import crypto from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dataDir, defaultSettings, settingsPath, tasksDir } from "./config.js";
import { credentialBackend, readApiKeys, writeApiKeys } from "./credentialStore.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeSettings(base, next) {
  return {
    ...base,
    ...next,
    webPush: {
      ...base.webPush,
      ...(next?.webPush || {})
    },
    apiKeys: {
      ...base.apiKeys,
      ...(next?.apiKeys || {})
    },
    security: {
      ...base.security,
      ...(next?.security || {})
    },
    toolEvents: {
      ...base.toolEvents,
      ...(next?.toolEvents || {})
    },
    mcp: {
      ...base.mcp,
      ...(next?.mcp || {}),
      servers: Array.isArray(next?.mcp?.servers) ? next.mcp.servers : base.mcp?.servers || []
    }
  };
}

function sanitizeSecurity(value = {}) {
  const next = {};
  const sandboxValues = new Set(["read-only", "workspace-write", "danger-full-access"]);
  const approvalValues = new Set(["never", "on-request", "on-failure", "untrusted", "strict"]);
  if (sandboxValues.has(value.sandboxMode)) next.sandboxMode = value.sandboxMode;
  if (approvalValues.has(value.approvalPolicy)) next.approvalPolicy = value.approvalPolicy;
  if (typeof value.networkAccess === "boolean") next.networkAccess = value.networkAccess;
  if (typeof value.requireTrustedWorkspace === "boolean") next.requireTrustedWorkspace = value.requireTrustedWorkspace;
  if (typeof value.requireDangerousCommandApproval === "boolean") next.requireDangerousCommandApproval = value.requireDangerousCommandApproval;
  if (Array.isArray(value.trustedWorkspaces)) {
    next.trustedWorkspaces = value.trustedWorkspaces.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
  return next;
}

function sanitizeToolEvents(value = {}) {
  const next = {};
  const retentionDays = Number(value.retentionDays);
  const keepLatest = Number(value.keepLatest);
  const autoPruneIntervalMinutes = Number(value.autoPruneIntervalMinutes);

  if (Number.isFinite(retentionDays)) next.retentionDays = Math.min(3650, Math.max(1, Math.round(retentionDays)));
  if (Number.isFinite(keepLatest)) next.keepLatest = Math.min(500000, Math.max(0, Math.round(keepLatest)));
  if (typeof value.autoPrune === "boolean") next.autoPrune = value.autoPrune;
  if (Number.isFinite(autoPruneIntervalMinutes)) {
    next.autoPruneIntervalMinutes = Math.min(10080, Math.max(15, Math.round(autoPruneIntervalMinutes)));
  }

  return next;
}

function cleanName(value = "", max = 80) {
  return String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
}

function sanitizeMcpServer(value = {}) {
  const type = ["stdio", "http", "streamable-http"].includes(value.type) ? value.type : "stdio";
  const server = {
    id: cleanName(value.id || value.name || crypto.randomBytes(4).toString("hex")),
    name: cleanName(value.name || value.id || "mcp-server"),
    type,
    enabled: value.enabled !== false
  };

  if (type === "stdio") {
    server.command = typeof value.command === "string" ? value.command.trim().slice(0, 500) : "";
    server.args = Array.isArray(value.args)
      ? value.args.filter((item) => typeof item === "string").map((item) => item.slice(0, 500)).slice(0, 40)
      : typeof value.args === "string"
        ? value.args.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean).slice(0, 40)
        : [];
    server.cwd = typeof value.cwd === "string" ? value.cwd.trim().slice(0, 1000) : "";
    if (Object.prototype.hasOwnProperty.call(value, "env") && value.env && typeof value.env === "object" && !Array.isArray(value.env)) {
      server.env = {};
      for (const [key, envValue] of Object.entries(value.env)) {
        const envKey = cleanName(key, 120);
        if (envKey && typeof envValue === "string") server.env[envKey] = envValue.slice(0, 2000);
      }
    }
  } else {
    server.url = typeof value.url === "string" ? value.url.trim().slice(0, 2000) : "";
    if (Object.prototype.hasOwnProperty.call(value, "headers") && value.headers && typeof value.headers === "object" && !Array.isArray(value.headers)) {
      server.headers = {};
      for (const [key, headerValue] of Object.entries(value.headers)) {
        const headerKey = String(key || "").trim().slice(0, 120);
        if (headerKey && typeof headerValue === "string") server.headers[headerKey] = headerValue.slice(0, 2000);
      }
    }
  }

  return server;
}

function sanitizeMcp(value = {}) {
  const next = {};
  const probeTimeoutMs = Number(value.probeTimeoutMs);
  if (Number.isFinite(probeTimeoutMs)) next.probeTimeoutMs = Math.min(60000, Math.max(1000, Math.round(probeTimeoutMs)));
  if (Array.isArray(value.servers)) {
    const seen = new Set();
    next.servers = value.servers
      .map(sanitizeMcpServer)
      .filter((server) => {
        if (!server.id || seen.has(server.id)) return false;
        seen.add(server.id);
        return server.type === "stdio" ? Boolean(server.command) : Boolean(server.url);
      })
      .slice(0, 50);
  }
  return next;
}

function mergeSecretObject(existing = {}, next = null) {
  if (!next || typeof next !== "object" || Array.isArray(next)) return existing || {};
  const merged = {};
  for (const [key, value] of Object.entries(next)) {
    merged[key] = value === "configured" && existing?.[key] ? existing[key] : value;
  }
  return merged;
}

export function mergeMcpSettings(current = {}, patch = {}) {
  if (!patch || typeof patch !== "object") return current || {};
  const existingById = new Map(
    (Array.isArray(current.servers) ? current.servers : []).map((server) => [server.id || server.name, server])
  );
  const merged = {
    ...(current || {}),
    ...patch
  };

  if (Array.isArray(patch.servers)) {
    merged.servers = patch.servers.map((server) => {
      const existing = existingById.get(server.id || server.name) || {};
      const next = { ...server };
      if ((next.type || existing.type || "stdio") === "stdio") {
        if (Object.prototype.hasOwnProperty.call(server, "env")) next.env = mergeSecretObject(existing.env, server.env);
        else if (existing.env) next.env = existing.env;
      } else {
        if (Object.prototype.hasOwnProperty.call(server, "headers")) next.headers = mergeSecretObject(existing.headers, server.headers);
        else if (existing.headers) next.headers = existing.headers;
      }
      return next;
    });
  }

  return merged;
}

async function migratePlaintextApiKeys(settings) {
  const apiKeys = settings.apiKeys || {};
  const hasPlaintext = Boolean(apiKeys.openai || apiKeys.anthropic);
  if (!hasPlaintext) return settings;

  const stored = await writeApiKeys(apiKeys);
  const migrated = {
    ...settings,
    apiKeys: {
      openai: stored.openai ? "" : apiKeys.openai || "",
      anthropic: stored.anthropic ? "" : apiKeys.anthropic || ""
    }
  };
  if (stored.openai || stored.anthropic) await saveSettings(migrated);
  return migrated;
}

export async function settingsWithSecrets(settings) {
  const secrets = await readApiKeys();
  return {
    ...settings,
    apiKeys: {
      openai: secrets.openai || settings.apiKeys?.openai || "",
      anthropic: secrets.anthropic || settings.apiKeys?.anthropic || "",
      zhipu: secrets.zhipu || settings.apiKeys?.zhipu || ""
    }
  };
}

export async function ensureDataDirs() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(tasksDir, { recursive: true });
}

export async function loadSettings() {
  await ensureDataDirs();

  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    let settings = mergeSettings(defaultSettings, parsed);

    if (
      process.platform === "win32" &&
      (!settings.codexCommand ||
        /^codex(\.exe)?$/i.test(settings.codexCommand) ||
        /\\WindowsApps\\OpenAI\.Codex_/i.test(settings.codexCommand))
    ) {
      settings.codexCommand = "auto";
    }

    if (!settings.codexTemplate || settings.codexTemplate.trim() === "exec {prompt}") {
      settings.codexTemplate = "";
    }

    if (!settings.pairingToken) {
      settings.pairingToken = crypto.randomBytes(4).toString("hex").toUpperCase();
      await saveSettings(settings);
    }

    settings = await migratePlaintextApiKeys(settings);
    return settings;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    const settings = clone(defaultSettings);
    settings.pairingToken = crypto.randomBytes(4).toString("hex").toUpperCase();
    await saveSettings(settings);
    return settings;
  }
}

export async function saveSettings(settings) {
  await ensureDataDirs();
  const safeSettings = {
    ...settings,
    apiKeys: {
      openai: "",
      anthropic: "",
      zhipu: ""
    }
  };
  await writeFile(settingsPath, `${JSON.stringify(safeSettings, null, 2)}\n`, "utf8");
}

export async function publicSettings(settings) {
  const secrets = await readApiKeys();
  const backend = await credentialBackend();
  return {
    host: settings.host,
    port: settings.port,
    pairingTokenConfigured: Boolean(settings.pairingToken),
    defaultCwd: settings.defaultCwd,
    claudeCommand: settings.claudeCommand,
    codexCommand: settings.codexCommand,
    codexTemplate: settings.codexTemplate,
    permissionMode: settings.permissionMode,
    security: {
      ...defaultSettings.security,
      ...(settings.security || {})
    },
    allowedRoots: Array.isArray(settings.allowedRoots) ? settings.allowedRoots : [],
    hostAllowlist: Array.isArray(settings.hostAllowlist) ? settings.hostAllowlist : [],
    allowTryCloudflare: settings.allowTryCloudflare !== false,
    allowLegacyPairingTokenLogin: Boolean(settings.allowLegacyPairingTokenLogin),
    notificationEmailConfigured: Boolean(settings.notificationEmail),
    webPush: {
      enabled: Boolean(settings.webPush?.publicKey),
      publicKey: settings.webPush?.publicKey || ""
    },
    toolEvents: {
      ...defaultSettings.toolEvents,
      ...(settings.toolEvents || {})
    },
    mcp: {
      probeTimeoutMs: settings.mcp?.probeTimeoutMs || defaultSettings.mcp.probeTimeoutMs,
      servers: Array.isArray(settings.mcp?.servers)
        ? settings.mcp.servers.map((server) => ({
            ...server,
            env: undefined,
            headers: undefined,
            envKeys: server.env ? Object.keys(server.env) : [],
            headerKeys: server.headers ? Object.keys(server.headers) : []
          }))
        : []
    },
    credentials: backend,
    hasOpenAIKey: Boolean(secrets.openai || settings.apiKeys?.openai),
    hasAnthropicKey: Boolean(secrets.anthropic || settings.apiKeys?.anthropic),
    hasZhipuKey: Boolean(secrets.zhipu || settings.apiKeys?.zhipu)
  };
}

export function sanitizeSettingsPatch(patch = {}) {
  const next = {};
  const allowed = [
    "defaultCwd",
    "claudeCommand",
    "codexCommand",
    "codexTemplate",
    "permissionMode",
    "notificationEmail"
  ];

  for (const key of allowed) {
    if (typeof patch[key] === "string") next[key] = patch[key].trim();
  }

  if (patch.apiKeys && typeof patch.apiKeys === "object") {
    next.apiKeys = {};

    if (typeof patch.apiKeys.openai === "string" && patch.apiKeys.openai.trim()) {
      next.apiKeys.openai = patch.apiKeys.openai.trim();
    }

    if (typeof patch.apiKeys.anthropic === "string" && patch.apiKeys.anthropic.trim()) {
      next.apiKeys.anthropic = patch.apiKeys.anthropic.trim();
    }

    if (typeof patch.apiKeys.zhipu === "string" && patch.apiKeys.zhipu.trim()) {
      next.apiKeys.zhipu = patch.apiKeys.zhipu.trim();
    }
  }

  if (patch.security && typeof patch.security === "object") {
    next.security = sanitizeSecurity(patch.security);
  }

  if (Array.isArray(patch.allowedRoots)) {
    next.allowedRoots = patch.allowedRoots.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }

  if (Array.isArray(patch.hostAllowlist)) {
    next.hostAllowlist = patch.hostAllowlist.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }

  if (typeof patch.allowTryCloudflare === "boolean") {
    next.allowTryCloudflare = patch.allowTryCloudflare;
  }

  if (typeof patch.allowLegacyPairingTokenLogin === "boolean") {
    next.allowLegacyPairingTokenLogin = patch.allowLegacyPairingTokenLogin;
  }

  if (patch.webPush && typeof patch.webPush === "object") {
    next.webPush = {};
    if (typeof patch.webPush.subject === "string") next.webPush.subject = patch.webPush.subject.trim();
  }

  if (patch.toolEvents && typeof patch.toolEvents === "object") {
    next.toolEvents = sanitizeToolEvents(patch.toolEvents);
  }

  if (patch.mcp && typeof patch.mcp === "object") {
    next.mcp = sanitizeMcp(patch.mcp);
  }

  return next;
}

export function readJsonLines(filePath, limit = 200) {
  if (!fs.existsSync(filePath)) return [];
  const raw = readTailText(filePath, limit);
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const selected = limit > 0 ? lines.slice(-limit) : lines;
  const items = [];

  for (const line of selected) {
    try {
      items.push(JSON.parse(line));
    } catch {
      items.push({ raw: line });
    }
  }

  return items;
}

function readTailText(filePath, limit) {
  if (!limit || limit <= 0) return fs.readFileSync(filePath, "utf8");

  const stat = fs.statSync(filePath);
  const chunkSize = 512 * 1024;
  let position = stat.size;
  let chunks = [];
  let newlineCount = 0;

  while (position > 0 && newlineCount <= limit) {
    const size = Math.min(chunkSize, position);
    position -= size;
    const buffer = Buffer.allocUnsafe(size);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, size, position);
    } finally {
      fs.closeSync(fd);
    }
    chunks.unshift(buffer);
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] === 10) newlineCount += 1;
    }
  }

  return Buffer.concat(chunks).toString("utf8");
}
