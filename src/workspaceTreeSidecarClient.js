import { spawn } from "node:child_process";

const MAX_STDIO_BUFFER = 1024 * 1024;

function maxPendingRequestsValue(value = process.env.VIBELINK_WORKSPACE_TREE_SIDECAR_MAX_PENDING_REQUESTS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 64;
}

function responseError(payload = {}) {
  const error = new Error(payload.message || "Workspace tree sidecar request failed.");
  error.name = payload.name || "Error";
  if (payload.code) error.code = payload.code;
  return error;
}

function exitError(code, signal, stderr) {
  const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
  return new Error(`Workspace tree sidecar exited before replying (${reason}).${stderr ? ` Stderr: ${stderr}` : ""}`);
}

export function createWorkspaceTreeSidecarClient({
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 10000,
  maxPendingRequests = maxPendingRequestsValue()
} = {}) {
  if (!command) throw new TypeError("createWorkspaceTreeSidecarClient requires command.");

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

  const nowIso = () => new Date().toISOString();
  const recordFailure = () => {
    failures += 1;
    lastFailureAt = nowIso();
  };
  const killOnExit = () => {
    try { if (!child.killed) child.kill(); } catch {}
  };
  process.once("exit", killOnExit);

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      recordFailure();
      request.reject(error);
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
      request.reject(responseError(message.error));
      return;
    }
    responses += 1;
    lastResponseAt = nowIso();
    request.resolve(message.result);
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
          error.message = `Workspace tree sidecar returned invalid JSON: ${error.message}`;
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
    process.removeListener("exit", killOnExit);
    rejectPending(error);
  });
  child.on("exit", (code, signal) => {
    terminated = true;
    process.removeListener("exit", killOnExit);
    if (pending.size) rejectPending(exitError(code, signal, stderr.trim()));
  });

  function waitForExit(waitMs = 2000) {
    if (terminated) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function request(method, requestArgs = [], options = {}) {
    if (terminated) return Promise.reject(new Error("Workspace tree sidecar is closed."));
    const pendingLimit = maxPendingRequestsValue(options.maxPendingRequests ?? maxPendingRequests);
    if (pending.size >= pendingLimit) {
      backpressureRejects += 1;
      const error = new Error(`Workspace tree sidecar backpressure: ${method} rejected at ${pendingLimit} pending request(s).`);
      error.code = "EWORKSPACETREEBACKPRESSURE";
      return Promise.reject(error);
    }
    const timeout = Math.max(1, Number(options.timeout || timeoutMs));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        timeouts += 1;
        recordFailure();
        reject(new Error(`Workspace tree sidecar request timed out: ${method}`));
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
      // The hard stop below handles an already-failed sidecar.
    }
    await waitForExit();
    terminated = true;
    process.removeListener("exit", killOnExit);
    try { child.stdin?.end(); } catch {}
    if (!child.killed) child.kill();
  }

  return {
    request,
    health: () => request("__health"),
    scan: (options) => request("scan", [options]),
    getSidecarStats: () => request("stats"),
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
      terminated,
      stderr: stderr.trim()
    }),
    close
  };
}
