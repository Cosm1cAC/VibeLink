import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";

function maxPendingRequestsValue(value = process.env.VIBELINK_EVENT_STORE_SIDECAR_MAX_PENDING_REQUESTS) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 128;
}

function backpressureError(method, maxPendingRequests) {
  const error = new Error(
    `Event store sidecar backpressure: ${method} rejected because ${maxPendingRequests} request(s) are already pending.`
  );
  error.code = "EEVENTSTORESIDECARBACKPRESSURE";
  error.maxPendingRequests = maxPendingRequests;
  return error;
}

function sidecarError(payload = {}) {
  const error = new Error(payload.message || "Event store sidecar request failed.");
  error.name = payload.name || "Error";
  if (payload.stack) error.stack = payload.stack;
  if (payload.code) error.code = payload.code;
  return error;
}

function splitCommand(command, args = []) {
  if (Array.isArray(args) && args.length > 0) return { command, args };
  return { command, args: [] };
}

export function createEventStoreSidecarClient({
  command = process.env.VIBELINK_EVENT_STORE_SIDECAR_BIN,
  args = [],
  dbPath,
  timeoutMs = 10000,
  maxPendingRequests = maxPendingRequestsValue(),
  env = process.env
} = {}) {
  if (!command) throw new TypeError("createEventStoreSidecarClient requires command.");
  if (!dbPath) throw new TypeError("createEventStoreSidecarClient requires dbPath.");

  const commandSpec = splitCommand(command, args);
  const child = spawn(commandSpec.command, commandSpec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, VIBELINK_EVENT_STORE_DB_PATH: dbPath }
  });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let stderr = "";

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });

  const reader = readline.createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(sidecarError(message.error));
    else request.resolve(message.result);
  });

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  child.on("error", (error) => {
    closed = true;
    rejectPending(error);
  });

  child.on("exit", (code) => {
    closed = true;
    if (pending.size > 0) {
      rejectPending(new Error(`Event store sidecar exited before replying (code ${code}). ${stderr}`.trim()));
    }
  });

  function request(method, requestArgs = [], options = {}) {
    if (closed) return Promise.reject(new Error("Event store sidecar is closed."));
    const pendingLimit = maxPendingRequestsValue(options.maxPendingRequests ?? maxPendingRequests);
    if (pending.size >= pendingLimit) return Promise.reject(backpressureError(method, pendingLimit));
    const timeout = Math.max(1, Number(options.timeout || timeoutMs));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Event store sidecar request timed out: ${method}`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, args: requestArgs })}\n`, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  }

  async function close() {
    if (closed) return;
    try {
      await request("__close", [], { timeout: 2000 });
    } catch {}
    closed = true;
    child.kill();
    await once(child, "exit").catch(() => {});
  }

  return {
    request,
    stats: () => ({ pending: pending.size, maxPendingRequests: maxPendingRequestsValue(maxPendingRequests), terminated: closed, stderr }),
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