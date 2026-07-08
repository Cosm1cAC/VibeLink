import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function homeDir(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function appDataDir(env = process.env) {
  return env.APPDATA || path.join(homeDir(env), "AppData", "Roaming");
}

function pathKey(env = process.env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
}

function existingDirs(items = []) {
  return items.filter((item) => {
    try {
      return item && fs.existsSync(item) && fs.statSync(item).isDirectory();
    } catch {
      return false;
    }
  });
}

export function agentReachPathEntries(env = process.env) {
  const home = homeDir(env);
  const candidates = process.platform === "win32"
    ? [
        path.join(home, ".agent-reach-venv", "Scripts"),
        path.join(home, ".local", "bin"),
        path.join(home, ".agent-reach", "tools", "ffmpeg"),
        path.join(appDataDir(env), "npm")
      ]
    : [
        path.join(home, ".agent-reach-venv", "bin"),
        path.join(home, ".local", "bin"),
        path.join(home, ".agent-reach", "tools", "ffmpeg")
      ];
  return existingDirs(candidates);
}

export function withAgentReachPath(env = process.env) {
  const key = pathKey(env);
  const currentPath = env[key] || env.PATH || "";
  const parts = String(currentPath || "").split(path.delimiter).filter(Boolean);
  const seen = new Set(parts.map((part) => path.resolve(part).toLowerCase()));
  const prefix = [];

  for (const entry of agentReachPathEntries(env)) {
    const normalized = path.resolve(entry).toLowerCase();
    if (seen.has(normalized)) continue;
    prefix.push(entry);
    seen.add(normalized);
  }

  const mergedPath = [...prefix, ...parts].join(path.delimiter);
  return {
    ...env,
    [key]: mergedPath,
    PATH: mergedPath,
    PYTHONIOENCODING: env.PYTHONIOENCODING || "utf-8",
    PYTHONUTF8: env.PYTHONUTF8 || "1"
  };
}

export function agentReachInstallInfo(env = process.env) {
  return {
    pathEntries: agentReachPathEntries(env),
    venvScripts: process.platform === "win32"
      ? path.join(homeDir(env), ".agent-reach-venv", "Scripts")
      : path.join(homeDir(env), ".agent-reach-venv", "bin"),
    npmBin: process.platform === "win32" ? path.join(appDataDir(env), "npm") : ""
  };
}

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const SAFE_COMMANDS = new Set(["version", "doctor", "check-update", "watch", "skill", "format", "transcribe"]);

function boundedTimeout(timeoutMs) {
  const value = Number(timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(value, MAX_TIMEOUT_MS);
}

function normalizeArgs(args = []) {
  if (!Array.isArray(args)) return [];
  return args.map((arg) => String(arg));
}

export function agentReachCommandForAction(action = "", input = {}) {
  const value = String(action || "").trim();
  if (!SAFE_COMMANDS.has(value)) {
    throw new Error("Unsupported Agent Reach action: " + (value || "<empty>") + ".");
  }

  if (value === "doctor") return ["doctor", "--json"];
  if (value === "skill") {
    const operation = input.operation === "uninstall" ? "--uninstall" : "--install";
    return ["skill", operation];
  }
  if (value === "format") {
    const platform = input.platform || "xhs";
    if (platform !== "xhs") throw new Error("Agent Reach format currently supports platform=xhs only.");
    return ["format", platform];
  }
  if (value === "transcribe") {
    if (!input.source) throw new Error("Agent Reach transcribe requires a source.");
    const args = ["transcribe", String(input.source)];
    if (input.provider) args.push("--provider", String(input.provider));
    return args;
  }
  return [value, ...normalizeArgs(input.args)];
}

function stdinForAction(_action, input = {}) {
  if (typeof input.stdin === "string") return input.stdin;
  if (typeof input.input === "string") return input.input;
  if (input.input !== undefined) return JSON.stringify(input.input);
  return "";
}

export function runAgentReachCommand(action, input = {}, options = {}) {
  const args = agentReachCommandForAction(action, input);
  const timeoutMs = boundedTimeout(options.timeoutMs ?? input.timeoutMs);
  const stdin = stdinForAction(action, input);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("agent-reach", args, {
      env: withAgentReachPath(process.env),
      windowsHide: true,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"]
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

    if (stdin && child.stdin?.writable) child.stdin.end(stdin);
  });
}

export async function getAgentReachStatus(options = {}) {
  const version = await runAgentReachCommand("version", {}, { timeoutMs: options.versionTimeoutMs || 10000 });
  const doctor = await runAgentReachCommand("doctor", {}, { timeoutMs: options.timeoutMs || 60000 });
  let channels = null;
  if (doctor.ok && doctor.stdout) {
    try {
      channels = JSON.parse(doctor.stdout);
    } catch {
      channels = null;
    }
  }
  return {
    ok: version.ok && doctor.ok,
    version: version.stdout.trim() || version.stderr.trim(),
    install: agentReachInstallInfo(),
    channels,
    doctor
  };
}
