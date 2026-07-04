import crypto from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dataDir, defaultSettings, settingsPath, tasksDir } from "./config.js";

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
    const settings = mergeSettings(defaultSettings, parsed);

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
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function publicSettings(settings) {
  return {
    host: settings.host,
    port: settings.port,
    pairingTokenConfigured: Boolean(settings.pairingToken),
    defaultCwd: settings.defaultCwd,
    claudeCommand: settings.claudeCommand,
    codexCommand: settings.codexCommand,
    codexTemplate: settings.codexTemplate,
    permissionMode: settings.permissionMode,
    allowedRoots: Array.isArray(settings.allowedRoots) ? settings.allowedRoots : [],
    hostAllowlist: Array.isArray(settings.hostAllowlist) ? settings.hostAllowlist : [],
    allowTryCloudflare: settings.allowTryCloudflare !== false,
    allowLegacyPairingTokenLogin: Boolean(settings.allowLegacyPairingTokenLogin),
    notificationEmailConfigured: Boolean(settings.notificationEmail),
    webPush: {
      enabled: Boolean(settings.webPush?.publicKey),
      publicKey: settings.webPush?.publicKey || ""
    },
    hasOpenAIKey: Boolean(settings.apiKeys.openai),
    hasAnthropicKey: Boolean(settings.apiKeys.anthropic)
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
