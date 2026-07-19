import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { dataDir } from "./config.js";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "lost", "outcome_unknown"]);

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function protocolError(payload = {}) {
  const error = new Error(payload.message || "Execution host request failed.");
  error.code = payload.code || "EXECUTION_HOST_ERROR";
  error.retryable = Boolean(payload.retryable);
  error.details = payload.details || {};
  return error;
}

function connectionError(error) {
  return ["ENOENT", "ECONNREFUSED", "EPIPE", "ECONNRESET"].includes(error?.code);
}

export function executionHostPipeName(directory = dataDir) {
  const normalized = path.resolve(directory).toLowerCase();
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\vibelink-execd-v1-${digest}`;
}

export function resolveExecutionHostCommand(environment = process.env, probe = spawnSync) {
  const explicit = String(environment.VIBELINK_EXECUTION_HOST_COMMAND || "").trim();
  if (explicit) return explicit;
  const candidate = String(environment.VIBELINK_RUST_BIN || "").trim();
  if (!candidate) return "";
  try {
    const result = probe(candidate, ["--help"], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const help = `${result?.stdout || ""}\n${result?.stderr || ""}`;
    return /^\s*execd\b/im.test(help) ? candidate : "";
  } catch {
    return "";
  }
}

export function createExecutionHostClient({
  pipeName = process.env.VIBELINK_EXECUTION_HOST_PIPE || executionHostPipeName(dataDir),
  command = resolveExecutionHostCommand(),
  hostDataDir = dataDir,
  requestTimeoutMs = 5000,
  startupTimeoutMs = 15000,
  connect = (name, onConnect) => net.createConnection(name, onConnect),
  spawnProcess = spawn
} = {}) {
  let ready = false;
  let starting = null;

  function requestOnce(method, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
    const requestId = crypto.randomUUID();
    const payload = Buffer.from(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      method,
      params
    }), "utf8");
    if (payload.length > MAX_FRAME_BYTES) {
      return Promise.reject(protocolError({ code: "MESSAGE_TOO_LARGE", message: "Execution host request exceeds the protocol boundary." }));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let buffered = Buffer.alloc(0);
      let expectedLength = null;
      const socket = connect(pipeName, () => {
        const frame = Buffer.allocUnsafe(4 + payload.length);
        frame.writeUInt32LE(payload.length, 0);
        payload.copy(frame, 4);
        socket.write(frame);
      });
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        const error = new Error(`Execution host request timed out: ${method}`);
        error.code = "EXECUTION_HOST_TIMEOUT";
        finish(error);
      }, Math.max(1, Number(timeoutMs) || requestTimeoutMs));
      timer.unref?.();

      socket.on("data", (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (expectedLength === null && buffered.length >= 4) {
          expectedLength = buffered.readUInt32LE(0);
          buffered = buffered.subarray(4);
          if (expectedLength < 1 || expectedLength > MAX_FRAME_BYTES) {
            finish(protocolError({ code: "MESSAGE_TOO_LARGE", message: "Execution host response exceeds the protocol boundary." }));
            return;
          }
        }
        if (expectedLength === null || buffered.length < expectedLength) return;
        let response;
        try {
          response = JSON.parse(buffered.subarray(0, expectedLength).toString("utf8"));
        } catch (error) {
          error.message = `Execution host returned invalid JSON: ${error.message}`;
          finish(error);
          return;
        }
        if (response.protocolVersion !== PROTOCOL_VERSION || response.requestId !== requestId) {
          finish(protocolError({ code: "MESSAGE_INVALID", message: "Execution host response identity is invalid." }));
        } else if (response.error) {
          finish(protocolError(response.error));
        } else {
          finish(null, response.result);
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("end", () => {
        if (!settled) finish(new Error(`Execution host closed before replying: ${method}`));
      });
    });
  }

  async function ensureReady() {
    if (ready) return;
    if (starting) return starting;
    starting = (async () => {
      try {
        await requestOnce("host.health", {}, { timeoutMs: Math.min(requestTimeoutMs, 1000) });
        ready = true;
        return;
      } catch (error) {
        if (!connectionError(error) || !command) throw error;
      }

      const child = spawnProcess(command, ["execd", "--data-dir", hostDataDir, "--pipe", pipeName], {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        windowsHide: true,
        stdio: "ignore"
      });
      let spawnError = null;
      child.once?.("error", (error) => {
        spawnError = error;
      });
      child.unref?.();
      const deadline = Date.now() + startupTimeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        try {
          await requestOnce("host.health", {}, { timeoutMs: Math.min(requestTimeoutMs, 1000) });
          ready = true;
          return;
        } catch (error) {
          lastError = error;
          await delay(50);
        }
      }
      const error = new Error(`Execution host did not become ready within ${startupTimeoutMs}ms.${lastError?.message ? ` ${lastError.message}` : ""}`);
      error.code = "EXECUTION_HOST_UNAVAILABLE";
      throw error;
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  async function request(method, params = {}, options = {}) {
    await ensureReady();
    try {
      return await requestOnce(method, params, options);
    } catch (error) {
      if (!connectionError(error)) throw error;
      ready = false;
      await ensureReady();
      return requestOnce(method, params, options);
    }
  }

  return {
    request,
    health: () => request("host.health", {}),
    start: (params) => request("execution.start", params, { timeoutMs: startupTimeoutMs }),
    get: (executionId) => request("execution.get", { executionId }),
    list: (afterExecutionId = "", limit = 500) => request("execution.list", { afterExecutionId, limit }),
    events: (executionId, afterHostSeq = 0, limit = 64) => request("execution.events", { executionId, afterHostSeq, limit }),
    ack: (executionId, hostSeq, operationId) => request("execution.ack", { executionId, hostSeq, operationId }),
    input: (executionId, data, encoding, operationId) => request("execution.input", { executionId, data, encoding, operationId }),
    resize: (executionId, cols, rows, operationId) => request("execution.resize", { executionId, cols, rows, operationId }),
    signal: (executionId, signal, operationId) => request("execution.signal", { executionId, signal, operationId }),
    resolveApproval: (executionId, approvalId, continuationRef, expectedVersion, decision, operationId) => request(
      "approval.resolve",
      { executionId, approvalId, continuationRef, expectedVersion, decision, operationId }
    ),
    pipeName
  };
}

function eventText(event = {}) {
  const payload = event.payload || {};
  if (payload.encoding === "base64") return Buffer.from(String(payload.data || ""), "base64");
  return Buffer.from(String(payload.text ?? payload.data ?? ""), "utf8");
}

function operationId(prefix, executionId, suffix = "") {
  return `${prefix}:${executionId}${suffix ? `:${suffix}` : ""}`.slice(0, 128);
}

export function createExecutionHostFacade({ client, pollIntervalMs = 25, eventLimit = 64 } = {}) {
  if (!client) throw new TypeError("createExecutionHostFacade requires a client.");

  async function runCommand({
    executionId = crypto.randomUUID(),
    shell,
    args = [],
    cwd,
    env = {},
    timeoutMs = 120000,
    signal = null,
    onOutput = null,
    onExecutionStart = null,
    onHostEvent = null,
    onHostAck = null,
    onSnapshot = null
  } = {}) {
    const boundedTimeoutMs = Math.min(Math.max(1, Number(timeoutMs) || 120000), 300000);
    const startedAt = Date.now();
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let stdout = "";
    let stderr = "";
    let afterHostSeq = 0;
    let ackedHostSeq = 0;
    let snapshot = await client.start({
      executionId,
      kind: "command",
      backend: "stdio",
      command: shell,
      args,
      cwd,
      env,
      operationId: operationId("workspace-command-start", executionId)
    });
    await onExecutionStart?.(snapshot);
    let stopReason = "";
    let stopRequestedAt = 0;
    let stopPromise = null;
    let stopError = null;
    const requestStop = (reason) => {
      if (stopPromise || TERMINAL_STATUSES.has(snapshot?.status)) return stopPromise;
      stopReason = reason;
      stopRequestedAt = Date.now();
      stopPromise = client.signal(
        executionId,
        "stop",
        operationId("workspace-command-stop", executionId, reason)
      ).catch((error) => {
        if (error.code !== "EXECUTION_STATE_CONFLICT") stopError = error;
      });
      return stopPromise;
    };
    const abortCommand = () => requestStop("cancelled");
    signal?.addEventListener?.("abort", abortCommand, { once: true });
    if (signal?.aborted) requestStop("cancelled");
    const timeout = setTimeout(() => requestStop("timeout"), boundedTimeoutMs);
    timeout.unref?.();

    let exit = null;
    try {
      while (!exit) {
        const page = await client.events(executionId, afterHostSeq, eventLimit);
        const events = Array.isArray(page?.events) ? page.events : [];
        let acknowledgeThrough = ackedHostSeq;
        for (const event of events) {
          await onHostEvent?.(event);
          afterHostSeq = Math.max(afterHostSeq, Number(event.hostSeq || 0));
          if (event.type === "stream.stdout" || event.type === "stream.stderr") {
            const stream = event.type === "stream.stderr" ? "stderr" : "stdout";
            const text = decoders[stream].write(eventText(event));
            if (stream === "stdout") stdout += text;
            else stderr += text;
            if (text) onOutput?.({ stream, text, elapsedMs: Date.now() - startedAt });
          } else if (event.type === "execution.exited") {
            exit = event.payload || {};
          }
          if (event.type !== "execution.exited") {
            acknowledgeThrough = Math.max(acknowledgeThrough, Number(event.hostSeq || 0));
          }
        }
        if (acknowledgeThrough > ackedHostSeq) {
          await client.ack(executionId, acknowledgeThrough, operationId("workspace-command-ack", executionId, acknowledgeThrough));
          await onHostAck?.(acknowledgeThrough);
          ackedHostSeq = acknowledgeThrough;
        }
        if (exit) break;
        snapshot = await client.get(executionId);
        await onSnapshot?.(snapshot);
        if (TERMINAL_STATUSES.has(snapshot.status)) {
          exit = { exitCode: snapshot.exitCode, signal: snapshot.signal || "" };
          break;
        }
        if (stopRequestedAt && Date.now() - stopRequestedAt > 5000) {
          exit = { exitCode: -1, signal: "stop" };
          break;
        }
        if (!events.length) await delay(pollIntervalMs);
      }
      await stopPromise;
      if (stopError) throw stopError;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abortCommand);
    }

    const trailingStdout = decoders.stdout.end();
    const trailingStderr = decoders.stderr.end();
    stdout += trailingStdout;
    stderr += trailingStderr;
    if (trailingStdout) onOutput?.({ stream: "stdout", text: trailingStdout, elapsedMs: Date.now() - startedAt });
    if (trailingStderr) onOutput?.({ stream: "stderr", text: trailingStderr, elapsedMs: Date.now() - startedAt });
    const cancelled = stopReason === "cancelled";
    const timedOut = stopReason === "timeout";
    if (cancelled && !stderr) stderr = "Command stopped by user.";
    if (timedOut && !stderr) stderr = `Command timed out after ${boundedTimeoutMs}ms.`;
    const exitCode = cancelled || timedOut ? -1 : Number(exit?.exitCode ?? snapshot?.exitCode ?? 1);
    return {
      ok: !cancelled && !timedOut && exitCode === 0,
      stdout,
      stderr,
      exitCode,
      signal: String(exit?.signal || snapshot?.signal || ""),
      ...(cancelled ? { cancelled: true } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      executionId
    };
  }

  async function startTerminal({
    executionId = crypto.randomUUID(),
    shell,
    args = [],
    cwd,
    env = {},
    cols = 100,
    rows = 30,
    mode = "auto"
  } = {}) {
    return client.start({
      executionId,
      kind: "terminal",
      backend: mode === "spawn" ? "stdio" : "conpty",
      command: shell,
      args,
      cwd,
      env,
      cols,
      rows,
      operationId: operationId("terminal-start", executionId)
    });
  }

  function uniqueOperation(prefix, executionId) {
    return operationId(prefix, executionId, crypto.randomUUID());
  }

  return {
    runCommand,
    getExecution: (executionId) => client.get(executionId),
    executionEvents: (executionId, afterHostSeq = 0, limit = eventLimit) => client.events(executionId, afterHostSeq, limit),
    acknowledgeExecutionEvents: (executionId, hostSeq, id = "") => client.ack(
      executionId,
      hostSeq,
      id || operationId("bridge-ack", executionId, hostSeq)
    ),
    startProvider: ({ executionId = crypto.randomUUID(), command, args = [], cwd, env = {} } = {}) => client.start({
      executionId,
      kind: "provider.cli",
      backend: "stdio",
      command,
      args,
      cwd,
      env,
      operationId: operationId("provider-start", executionId)
    }),
    startAppServerProvider: ({
      executionId = crypto.randomUUID(),
      command,
      args = [],
      cwd,
      env = {},
      threadStartParams,
      threadResumeParams,
      turnStartParams,
      connectTimeoutMs = 15000
    } = {}) => client.start({
      executionId,
      kind: "provider.appServer",
      backend: "app_server",
      command,
      args,
      cwd,
      env,
      appServer: { threadStartParams, threadResumeParams, turnStartParams, connectTimeoutMs },
      operationId: operationId("app-server-start", executionId)
    }),
    getProvider: (executionId) => client.get(executionId),
    providerEvents: (executionId, afterHostSeq = 0, limit = eventLimit) => client.events(executionId, afterHostSeq, limit),
    acknowledgeProviderEvents: (executionId, hostSeq) => client.ack(
      executionId,
      hostSeq,
      operationId("provider-ack", executionId, hostSeq)
    ),
    signalProvider: (executionId, signal = "stop", reason = "") => client.signal(
      executionId,
      signal,
      operationId("provider-signal", executionId, crypto.createHash("sha256").update(reason || signal).digest("hex").slice(0, 16))
    ),
    resolveProviderApproval: async ({ executionId, approvalId, continuationRef, expectedVersion, decision, operationId: id, afterHostSeq = 0 }) => {
      const delivered = await client.resolveApproval(
        executionId,
        approvalId,
        continuationRef,
        expectedVersion,
        decision,
        id
      );
      if (!afterHostSeq || typeof client.events !== "function") return delivered;
      const deadline = Date.now() + 10_000;
      let cursor = afterHostSeq;
      while (Date.now() < deadline) {
        const page = await client.events(executionId, cursor, eventLimit);
        const events = Array.isArray(page?.events) ? page.events : [];
        for (const event of events) {
          cursor = Math.max(cursor, Number(event.hostSeq || 0));
          if (event.payload?.continuationRef !== continuationRef) continue;
          if (event.type === "provider.approval.applied") {
            return { ...delivered, applied: true, appliedAt: event.at || new Date().toISOString() };
          }
          if (event.type === "provider.approval.stale") {
            return { ...delivered, stale: true, reason: event.payload?.reason || "Provider turn completed." };
          }
        }
        if (!events.length) await delay(pollIntervalMs);
      }
      return delivered;
    },
    startTerminal,
    getTerminal: (executionId) => client.get(executionId),
    listTerminals: async () => {
      const page = await client.list("", 500);
      return (Array.isArray(page?.executions) ? page.executions : []).filter((item) => item.kind === "terminal");
    },
    terminalEvents: (executionId, afterHostSeq = 0, limit = eventLimit) => client.events(executionId, afterHostSeq, limit),
    acknowledgeTerminalEvents: (executionId, hostSeq) => client.ack(
      executionId,
      hostSeq,
      operationId("terminal-ack", executionId, hostSeq)
    ),
    inputTerminal: (executionId, text) => client.input(
      executionId,
      String(text ?? ""),
      "utf8",
      uniqueOperation("terminal-input", executionId)
    ),
    resizeTerminal: (executionId, cols, rows) => client.resize(
      executionId,
      cols,
      rows,
      operationId("terminal-resize", executionId, `${cols}x${rows}`)
    ),
    signalTerminal: (executionId, signal = "stop", reason = "") => client.signal(
      executionId,
      signal,
      operationId("terminal-signal", executionId, crypto.createHash("sha256").update(reason || signal).digest("hex").slice(0, 16))
    )
  };
}

function createLegacyExecutionFacade() {
  return {
    runCommand({ executionId = crypto.randomUUID(), shell, args, cwd, env, timeoutMs, signal, onOutput }) {
      return new Promise((resolve) => {
        const boundedTimeoutMs = Math.min(Math.max(1, Number(timeoutMs) || 120000), 300000);
        if (signal?.aborted) {
          resolve({ ok: false, stdout: "", stderr: "Command was stopped before it started.", exitCode: -1, cancelled: true, executionId });
          return;
        }
        const child = spawn(shell, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const startedAt = Date.now();
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", abortCommand);
          resolve({ ...result, executionId });
        };
        const emit = (stream, data) => {
          const text = data.toString();
          if (stream === "stdout") stdout += text;
          else stderr += text;
          onOutput?.({ stream, text, elapsedMs: Date.now() - startedAt });
        };
        const abortCommand = () => {
          try { child.kill(); } catch {}
          finish({ ok: false, stdout, stderr: stderr || "Command stopped by user.", exitCode: -1, cancelled: true });
        };
        signal?.addEventListener?.("abort", abortCommand, { once: true });
        const timer = setTimeout(() => {
          try { child.kill(); } catch {}
          finish({ ok: false, stdout, stderr: stderr || `Command timed out after ${boundedTimeoutMs}ms.`, exitCode: -1, timedOut: true });
        }, boundedTimeoutMs);
        timer.unref?.();
        child.stdout?.on("data", (data) => emit("stdout", data));
        child.stderr?.on("data", (data) => emit("stderr", data));
        child.on("error", (error) => finish({ ok: false, stdout, stderr: stderr || error.message, exitCode: -1 }));
        child.on("close", (code, closeSignal) => finish({ ok: code === 0, stdout, stderr, exitCode: code ?? (closeSignal ? -1 : 0), signal: closeSignal || "" }));
      });
    }
  };
}

let defaultFacade = null;

export function getExecutionHostFacade() {
  if (defaultFacade) return defaultFacade;
  const command = resolveExecutionHostCommand();
  const hostConfigured = Boolean(process.env.VIBELINK_EXECUTION_HOST_PIPE || command);
  const hostEnabled = process.env.VIBELINK_EXECUTION_HOST !== "off" && hostConfigured;
  defaultFacade = hostEnabled
    ? createExecutionHostFacade({ client: createExecutionHostClient({ command }) })
    : createLegacyExecutionFacade();
  return defaultFacade;
}
