import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { dataDir } from "./config.js";

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function resolveProbeCwd(settings) {
  const candidates = [settings.defaultCwd, process.cwd(), os.homedir()].filter(Boolean).map((item) => path.resolve(item));
  return candidates.find(isDirectory) || process.cwd();
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
  const openAiBin = path.join(local, "OpenAI", "Codex", "bin");
  const packageBin = path.join(local, "Packages", "OpenAI.Codex_2p2nqsd0c76g0", "LocalCache", "Local", "OpenAI", "Codex", "bin");
  const candidates = [];

  if (pathExists(openAiBin)) {
    for (const entry of fs.readdirSync(openAiBin, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(openAiBin, entry.name, "codex.exe"));
    }
  }

  candidates.push(path.join(packageBin, "codex.exe"));
  return newestExisting(candidates) || "";
}

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
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

function resolveCodexCommand(settings) {
  const configured = String(settings.codexCommand || "auto").trim();
  const shouldAuto =
    !configured ||
    configured === "auto" ||
    (process.platform === "win32" && /^codex(\.exe)?$/i.test(configured)) ||
    /\\WindowsApps\\OpenAI\.Codex_/i.test(configured);

  if (shouldAuto) {
    const bundled = findBundledCodexExe();
    if (bundled) return { command: bundled, args: [] };
    if (process.platform === "win32" && process.env.APPDATA) {
      const npmCli = path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
      if (pathExists(npmCli)) return { command: process.execPath, args: [npmCli] };
    }
  }

  const parts = splitCommandLine(configured === "auto" ? "codex" : configured || "codex");
  return { command: parts[0] || "codex", args: parts.slice(1) };
}

export const __testInternals = { resolveCodexCommand, splitCommandLine };

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(child, getLog) {
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`app-server exited early with code ${child.exitCode}: ${getLog().slice(0, 1200)}`);
    }

    if (getLog().includes("listening on")) return;
    await sleep(100);
  }

  throw new Error(`app-server did not start: ${getLog().slice(0, 1200)}`);
}

class RpcClient {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (event) => this.onMessage(event.data);
    this.ws.onerror = () => {
      for (const pending of this.pending.values()) pending.reject(new Error(`${this.name} websocket error`));
      this.pending.clear();
    };

    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      setTimeout(() => reject(new Error(`${this.name} open timeout`)), 10000);
    });

    await this.request("initialize", {
      clientInfo: { name: `vibelink-${this.name}`, version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] }
    });
    this.notify("initialized", {});
  }

  onMessage(raw) {
    const message = JSON.parse(raw);
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;

      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    this.notifications.push(message);
  }

  request(method, params) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${this.name} request timeout: ${method}`));
      }, 150000);
    });
  }

  notify(method, params) {
    this.ws.send(JSON.stringify({ method, params }));
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Ignore cleanup errors from short-lived probe sockets.
    }
  }
}

function textFromNotification(notification) {
  const params = notification.params || {};
  const item = params.item || params;

  if (typeof params.delta === "string") return params.delta;
  if (typeof item.text === "string") return item.text;
  if (Array.isArray(item.content)) return item.content.map((part) => part.text || "").filter(Boolean).join("");
  return "";
}

function isThreadNotification(notification, threadId) {
  const params = notification.params || {};
  return !params || params.threadId === threadId || params.thread?.id === threadId;
}

function threadNotifications(client, threadId, sinceIndex = 0) {
  return client.notifications.slice(sinceIndex).filter((notification) => isThreadNotification(notification, threadId));
}

function summarizeNotifications(notifications) {
  const counts = {};
  for (const notification of notifications) {
    counts[notification.method] = (counts[notification.method] || 0) + 1;
  }

  const textSample = notifications
    .filter((notification) => notification.method === "item/agentMessage/delta" || notification.params?.item?.type === "agentMessage")
    .map(textFromNotification)
    .filter(Boolean)
    .join("")
    .slice(0, 800);

  return { count: notifications.length, counts, textSample };
}

async function waitForTurnComplete(client, threadId, sinceIndex) {
  const deadline = Date.now() + 150000;

  while (Date.now() < deadline) {
    if (threadNotifications(client, threadId, sinceIndex).some((notification) => notification.method === "turn/completed")) {
      return true;
    }

    await sleep(250);
  }

  return false;
}

let runningProbe = null;

export async function runCodexAppServerProbe(settings) {
  if (runningProbe) return runningProbe;

  runningProbe = runProbe(settings).finally(() => {
    runningProbe = null;
  });

  return runningProbe;
}

async function runProbe(settings) {
  const startedAt = nowIso();
  const cwd = resolveProbeCwd(settings);
  const { command, args } = resolveCodexCommand(settings);
  const port = await getFreePort();
  const url = `ws://127.0.0.1:${port}`;
  const result = {
    ok: false,
    startedAt,
    url,
    codexCommand: command,
    cwd,
    steps: []
  };

  if (typeof WebSocket !== "function") {
    result.error = "Node.js WebSocket runtime is unavailable.";
    return result;
  }

  let child = null;
  let clientA = null;
  let clientB = null;
  let serverLog = "";

  try {
    result.steps.push("Starting codex app-server.");
    child = spawn(command, [...args, "app-server", "--listen", url], {
      cwd,
      env: {
        ...process.env,
        ...(settings.apiKeys?.openai ? { OPENAI_API_KEY: settings.apiKeys.openai } : {})
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    child.stdout.on("data", (data) => {
      serverLog += data.toString();
    });
    child.stderr.on("data", (data) => {
      serverLog += data.toString();
    });

    await waitForServer(child, () => serverLog);

    result.steps.push("Connecting two WebSocket clients.");
    clientA = new RpcClient("A", url);
    clientB = new RpcClient("B", url);
    await Promise.all([clientA.connect(), clientB.connect()]);

    result.steps.push("Client A starts a thread and completes the first turn.");
    const threadResponse = await clientA.request("thread/start", {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      threadSource: "appServer",
      ephemeral: false
    });

    const threadId = threadResponse.thread.id;
    result.threadId = threadId;
    result.threadPath = threadResponse.thread.path;
    result.threadSource = threadResponse.thread.threadSource;

    const firstTurnStart = clientA.notifications.length;
    await clientA.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply exactly MOBILE_APP_SERVER_FIRST_OK. Do not use tools.", text_elements: [] }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      cwd,
      runtimeWorkspaceRoots: [cwd]
    });
    result.firstTurnCompleted = await waitForTurnComplete(clientA, threadId, firstTurnStart);
    result.firstTurn = summarizeNotifications(threadNotifications(clientA, threadId, firstTurnStart));

    result.steps.push("Client B resumes the existing rollout.");
    const resumeResponse = await clientB.request("thread/resume", {
      threadId,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      excludeTurns: false
    });
    result.resumeTurnCount = resumeResponse.thread?.turns?.length || 0;

    result.steps.push("Client A starts a second turn; Client B listens live.");
    const secondTurnAStart = clientA.notifications.length;
    const secondTurnBStart = clientB.notifications.length;
    await clientA.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply exactly MOBILE_APP_SERVER_LIVE_OK. Do not use tools.", text_elements: [] }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      cwd,
      runtimeWorkspaceRoots: [cwd]
    });

    result.secondTurnCompletedOnA = await waitForTurnComplete(clientA, threadId, secondTurnAStart);
    result.secondTurnCompletedOnB = await waitForTurnComplete(clientB, threadId, secondTurnBStart);
    result.secondTurnA = summarizeNotifications(threadNotifications(clientA, threadId, secondTurnAStart));
    result.secondTurnB = summarizeNotifications(threadNotifications(clientB, threadId, secondTurnBStart));
    result.bSawTurnStarted = Boolean(result.secondTurnB.counts["turn/started"]);
    result.bSawAgentDelta = Boolean(result.secondTurnB.counts["item/agentMessage/delta"]);
    result.bSawTurnCompleted = Boolean(result.secondTurnB.counts["turn/completed"]);
    result.bTextIncludesExpected = result.secondTurnB.textSample.includes("MOBILE_APP_SERVER_LIVE_OK");
    result.ok =
      result.firstTurnCompleted &&
      result.secondTurnCompletedOnA &&
      result.secondTurnCompletedOnB &&
      result.bSawTurnStarted &&
      result.bSawAgentDelta &&
      result.bSawTurnCompleted &&
      result.bTextIncludesExpected;
  } catch (error) {
    result.error = error.stack || error.message;
  } finally {
    result.finishedAt = nowIso();
    result.serverLogHead = serverLog.slice(0, 1600);
    clientA?.close();
    clientB?.close();
    child?.kill();

    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "app-server-minimal-probe.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    } catch {
      // Probe persistence is best effort.
    }
  }

  return result;
}
