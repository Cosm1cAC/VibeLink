import { Worker } from "node:worker_threads";

function workerError(payload = {}) {
  const error = new Error(payload.message || "Event store worker request failed.");
  error.name = payload.name || "Error";
  if (payload.stack) error.stack = payload.stack;
  if (payload.code) error.code = payload.code;
  return error;
}

function maxPendingRequestsValue(value = process.env.VIBELINK_EVENT_STORE_WORKER_MAX_PENDING_REQUESTS) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 128;
}

function backpressureError(method, maxPendingRequests) {
  const error = new Error(
    `Event store worker backpressure: ${method} rejected because ${maxPendingRequests} request(s) are already pending.`
  );
  error.code = "EEVENTSTOREBACKPRESSURE";
  error.maxPendingRequests = maxPendingRequests;
  return error;
}

export function createEventStoreWorkerClient({
  dbPath,
  timeoutMs = 10000,
  maxPendingRequests = maxPendingRequestsValue(),
  workerUrl = new URL("./eventStoreWorker.js", import.meta.url)
} = {}) {
  if (!dbPath) throw new TypeError("createEventStoreWorkerClient requires dbPath.");

  const worker = new Worker(workerUrl, { workerData: { dbPath } });
  const pending = new Map();
  let nextId = 1;
  let terminated = false;

  function rejectPending(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  worker.on("message", (message = {}) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(workerError(message.error));
    else request.resolve(message.result);
  });

  worker.on("error", (error) => {
    rejectPending(error);
  });

  worker.on("exit", (code) => {
    terminated = true;
    if (pending.size > 0) {
      rejectPending(new Error(`Event store worker exited before replying (code ${code}).`));
    }
  });

  function request(method, args = [], options = {}) {
    if (terminated) return Promise.reject(new Error("Event store worker is closed."));
    const pendingLimit = maxPendingRequestsValue(options.maxPendingRequests ?? maxPendingRequests);
    if (pending.size >= pendingLimit) return Promise.reject(backpressureError(method, pendingLimit));
    const { timeout = timeoutMs } = options;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Event store worker request timed out: ${method}`));
      }, Math.max(1, Number(timeout || timeoutMs)));
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, method, args });
    });
  }

  async function close() {
    if (terminated) return;
    try {
      await request("__close", [], { timeout: 2000 });
    } catch {
      // The worker may already be exiting; terminate below is the hard stop.
    }
    terminated = true;
    await worker.terminate().catch(() => {});
  }

  return {
    request,
    stats: () => ({ pending: pending.size, maxPendingRequests: maxPendingRequestsValue(maxPendingRequests), terminated }),
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
