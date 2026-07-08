import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SAFE_COMMANDS = new Set(["doctor", "ask", "configure"]);
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

export const DEFAULT_DOUBAO_URL = "https://www.doubao.com/chat/";
export const DEFAULT_DOUBAO_CDP_ENDPOINT = "http://127.0.0.1:9222";

export function doubaoCliPath() {
  return path.join(ROOT, "tools", "doubao-cli.mjs");
}

export function doubaoBridgeCliPath() {
  return path.join(ROOT, "packages", "doubao-cli", "src", "bin", "doubao.mjs");
}

export function preferredDoubaoCliPath() {
  const bridge = doubaoBridgeCliPath();
  return fs.existsSync(bridge) ? bridge : doubaoCliPath();
}

function pushOptionalArg(args, flag, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, String(value));
}

function boundedTimeout(timeoutMs) {
  const value = Number(timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(value, MAX_TIMEOUT_MS);
}

export function doubaoCommandForAction(action = "", input = {}) {
  const value = String(action || "").trim();
  if (!SAFE_COMMANDS.has(value)) {
    throw new Error("Unsupported Doubao action: " + (value || "<empty>") + ".");
  }

  const args = [preferredDoubaoCliPath(), value, "--json"];
  if (value === "doctor") {
    pushOptionalArg(args, "--endpoint", input.endpoint);
    pushOptionalArg(args, "--url", input.url);
    return args;
  }

  if (value === "configure") {
    if (input.noDaemon) args.push("--no-daemon");
    if (input.noOpen) args.push("--no-open");
    pushOptionalArg(args, "--port", input.port);
    pushOptionalArg(args, "--url", input.url);
    pushOptionalArg(args, "--timeout-ms", input.timeoutMs);
    return args;
  }

  if (!input.prompt) throw new Error("Doubao ask requires a prompt.");
  args.push("--prompt", String(input.prompt));
  pushOptionalArg(args, "--endpoint", input.endpoint);
  pushOptionalArg(args, "--url", input.url);
  pushOptionalArg(args, "--timeout-ms", input.timeoutMs);
  return args;
}

export function doubaoAgentArgs(payload = {}, settings = {}) {
  const args = doubaoCommandForAction("ask", {
    prompt: payload.prompt || "",
    endpoint: settings.doubaoCdpEndpoint || process.env.DOUBAO_CDP_ENDPOINT || DEFAULT_DOUBAO_CDP_ENDPOINT,
    url: settings.doubaoUrl || process.env.DOUBAO_WEB_URL || DEFAULT_DOUBAO_URL,
    timeoutMs: payload.timeoutMs
  });
  return args.slice(1);
}

export function runDoubaoCommand(action, input = {}, options = {}) {
  const args = doubaoCommandForAction(action, input);
  const timeoutMs = boundedTimeout(options.timeoutMs ?? input.timeoutMs);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        DOUBAO_CDP_ENDPOINT: input.endpoint || process.env.DOUBAO_CDP_ENDPOINT || DEFAULT_DOUBAO_CDP_ENDPOINT,
        DOUBAO_WEB_URL: input.url || process.env.DOUBAO_WEB_URL || DEFAULT_DOUBAO_URL
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      resolve({ ok: false, action, args, stdout, stderr: stderr || "Timed out.", exitCode: -1, timedOut: true, elapsedMs: Date.now() - startedAt });
    }, timeoutMs);

    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, action, args, stdout, stderr: error.message, exitCode: -1, timedOut: false, elapsedMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, action, args, stdout, stderr, exitCode: code ?? 0, timedOut: false, elapsedMs: Date.now() - startedAt });
    });
  });
}

export async function getDoubaoStatus(input = {}) {
  const doctor = await runDoubaoCommand("doctor", input, { timeoutMs: input.timeoutMs || 10000 });
  let status = null;
  if (doctor.stdout) {
    try {
      status = JSON.parse(doctor.stdout.trim().split(/\r?\n/).at(-1));
    } catch {
      status = null;
    }
  }
  return {
    ok: doctor.ok && Boolean(status?.ok),
    endpoint: input.endpoint || process.env.DOUBAO_CDP_ENDPOINT || DEFAULT_DOUBAO_CDP_ENDPOINT,
    url: input.url || process.env.DOUBAO_WEB_URL || DEFAULT_DOUBAO_URL,
    status,
    doctor
  };
}
