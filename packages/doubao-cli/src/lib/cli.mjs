import { startBridgeDaemon } from "./bridge-daemon.mjs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 45771;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_DOUBAO_URL = "https://www.doubao.com/chat/";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");

function write(stream, value) {
  stream.write(`${value}\n`);
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let value = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => { value += chunk; });
    stream.on("end", () => resolve(value));
    stream.on("error", reject);
  });
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    command: "",
    json: false,
    jsonl: false,
    subcommand: "",
    prompt: "",
    stdin: false,
    stream: false,
    noDaemon: false,
    noOpen: false,
    extensionPath: "",
    portExplicit: false,
    urlExplicit: false,
    port: Number(env.DOUBAO_BRIDGE_PORT || DEFAULT_PORT),
    bridgeUrl: env.DOUBAO_BRIDGE_URL || "",
    token: env.DOUBAO_BRIDGE_TOKEN || "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    url: env.DOUBAO_WEB_URL || DEFAULT_DOUBAO_URL
  };

  const items = [...argv];
  options.command = items.shift() || "help";
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const next = () => items[++index] || "";
    if (options.command === "daemon" && !options.subcommand && !item.startsWith("-")) {
      options.subcommand = item;
    }
    if (item === "--json") options.json = true;
    else if (item === "--jsonl") options.jsonl = true;
    else if (item === "--prompt" || item === "-p") options.prompt = next();
    else if (item === "--stdin") options.stdin = true;
    else if (item === "--stream") options.stream = true;
    else if (item === "--no-daemon") options.noDaemon = true;
    else if (item === "--no-open") options.noOpen = true;
    else if (item === "--port") {
      const value = Number(next());
      options.portExplicit = true;
      options.port = Number.isFinite(value) ? value : DEFAULT_PORT;
    }
    else if (item === "--bridge-url") options.bridgeUrl = next();
    else if (item === "--token") options.token = next();
    else if (item === "--extension-path") options.extensionPath = next();
    else if (item === "--timeout-ms") options.timeoutMs = Number(next()) || DEFAULT_TIMEOUT_MS;
    else if (item === "--url") {
      options.urlExplicit = true;
      options.url = next();
    }
    else if (!options.prompt && options.command === "ask") options.prompt = item;
  }

  const saved = readConfig(env);
  if (saved?.bridge) {
    if (!options.portExplicit && Number(saved.bridge.port)) options.port = Number(saved.bridge.port);
    if (!options.token && saved.bridge.token) options.token = String(saved.bridge.token);
  }
  if (!options.urlExplicit && saved?.doubao?.url) options.url = String(saved.doubao.url);
  if (!options.bridgeUrl) options.bridgeUrl = `http://127.0.0.1:${options.port}`;
  return options;
}

function homeDir(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function configDir(env = process.env) {
  if (process.platform === "win32") {
    return path.join(env.APPDATA || path.join(homeDir(env), "AppData", "Roaming"), "doubao-cli");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir(env), "Library", "Application Support", "doubao-cli");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir(env), ".config"), "doubao-cli");
}

function configPath(env = process.env) {
  return path.join(configDir(env), "config.json");
}

function readConfig(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(configPath(env), "utf8"));
  } catch {
    return null;
  }
}

function jsonError(code, message, suggestion = "") {
  return {
    ok: false,
    backend: "extension_bridge",
    error: {
      code,
      message,
      recoverable: true,
      ...(suggestion ? { suggestion } : {})
    }
  };
}

async function fetchBridgeJson(options, route, init = {}, fetchTimeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(`${options.bridgeUrl.replace(/\/+$/, "")}${route}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(init.headers || {})
      }
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    return { ok: response.ok, status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function runDoctor(options) {
  try {
    const response = await fetchBridgeJson(options, "/status");
    if (!response.ok) {
      return jsonError("BRIDGE_OFFLINE", `Doubao bridge returned HTTP ${response.status}.`, "Run doubao daemon start and ensure the browser extension is connected.");
    }
    if (!response.payload?.ok) {
      return {
        ok: false,
        backend: "extension_bridge",
        error: response.payload?.error || {
          code: "EXTENSION_OFFLINE",
          message: "Doubao bridge is reachable but not ready.",
          recoverable: true
        },
        bridge: response.payload
      };
    }
    return {
      ok: true,
      backend: "extension_bridge",
      bridge: response.payload
    };
  } catch {
    return jsonError("BRIDGE_OFFLINE", "Doubao bridge daemon is not reachable.", "Run doubao daemon start, then retry doubao doctor --json.");
  }
}

async function runAsk(options) {
  if (!options.prompt) {
    return jsonError("INVALID_REQUEST", "Doubao ask requires --prompt or a positional prompt.");
  }

  try {
    const response = await fetchBridgeJson(options, "/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "doubao.ask",
        params: {
          prompt: options.prompt,
          timeoutMs: options.timeoutMs,
          url: options.url,
          conversation: "current",
          stream: options.stream
        },
        timeoutMs: options.timeoutMs
      })
    }, Math.max(3000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS) + 1000));

    if (!response.ok || response.payload?.ok === false) {
      return {
        ok: false,
        backend: "extension_bridge",
        error: response.payload?.error || {
          code: response.status === 409 ? "EXTENSION_OFFLINE" : "ANSWER_TIMEOUT",
          message: "Doubao bridge request failed.",
          recoverable: true
        },
        bridge: response.payload
      };
    }

    const result = response.payload?.result || {};
    return {
      ok: true,
      backend: "extension_bridge",
      provider: result.provider || "doubao",
      model: result.model || "doubao-web",
      text: String(result.text || ""),
      url: result.url || options.url,
      elapsedMs: result.elapsedMs
    };
  } catch {
    return jsonError("BRIDGE_OFFLINE", "Doubao bridge daemon is not reachable.", "Run doubao daemon start, then retry doubao ask.");
  }
}

async function runDaemon(options, stdout) {
  if (options.subcommand === "status") {
    return runDoctor(options);
  }

  if (options.subcommand !== "run" && options.subcommand !== "start") {
    return jsonError("INVALID_REQUEST", "Usage: doubao daemon run --json");
  }

  const daemon = await startBridgeDaemon({ port: options.port, token: options.token });
  write(stdout, JSON.stringify({
    ok: true,
    event: "daemon_ready",
    backend: "extension_bridge",
    port: daemon.port
  }));

  return new Promise((resolve) => {
    const shutdown = async () => {
      try {
        await daemon.close();
      } finally {
        resolve({ ok: true });
      }
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function copyDirectory(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function startDetachedDaemon(options) {
  const binPath = path.join(PACKAGE_ROOT, "src", "bin", "doubao.mjs");
  const args = [
    binPath,
    "daemon",
    "run",
    "--json",
    "--port",
    String(options.port || DEFAULT_PORT)
  ];
  if (options.token) args.push("--token", options.token);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return true;
}

function openUrl(targetUrl) {
  if (!targetUrl) return false;
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", targetUrl], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  }
  if (process.platform === "darwin") {
    spawn("open", [targetUrl], { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  spawn("xdg-open", [targetUrl], { detached: true, stdio: "ignore" }).unref();
  return true;
}

function configurePayload(options, env = process.env) {
  const targetConfigPath = configPath(env);
  const extensionPath = options.extensionPath || path.join(configDir(env), "extension");
  const bridgeToken = options.token || crypto.randomBytes(32).toString("hex");
  const bridgePort = options.port || DEFAULT_PORT;
  const bridgeUrl = `ws://127.0.0.1:${bridgePort}/extension`;
  return {
    configPath: targetConfigPath,
    config: {
      bridge: {
        port: bridgePort,
        token: bridgeToken,
        url: bridgeUrl,
        autoStart: true
      },
      browser: {
        extensionPath
      },
      doubao: {
        url: options.url || DEFAULT_DOUBAO_URL,
        conversation: "current",
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS
      }
    },
    extensionPath
  };
}

async function runConfigure(options, env = process.env) {
  const prepared = configurePayload(options, env);
  const sourceExtensionPath = path.join(PACKAGE_ROOT, "apps", "extension");
  fs.mkdirSync(path.dirname(prepared.configPath), { recursive: true });
  copyDirectory(sourceExtensionPath, prepared.extensionPath);
  fs.writeFileSync(path.join(prepared.extensionPath, "generated-config.json"), `${JSON.stringify({
    bridgeUrl: prepared.config.bridge.url,
    bridgeToken: prepared.config.bridge.token,
    doubaoUrl: prepared.config.doubao.url
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(prepared.configPath, `${JSON.stringify(prepared.config, null, 2)}\n`, "utf8");

  const daemonStarted = options.noDaemon ? false : startDetachedDaemon({
    port: prepared.config.bridge.port,
    token: prepared.config.bridge.token
  });
  const browserOpened = options.noOpen ? false : openUrl(prepared.config.doubao.url);

  const nextActions = [
    `Load unpacked Chrome extension from: ${prepared.extensionPath}`,
    `Open ${prepared.config.doubao.url} and log in if needed.`,
    daemonStarted ? `Bridge daemon started on port ${prepared.config.bridge.port}.` : `Run: doubao daemon run --json`,
    `Run: doubao doctor --json`,
    `Run: doubao ask --json --prompt "你好"`
  ];

  return {
    ok: true,
    command: "configure",
    backend: "extension_bridge",
    configPath: prepared.configPath,
    bridge: {
      port: prepared.config.bridge.port,
      url: prepared.config.bridge.url,
      tokenConfigured: Boolean(prepared.config.bridge.token)
    },
    extension: {
      path: prepared.extensionPath,
      installed: false
    },
    manualActionRequired: true,
    nextActions,
    daemonStarted,
    browserOpened
  };
}

function printHelp(stream) {
  write(stream, "Usage: doubao configure --json | doubao doctor --json | doubao ask --json --prompt <text>");
}

export async function runDoubaoCli(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const stdin = io.stdin || process.stdin;
  const env = io.env || process.env;
  const options = parseArgs(argv, env);

  if (options.command === "help" || options.command === "--help" || options.command === "-h") {
    printHelp(stdout);
    return 0;
  }

  if (options.command === "doctor") {
    const result = await runDoctor(options);
    if (options.json) write(stdout, JSON.stringify(result));
    else if (result.ok) write(stdout, "Doubao bridge is ready.");
    else write(stderr, result.error?.message || "Doubao bridge is not ready.");
    return result.ok ? 0 : 1;
  }

  if (options.command === "configure") {
    const result = await runConfigure(options, env);
    if (options.json) write(stdout, JSON.stringify(result));
    else {
      write(stdout, `Doubao CLI configured at ${result.configPath}`);
      for (const action of result.nextActions) write(stdout, `- ${action}`);
    }
    return result.ok ? 0 : 1;
  }

  if (options.command === "daemon" && options.subcommand === "status") {
    const result = await runDoctor(options);
    if (options.json) write(stdout, JSON.stringify(result));
    else if (result.ok) write(stdout, "Doubao bridge is ready.");
    else write(stderr, result.error?.message || "Doubao bridge is not ready.");
    return result.ok ? 0 : 1;
  }

  if (options.command === "daemon") {
    const result = await runDaemon(options, stdout);
    if (result?.error && options.json) write(stdout, JSON.stringify(result));
    else if (result?.error) write(stderr, result.error.message);
    return result?.ok ? 0 : 1;
  }

  if (options.command === "ask") {
    if (options.stdin && !options.prompt) options.prompt = await readAll(stdin);
    const result = await runAsk(options);
    if (options.json) write(stdout, JSON.stringify(result));
    else if (result.ok) write(stdout, result.text);
    else write(stderr, result.error?.message || "Doubao ask failed.");
    return result.ok ? 0 : 1;
  }

  const result = jsonError("NOT_IMPLEMENTED", `Unsupported command: ${options.command}.`);
  if (options.json) write(stdout, JSON.stringify(result));
  else write(stderr, result.error.message);
  return 1;
}

export const __testInternals = {
  parseArgs,
  runDoctor,
  runAsk,
  runConfigure,
  configPath,
  readConfig
};
