import { spawn } from "node:child_process";

import { eventStoreErrorFromPayload } from "./eventStoreContract.js";

const MAX_STDIO_BUFFER = 1024 * 1024;

function maxPendingRequestsValue(value = process.env.VIBELINK_EVENT_STORE_SIDECAR_MAX_PENDING_REQUESTS) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 128;
}

function backpressureError(method, maxPendingRequests) {
  const error = new Error(
    `Event store sidecar backpressure: ${method} rejected because ${maxPendingRequests} request(s) are already pending.`
  );
  error.code = "EEVENTSTOREBACKPRESSURE";
  error.maxPendingRequests = maxPendingRequests;
  return error;
}

function sidecarExitError(code, signal, stderr) {
  const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
  const suffix = stderr ? ` Stderr: ${stderr}` : "";
  return new Error(`Event store sidecar exited before replying (${reason}).${suffix}`);
}

export function createEventStoreSidecarClient({
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 10000,
  maxPendingRequests = maxPendingRequestsValue()
} = {}) {
  if (!command) throw new TypeError("createEventStoreSidecarClient requires command.");

  const child = spawn(command, Array.isArray(args) ? args : [], {
    cwd,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map();
  let nextId = 1;
  let terminated = false;
  let stdout = "";
  let stderr = "";
  let requests = 0;
  let responses = 0;
  let failures = 0;
  let timeouts = 0;
  let backpressureRejects = 0;
  let maxPendingObserved = 0;
  let lastRequestAt = "";
  let lastResponseAt = "";
  let lastFailureAt = "";
  let lastBackpressureAt = "";

  function nowIso() {
    return new Date().toISOString();
  }

  function recordFailure() {
    failures += 1;
    lastFailureAt = nowIso();
  }

  function rejectPending(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      recordFailure();
      reject(error);
    }
    pending.clear();
  }

  function resolveMessage(message = {}) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      recordFailure();
      request.reject(eventStoreErrorFromPayload(message.error));
    } else {
      responses += 1;
      lastResponseAt = nowIso();
      request.resolve(message.result);
    }
  }

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > MAX_STDIO_BUFFER) stdout = stdout.slice(-MAX_STDIO_BUFFER);
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) {
        try {
          resolveMessage(JSON.parse(line));
        } catch (error) {
          error.message = `Event store sidecar returned invalid JSON: ${error.message}`;
          rejectPending(error);
        }
      }
      newline = stdout.indexOf("\n");
    }
  });

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > MAX_STDIO_BUFFER) stderr = stderr.slice(-MAX_STDIO_BUFFER);
  });

  child.on("error", (error) => {
    terminated = true;
    rejectPending(error);
  });

  child.on("exit", (code, signal) => {
    terminated = true;
    if (pending.size > 0) rejectPending(sidecarExitError(code, signal, stderr.trim()));
  });

  function request(method, requestArgs = [], options = {}) {
    if (terminated) return Promise.reject(new Error("Event store sidecar is closed."));
    const pendingLimit = maxPendingRequestsValue(options.maxPendingRequests ?? maxPendingRequests);
    if (pending.size >= pendingLimit) {
      backpressureRejects += 1;
      lastBackpressureAt = nowIso();
      return Promise.reject(backpressureError(method, pendingLimit));
    }
    const timeout = Math.max(1, Number(options.timeout || timeoutMs));
    const id = nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        timeouts += 1;
        recordFailure();
        reject(new Error(`Event store sidecar request timed out: ${method}`));
      }, timeout);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      requests += 1;
      lastRequestAt = nowIso();
      maxPendingObserved = Math.max(maxPendingObserved, pending.size);
      child.stdin.write(`${JSON.stringify({ id, method, args: Array.isArray(requestArgs) ? requestArgs : [] })}\n`, "utf8", (error) => {
        if (!error) return;
        pending.delete(id);
        clearTimeout(timer);
        recordFailure();
        reject(error);
      });
    });
  }

  async function close() {
    if (terminated) return;
    try {
      await request("__close", [], { timeout: 2000 });
    } catch {
      // The sidecar may already be exiting; kill below is the hard stop.
    }
    terminated = true;
    try { child.stdin?.end(); } catch {}
    if (!child.killed) child.kill();
  }

  return {
    request,
    stats: () => ({
      pending: pending.size,
      maxPendingRequests: maxPendingRequestsValue(maxPendingRequests),
      maxPendingObserved,
      requests,
      responses,
      failures,
      timeouts,
      backpressureRejects,
      lastRequestAt,
      lastResponseAt,
      lastFailureAt,
      lastBackpressureAt,
      terminated,
      stderr: stderr.trim()
    }),
    health: () => request("__health"),
    getSidecarStats: () => request("stats"),
    insertTaskEvent: (taskId, event) => request("insertTaskEvent", [taskId, event]),
    insertTaskEvents: (taskId, events) => request("insertTaskEvents", [taskId, events]),
    listTaskEvents: (taskId, options) => request("listTaskEvents", [taskId, options]),
    getTaskEventCount: (taskId) => request("getTaskEventCount", [taskId]),
    insertToolEvent: (toolRunId, event) => request("insertToolEvent", [toolRunId, event]),
    insertToolEvents: (toolRunId, events) => request("insertToolEvents", [toolRunId, events]),
    listToolEvents: (options) => request("listToolEvents", [options]),
    getToolEventStats: () => request("getToolEventStats"),
    pruneToolEvents: (options) => request("pruneToolEvents", [options]),
    insertLiveCallEvent: (sessionId, event) => request("insertLiveCallEvent", [sessionId, event]),
    insertLiveCallEvents: (sessionId, events) => request("insertLiveCallEvents", [sessionId, events]),
    listLiveCallEvents: (options) => request("listLiveCallEvents", [options]),
    pruneLiveCallEvents: (options) => request("pruneLiveCallEvents", [options]),
    listUnifiedEvents: (options) => request("listUnifiedEvents", [options]),
    replayWindow: (options) => request("replayWindow", [options]),
    close
  };
}
