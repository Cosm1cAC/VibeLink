import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { withAgentReachPath } from "./agentReachRuntime.js";

const require = createRequire(import.meta.url);
const sessions = new Map();

function packageAvailable(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function commandAvailableOnPath(command) {
  const runtimeEnv = withAgentReachPath(process.env);
  const pathValue = runtimeEnv.PATH || runtimeEnv.Path || "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const target = path.join(dir, process.platform === "win32" && ext && !command.toLowerCase().endsWith(ext.toLowerCase()) ? `${command}${ext}` : command);
      try {
        if (fs.existsSync(target)) return true;
      } catch {
        // Ignore unreadable PATH entries.
      }
    }
  }
  return false;
}

function defaultShell() {
  if (process.platform === "win32") {
    if (commandAvailableOnPath("powershell.exe")) return { command: "powershell.exe", args: ["-NoLogo"] };
    return { command: "cmd.exe", args: [] };
  }
  return { command: process.env.SHELL || (commandAvailableOnPath("bash") ? "bash" : "sh"), args: [] };
}

async function loadNodePty() {
  if (!packageAvailable("node-pty")) return null;
  try {
    return await import("node-pty");
  } catch {
    return null;
  }
}

function normalizeSize(cols, rows) {
  return {
    cols: Math.min(240, Math.max(20, Number(cols || 100))),
    rows: Math.min(80, Math.max(8, Number(rows || 30)))
  };
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    mode: session.mode,
    shell: session.shell,
    cwd: session.cwd,
    pid: session.pid || 0,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt || "",
    exitCode: session.exitCode ?? null,
    signal: session.signal || "",
    supportsStdin: true,
    supportsResize: session.mode === "pty",
    supportsAnsi: session.mode === "pty"
  };
}

export async function startTerminalSession({ id = "", cwd = process.cwd(), shell = "", args = [], cols = 100, rows = 30, env = {}, mode = "auto", onOutput = null, onExit = null } = {}) {
  const sessionId = id || crypto.randomUUID();
  const size = normalizeSize(cols, rows);
  const shellSpec = shell ? { command: shell, args: Array.isArray(args) ? args : [] } : defaultShell();
  const ptyModule = mode !== "spawn" ? await loadNodePty() : null;
  if (mode === "pty" && !ptyModule) {
    throw new Error("PTY mode requested, but node-pty is not installed or could not be loaded.");
  }
  const usePty = Boolean(ptyModule && mode !== "spawn");
  const current = {
    id: sessionId,
    mode: usePty ? "pty" : "spawn",
    shell: shellSpec.command,
    cwd,
    status: "running",
    startedAt: new Date().toISOString(),
    process: null,
    pid: 0,
    exitCode: null,
    signal: ""
  };

  const finish = (exitCode = 0, signal = "") => {
    if (current.status !== "running") return;
    current.status = exitCode === 0 ? "exited" : "failed";
    current.exitCode = exitCode;
    current.signal = signal || "";
    current.endedAt = new Date().toISOString();
    sessions.delete(sessionId);
    onExit?.(publicSession(current));
  };

  if (usePty) {
    const term = ptyModule.spawn(shellSpec.command, shellSpec.args || [], {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd,
      env: withAgentReachPath({ ...process.env, TERM: "xterm-256color", ...env })
    });
    current.process = term;
    current.pid = term.pid || 0;
    term.onData((text) => onOutput?.({ stream: "stdout", text, mode: "pty", sessionId }));
    term.onExit((event) => finish(event.exitCode ?? 0, String(event.signal || "")));
  } else {
    const child = spawn(shellSpec.command, shellSpec.args || [], {
      cwd,
      env: withAgentReachPath({ ...process.env, ...env }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    current.process = child;
    current.pid = child.pid || 0;
    child.stdout?.on("data", (data) => onOutput?.({ stream: "stdout", text: data.toString(), mode: "spawn", sessionId }));
    child.stderr?.on("data", (data) => onOutput?.({ stream: "stderr", text: data.toString(), mode: "spawn", sessionId }));
    child.on("error", (error) => {
      onOutput?.({ stream: "stderr", text: error.message, mode: "spawn", sessionId });
      finish(1, "error");
    });
    child.on("close", (code, signal) => finish(code ?? 0, signal || ""));
  }

  sessions.set(sessionId, current);
  return publicSession(current);
}

export function getTerminalSession(id) {
  return publicSession(sessions.get(id));
}

export function listTerminalSessions() {
  return [...sessions.values()].map(publicSession);
}

export function writeTerminalSession(id, text = "") {
  const session = sessions.get(id);
  if (!session || session.status !== "running") return { ok: false, error: "Terminal session is not running." };
  try {
    if (session.mode === "pty") session.process.write(String(text || ""));
    else session.process.stdin?.write(String(text || ""));
    return { ok: true, session: publicSession(session) };
  } catch (error) {
    return { ok: false, error: error.message, session: publicSession(session) };
  }
}

export function resizeTerminalSession(id, cols, rows) {
  const session = sessions.get(id);
  if (!session || session.status !== "running") return { ok: false, error: "Terminal session is not running." };
  if (session.mode !== "pty") return { ok: false, error: "Resize requires a PTY backend.", session: publicSession(session) };
  try {
    const size = normalizeSize(cols, rows);
    session.process.resize(size.cols, size.rows);
    return { ok: true, session: publicSession(session), cols: size.cols, rows: size.rows };
  } catch (error) {
    return { ok: false, error: error.message, session: publicSession(session) };
  }
}

export function stopTerminalSession(id, reason = "Stopped by user.") {
  const session = sessions.get(id);
  if (!session || session.status !== "running") return { ok: false, error: "Terminal session is not running." };
  try {
    if (session.mode === "pty") session.process.kill();
    else session.process.kill();
    session.stopRequested = true;
    return { ok: true, reason, session: publicSession(session) };
  } catch (error) {
    return { ok: false, error: error.message, session: publicSession(session) };
  }
}

export function terminalCapabilityReport() {
  const hasNodePty = packageAvailable("node-pty");
  const shellSpec = defaultShell();
  const shell = shellSpec.command;
  return {
    mode: hasNodePty ? "pty-available" : "spawn-fallback",
    ptyBackend: hasNodePty ? "node-pty" : "",
    ptyAvailable: hasNodePty,
    fallbackAvailable: Boolean(shell),
    shell,
    activeSessions: sessions.size,
    supportsStdin: true,
    supportsAnsi: hasNodePty,
    supportsResize: hasNodePty,
    supportsStop: true,
    outputCursor: true,
    reason: hasNodePty
      ? "node-pty is installed; interactive terminal sessions can use the PTY backend with stdin, ANSI, resize, stop, and replay."
      : "node-pty is not installed; interactive terminal sessions use pipe-based spawn fallback with stdin, streamed output, stop, timeout, and replay, but no TTY resize or PTY ANSI semantics."
  };
}
