import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { withAgentReachPath } from "./agentReachRuntime.js";
import { getExecutionHostFacade } from "./executionHostClient.js";

const require = createRequire(import.meta.url);
const sessions = new Map();
let recoveryHandlers = {};

export function configureTerminalSessionRecovery(handlers = {}) {
  recoveryHandlers = handlers && typeof handlers === "object" ? handlers : {};
}

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
    if (commandAvailableOnPath("powershell.exe")) {
      return {
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoExit",
          "-Command",
          "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [Console]::OutputEncoding"
        ]
      };
    }
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

async function startLegacyTerminalSession({ id = "", cwd = process.cwd(), shell = "", args = [], cols = 100, rows = 30, env = {}, mode = "auto", onOutput = null, onExit = null } = {}) {
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

function getLegacyTerminalSession(id) {
  return publicSession(sessions.get(id));
}

function listLegacyTerminalSessions() {
  return [...sessions.values()].map(publicSession);
}

function writeLegacyTerminalSession(id, text = "") {
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

function resizeLegacyTerminalSession(id, cols, rows) {
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

function stopLegacyTerminalSession(id, reason = "Stopped by user.") {
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

const HOST_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "lost", "outcome_unknown"]);

function hostFacade(override = null) {
  const facade = override || getExecutionHostFacade();
  return typeof facade?.startTerminal === "function" ? facade : null;
}

function hostPublicSession(snapshot, metadata = {}) {
  if (!snapshot) return null;
  const backend = snapshot.capabilities?.backend || metadata.backend || "conpty";
  const terminal = HOST_TERMINAL_STATUSES.has(snapshot.status);
  return {
    id: snapshot.executionId,
    mode: backend === "stdio" ? "spawn" : "pty",
    shell: metadata.shell || "",
    cwd: metadata.cwd || "",
    pid: snapshot.processPid || 0,
    status: snapshot.status === "completed" ? "exited" : snapshot.status === "cancelled" ? "failed" : snapshot.status,
    startedAt: snapshot.startedAt || metadata.startedAt || "",
    endedAt: terminal ? snapshot.endedAt || "" : "",
    exitCode: snapshot.exitCode ?? null,
    signal: snapshot.signal || "",
    supportsStdin: snapshot.capabilities?.input !== false,
    supportsResize: Boolean(snapshot.capabilities?.resize),
    supportsAnsi: backend !== "stdio"
  };
}

function startHostMonitor(current) {
  if (current.monitoring) return;
  current.monitoring = true;
  void (async () => {
    try {
      while (sessions.get(current.id) === current) {
        const page = await current.facade.terminalEvents(current.id, current.afterHostSeq, 128);
        const events = Array.isArray(page?.events) ? page.events : [];
        let processedHostSeq = current.afterHostSeq;
        let exitEvent = null;
        for (const event of events) {
          if (["stream.stdout", "stream.stderr", "stream.pty"].includes(event.type)) {
            const stream = event.type === "stream.stderr" ? "stderr" : "stdout";
            const payload = event.payload || {};
            const bytes = payload.encoding === "base64"
              ? Buffer.from(String(payload.data || ""), "base64")
              : Buffer.from(String(payload.text ?? payload.data ?? ""), "utf8");
            const text = current.decoders[stream].write(bytes);
            if (text) current.onOutput?.({ stream, text, mode: current.metadata.mode, sessionId: current.id, eventId: event.eventId, hostSeq: event.hostSeq });
          } else if (event.type === "execution.exited") {
            exitEvent = event;
          }
          processedHostSeq = Math.max(processedHostSeq, Number(event.hostSeq || 0));
        }
        const snapshot = await current.facade.getTerminal(current.id);
        current.snapshot = snapshot;
        const terminal = Boolean(exitEvent || HOST_TERMINAL_STATUSES.has(snapshot.status));
        if (terminal) {
          const stdout = current.decoders.stdout.end();
          const stderr = current.decoders.stderr.end();
          if (stdout) current.onOutput?.({ stream: "stdout", text: stdout, mode: current.metadata.mode, sessionId: current.id, eventId: `${exitEvent?.eventId || current.id}:stdout-tail` });
          if (stderr) current.onOutput?.({ stream: "stderr", text: stderr, mode: current.metadata.mode, sessionId: current.id, eventId: `${exitEvent?.eventId || current.id}:stderr-tail` });
          current.onExit?.(hostPublicSession(snapshot, current.metadata), exitEvent);
        }
        if (processedHostSeq > current.ackedHostSeq) {
          await current.facade.acknowledgeTerminalEvents(current.id, processedHostSeq);
          current.ackedHostSeq = processedHostSeq;
          current.afterHostSeq = processedHostSeq;
        }
        if (terminal) {
          sessions.delete(current.id);
          return;
        }
        if (!events.length) await new Promise((resolve) => {
          const timer = setTimeout(resolve, 25);
          timer.unref?.();
        });
      }
    } catch (error) {
      current.monitoring = false;
      current.lastError = error;
      current.afterHostSeq = current.ackedHostSeq;
      current.decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      if (sessions.get(current.id) === current) {
        const timer = setTimeout(() => startHostMonitor(current), 100);
        timer.unref?.();
      }
    }
  })();
}

function rememberHostSession(facade, snapshot, metadata = {}, onOutput = null, onExit = null) {
  const id = snapshot.executionId;
  const recoveredMetadata = recoveryHandlers.metadata?.(id) || {};
  const resolvedMetadata = { ...recoveredMetadata, ...metadata };
  const resolvedOutput = onOutput || (recoveryHandlers.onOutput
    ? (chunk) => recoveryHandlers.onOutput(id, chunk)
    : null);
  const resolvedExit = onExit || (recoveryHandlers.onExit
    ? (session, event) => recoveryHandlers.onExit(id, session, event)
    : null);
  const existing = sessions.get(id);
  if (existing?.host) {
    existing.snapshot = snapshot;
    existing.metadata = { ...existing.metadata, ...resolvedMetadata };
    existing.onOutput = resolvedOutput || existing.onOutput;
    existing.onExit = resolvedExit || existing.onExit;
    startHostMonitor(existing);
    return existing;
  }
  const current = {
    id,
    host: true,
    facade,
    snapshot,
    metadata: resolvedMetadata,
    onOutput: resolvedOutput,
    onExit: resolvedExit,
    afterHostSeq: Number(snapshot.lastAckedHostSeq || 0),
    ackedHostSeq: Number(snapshot.lastAckedHostSeq || 0),
    decoders: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") },
    monitoring: false
  };
  sessions.set(id, current);
  startHostMonitor(current);
  return current;
}

export async function startTerminalSession(options = {}) {
  const facade = hostFacade(options.executionHost);
  if (!facade) return startLegacyTerminalSession(options);
  const sessionId = options.id || crypto.randomUUID();
  const size = normalizeSize(options.cols, options.rows);
  const shellSpec = options.shell
    ? { command: options.shell, args: Array.isArray(options.args) ? options.args : [] }
    : defaultShell();
  const requestedMode = options.mode || "auto";
  const snapshot = await facade.startTerminal({
    executionId: sessionId,
    shell: shellSpec.command,
    args: shellSpec.args || [],
    cwd: options.cwd || process.cwd(),
    env: withAgentReachPath({ ...process.env, TERM: "xterm-256color", ...(options.env || {}) }),
    cols: size.cols,
    rows: size.rows,
    mode: requestedMode
  });
  const backend = requestedMode === "spawn" ? "stdio" : "conpty";
  const metadata = {
    shell: shellSpec.command,
    cwd: options.cwd || process.cwd(),
    mode: backend === "stdio" ? "spawn" : "pty",
    backend,
    startedAt: snapshot.startedAt || new Date().toISOString()
  };
  rememberHostSession(facade, snapshot, metadata, options.onOutput, options.onExit);
  return hostPublicSession(snapshot, metadata);
}

export async function getTerminalSession(id) {
  const current = sessions.get(id);
  if (current && !current.host) return getLegacyTerminalSession(id);
  const facade = current?.facade || hostFacade();
  if (!facade) return getLegacyTerminalSession(id);
  try {
    const snapshot = await facade.getTerminal(id);
    if (snapshot.kind !== "terminal" || HOST_TERMINAL_STATUSES.has(snapshot.status)) return null;
    const attached = rememberHostSession(facade, snapshot, current?.metadata || {});
    return hostPublicSession(snapshot, attached.metadata);
  } catch (error) {
    if (error.code === "EXECUTION_NOT_FOUND") return null;
    throw error;
  }
}

export async function listTerminalSessions() {
  const facade = hostFacade();
  if (!facade) return listLegacyTerminalSessions();
  const snapshots = await facade.listTerminals();
  return snapshots
    .filter((snapshot) => !HOST_TERMINAL_STATUSES.has(snapshot.status))
    .map((snapshot) => {
      const current = rememberHostSession(facade, snapshot, sessions.get(snapshot.executionId)?.metadata || {});
      return hostPublicSession(snapshot, current.metadata);
    });
}

export async function writeTerminalSession(id, text = "") {
  const current = sessions.get(id);
  if (current && !current.host) return writeLegacyTerminalSession(id, text);
  const facade = current?.facade || hostFacade();
  if (!facade) return writeLegacyTerminalSession(id, text);
  const session = await getTerminalSession(id);
  if (!session) return { ok: false, error: "Terminal session is not running." };
  try {
    await facade.inputTerminal(id, text);
    return { ok: true, session };
  } catch (error) {
    return { ok: false, error: error.message, session };
  }
}

export async function resizeTerminalSession(id, cols, rows) {
  const current = sessions.get(id);
  if (current && !current.host) return resizeLegacyTerminalSession(id, cols, rows);
  const facade = current?.facade || hostFacade();
  if (!facade) return resizeLegacyTerminalSession(id, cols, rows);
  const session = await getTerminalSession(id);
  if (!session) return { ok: false, error: "Terminal session is not running." };
  if (!session.supportsResize) return { ok: false, error: "Resize requires a PTY backend.", session };
  const size = normalizeSize(cols, rows);
  try {
    await facade.resizeTerminal(id, size.cols, size.rows);
    return { ok: true, session, ...size };
  } catch (error) {
    return { ok: false, error: error.message, session };
  }
}

export async function stopTerminalSession(id, reason = "Stopped by user.") {
  const current = sessions.get(id);
  if (current && !current.host) return stopLegacyTerminalSession(id, reason);
  const facade = current?.facade || hostFacade();
  if (!facade) return stopLegacyTerminalSession(id, reason);
  const session = await getTerminalSession(id);
  if (!session) return { ok: false, error: "Terminal session is not running." };
  try {
    await facade.signalTerminal(id, "stop", reason);
    return { ok: true, reason, session };
  } catch (error) {
    return { ok: false, error: error.message, session };
  }
}

export function terminalCapabilityReport() {
  const facade = hostFacade();
  if (facade) {
    return {
      mode: "execution-host",
      ptyBackend: "conpty",
      ptyAvailable: true,
      fallbackAvailable: true,
      shell: defaultShell().command,
      activeSessions: [...sessions.values()].filter((session) => session.host).length,
      supportsStdin: true,
      supportsAnsi: true,
      supportsResize: true,
      supportsStop: true,
      outputCursor: true,
      reason: "Terminal sessions are owned by the durable execution host with ConPTY control and spool replay."
    };
  }
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
