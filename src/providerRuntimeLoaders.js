import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDoubaoStatus } from "./doubaoRuntime.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function splitCommandLine(input) {
  const args = [];
  let current = "";
  let quote = "";
  let escape = false;

  const value = String(input || "");
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\" && quote && (next === quote || next === "\\")) {
      escape = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) args.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function newestExisting(paths) {
  return paths
    .filter(pathExists)
    .map((filePath) => ({ filePath, mtime: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.filePath;
}

function findBundledCodexExe() {
  if (process.platform !== "win32") return "";
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const versionedBin = path.join(local, "OpenAI", "Codex", "bin");
  const candidates = [
    path.join(local, "Packages", "OpenAI.Codex_2p2nqsd0c76g0", "LocalCache", "Local", "OpenAI", "Codex", "bin", "codex.exe")
  ];
  if (pathExists(versionedBin)) {
    for (const entry of fs.readdirSync(versionedBin, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(versionedBin, entry.name, "codex.exe"));
    }
  }
  return newestExisting(candidates) || "";
}

function resolveCodexInvocation(commandLine = "auto") {
  const configured = String(commandLine || "auto").trim() || "auto";
  const auto = configured === "auto" || (process.platform === "win32" && /^codex(?:\.exe|\.cmd|\.ps1)?$/i.test(configured));
  if (auto) {
    const bundled = findBundledCodexExe();
    if (bundled) return { command: bundled, prefixArgs: [], displayCommand: configured };

    if (process.platform === "win32" && process.env.APPDATA) {
      const npmCli = path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
      if (pathExists(npmCli)) return { command: process.execPath, prefixArgs: [npmCli], displayCommand: configured };
    }
  }

  const parts = splitCommandLine(configured === "auto" ? "codex" : configured);
  return { command: parts[0] || "codex", prefixArgs: parts.slice(1), displayCommand: configured };
}

function resolveCommand(commandLine) {
  const parts = splitCommandLine(commandLine);
  return { command: parts[0] || "", prefixArgs: parts.slice(1), displayCommand: String(commandLine || "") };
}

function firstOutputLine(result) {
  return String(result.stdout || result.stderr || "").split(/\r?\n/).find(Boolean)?.slice(0, 240) || "";
}

function runCommand({ command, args = [], env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: "", stderr: error.message, latencyMs: Date.now() - startedAt });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...value, latencyMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, code: -1, stdout, stderr: stderr || "Provider command timed out." });
    }, timeoutMs);

    child.stdout?.on("data", (data) => { stdout = (stdout + data.toString()).slice(-MAX_RESPONSE_BYTES); });
    child.stderr?.on("data", (data) => { stderr = (stderr + data.toString()).slice(-MAX_RESPONSE_BYTES); });
    child.on("error", (error) => finish({ ok: false, code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, code: code ?? -1, stdout, stderr }));
  });
}

function codexEnvironment(settings) {
  return {
    ...process.env,
    ...(settings.apiKeys?.openai ? { OPENAI_API_KEY: settings.apiKeys.openai } : {})
  };
}

export function loadCodexAppServerCatalog({
  settings = {},
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const invocation = resolveCodexInvocation(settings.codexCommand || "auto");
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(invocation.command, [...invocation.prefixArgs, "app-server", "--stdio"], {
        env: codexEnvironment(settings),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }

    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (message) => finish(new Error(message));
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        finish(error);
      }
    };
    const timer = setTimeout(() => fail("Codex app-server model discovery timed out."), timeoutMs);

    child.stderr?.resume();
    child.stdin?.on("error", (error) => finish(error));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) fail(`Codex app-server exited before model discovery (code ${code ?? -1}).`);
    });
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        fail("Codex app-server model response exceeded the size limit.");
        return;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            fail("Codex app-server initialization failed.");
            return;
          }
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "model/list", params: { limit: 200 } });
        }
        if (message.id === 2) {
          if (message.error || !Array.isArray(message.result?.data)) {
            fail("Codex app-server model/list returned an invalid response.");
            return;
          }
          finish(null, {
            source: "codex-app-server:model/list",
            latencyMs: Date.now() - startedAt,
            models: message.result.data.map((model) => ({
              id: model?.id || model?.model || "",
              label: model?.displayName || model?.name || model?.id || model?.model || ""
            }))
          });
          return;
        }
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "vibelink-provider-registry", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] }
      }
    });
  });
}

function modelsUrl(base, provider) {
  const fallback = provider === "anthropic"
    ? "https://api.anthropic.com/v1/models"
    : "https://open.bigmodel.cn/api/paas/v4/models";
  const value = String(base || fallback).replace(/\/+$/, "");
  if (/\/models$/i.test(value)) return value;
  if (provider === "zhipu" && /\/chat\/completions$/i.test(value)) return value.replace(/\/chat\/completions$/i, "/models");
  if (provider === "zhipu") return `${value}/models`;
  if (/\/v1$/i.test(value)) return `${value}/models`;
  return `${value}/v1/models`;
}

async function fetchModelCatalog({ url, headers, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Provider model response exceeded the size limit.");
    if (!response.ok) throw new Error(`Provider model API returned HTTP ${response.status}.`);
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Provider model response exceeded the size limit.");
    const payload = JSON.parse(raw);
    const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : null;
    if (!data) throw new Error("Provider model API returned an invalid response.");
    return {
      latencyMs: Date.now() - startedAt,
      models: data.map((model) => typeof model === "string"
        ? { id: model, label: model }
        : {
            id: model?.id || model?.model || "",
            label: model?.display_name || model?.displayName || model?.name || model?.id || model?.model || ""
          })
    };
  } finally {
    clearTimeout(timer);
  }
}

function singleFlight(loader) {
  let pending = null;
  return async (...args) => {
    if (!pending) pending = Promise.resolve().then(() => loader(...args)).finally(() => { pending = null; });
    return pending;
  };
}

function commandFailure(result, fallback) {
  return String(result.stderr || result.stdout || fallback).split(/\r?\n/).find(Boolean)?.slice(0, 500) || fallback;
}

function doubaoFailure(result) {
  const direct = result?.status?.target?.reason || result?.error;
  if (direct) return String(direct);
  for (const raw of [result?.doctor?.stderr, result?.doctor?.stdout]) {
    const line = String(raw || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!line) continue;
    try {
      const payload = JSON.parse(line);
      if (payload?.error?.message) return String(payload.error.message);
    } catch {
      return line;
    }
  }
  return "Doubao browser bridge is not ready.";
}

export function createProviderRuntimeLoaders({
  getSettings = async () => ({}),
  runCommandImpl = runCommand,
  fetchImpl = globalThis.fetch,
  codexCatalogLoader = loadCodexAppServerCatalog,
  doubaoStatusLoader = getDoubaoStatus,
  anthropicModelsUrl = process.env.ANTHROPIC_MODELS_URL || modelsUrl(process.env.ANTHROPIC_BASE_URL, "anthropic"),
  zhipuModelsUrl = process.env.ZHIPU_MODELS_URL || modelsUrl(process.env.ZHIPU_BASE_URL, "zhipu"),
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const loadRuntimeSettings = singleFlight(() => getSettings());
  const loadZhipu = singleFlight(async () => {
    const settings = await loadRuntimeSettings();
    const apiKey = settings.apiKeys?.zhipu || "";
    if (!apiKey) throw new Error("GLM API key is not configured.");
    const result = await fetchModelCatalog({
      url: zhipuModelsUrl,
      headers: { Authorization: `Bearer ${apiKey}` },
      fetchImpl,
      timeoutMs
    });
    return { ...result, source: "zhipu-model-api" };
  });

  const loadDoubao = singleFlight(async () => {
    const settings = await loadRuntimeSettings();
    const startedAt = Date.now();
    const result = await doubaoStatusLoader({
      endpoint: settings.doubaoCdpEndpoint,
      url: settings.doubaoUrl,
      timeoutMs
    });
    if (!result?.ok) {
      throw new Error(doubaoFailure(result));
    }
    return { result, latencyMs: Date.now() - startedAt };
  });

  return {
    catalogLoaders: {
      codex: async () => codexCatalogLoader({ settings: await loadRuntimeSettings(), timeoutMs }),
      claude: async () => {
        const settings = await loadRuntimeSettings();
        const apiKey = settings.apiKeys?.anthropic || "";
        if (!apiKey) throw new Error("Claude API key is not configured for model discovery.");
        return {
          source: "anthropic-model-api",
          ...await fetchModelCatalog({
            url: anthropicModelsUrl,
            headers: { "anthropic-version": "2023-06-01", "x-api-key": apiKey },
            fetchImpl,
            timeoutMs
          })
        };
      },
      doubao: async () => {
        await loadDoubao();
        return { source: "doubao-browser-bridge", models: [{ id: "doubao-web", label: "Web default" }] };
      },
      zhipu: async () => loadZhipu()
    },
    healthLoaders: {
      codex: async () => {
        const settings = await loadRuntimeSettings();
        if (settings.codexCommand === "disabled" || settings.codexCommand === false) {
          return { ok: false, status: "disabled", source: "codex-cli", error: "Codex is disabled in settings." };
        }
        const invocation = resolveCodexInvocation(settings.codexCommand || "auto");
        const result = await runCommandImpl({
          command: invocation.command,
          args: [...invocation.prefixArgs, "--version"],
          env: codexEnvironment(settings),
          timeoutMs
        });
        if (!result.ok) {
          return {
            ok: false,
            source: "codex-cli",
            version: "",
            latencyMs: result.latencyMs,
            error: commandFailure(result, "Codex command is unavailable.")
          };
        }
        const auth = await runCommandImpl({
          command: invocation.command,
          args: [...invocation.prefixArgs, "login", "status"],
          env: codexEnvironment(settings),
          timeoutMs
        });
        return {
          ok: auth.ok,
          source: "codex-cli",
          version: firstOutputLine(result),
          latencyMs: Number(result.latencyMs || 0) + Number(auth.latencyMs || 0),
          error: auth.ok ? "" : "Codex authentication is not ready."
        };
      },
      claude: async () => {
        const settings = await loadRuntimeSettings();
        if (settings.claudeCommand === "disabled" || settings.claudeCommand === false) {
          return { ok: false, status: "disabled", source: "claude-cli", error: "Claude is disabled in settings." };
        }
        const invocation = resolveCommand(settings.claudeCommand || "claude");
        const result = await runCommandImpl({
          command: invocation.command,
          args: [...invocation.prefixArgs, "--version"],
          env: {
            ...process.env,
            ...(settings.apiKeys?.anthropic ? { ANTHROPIC_API_KEY: settings.apiKeys.anthropic } : {})
          },
          timeoutMs
        });
        return {
          ok: result.ok,
          source: "claude-cli",
          version: result.ok ? firstOutputLine(result) : "",
          latencyMs: result.latencyMs,
          error: result.ok ? "" : commandFailure(result, "Claude command is unavailable.")
        };
      },
      doubao: async () => {
        try {
          const loaded = await loadDoubao();
          return { ok: true, source: "doubao-browser-bridge", latencyMs: loaded.latencyMs };
        } catch (error) {
          return { ok: false, source: "doubao-browser-bridge", error: error.message };
        }
      },
      zhipu: async () => {
        try {
          const loaded = await loadZhipu();
          return { ok: true, source: loaded.source, latencyMs: loaded.latencyMs };
        } catch (error) {
          return {
            ok: false,
            status: /not configured/i.test(error.message) ? "missing_credentials" : "unavailable",
            source: "zhipu-model-api",
            error: error.message
          };
        }
      }
    }
  };
}

export const __testInternals = {
  runCommand,
  splitCommandLine
};
