import { spawn } from "node:child_process";

const MAX_STDOUT_BUFFER = 16 * 1024 * 1024;
const MAX_STDERR_BUFFER = 1024 * 1024;

function responseError(payload = {}) {
  const error = new Error(payload.message || "Status sidecar request failed.");
  error.name = payload.name || "Error";
  if (payload.code) error.code = payload.code;
  return error;
}

export function createStatusSidecarClient({
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 5000,
  maxPendingRequests = 32
} = {}) {
  if (!command) throw new TypeError("createStatusSidecarClient requires command.");
  const child = spawn(command, args, {
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

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      failures += 1;
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
      failures += 1;
      request.reject(responseError(message.error));
      return;
    }
    responses += 1;
    request.resolve(message.result);
  }

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > MAX_STDOUT_BUFFER) {
      stdout = "";
      rejectPending(new Error(`Status sidecar response exceeded ${MAX_STDOUT_BUFFER} bytes.`));
      return;
    }
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) {
        try {
          resolveMessage(JSON.parse(line));
        } catch (error) {
          error.message = `Status sidecar returned invalid JSON: ${error.message}`;
          rejectPending(error);
        }
      }
      newline = stdout.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > MAX_STDERR_BUFFER) stderr = stderr.slice(-MAX_STDERR_BUFFER);
  });
  child.on("error", (error) => {
    terminated = true;
    rejectPending(error);
  });
  child.on("exit", (code, signal) => {
    terminated = true;
    if (!pending.size) return;
    const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    rejectPending(new Error(`Status sidecar exited before replying (${reason}).${stderr.trim() ? ` Stderr: ${stderr.trim()}` : ""}`));
  });

  function request(method, requestArgs = [], options = {}) {
    if (terminated) return Promise.reject(new Error("Status sidecar is closed."));
    if (pending.size >= maxPendingRequests) {
      backpressureRejects += 1;
      return Promise.reject(new Error(`Status sidecar backpressure: ${method} rejected at ${maxPendingRequests} pending request(s).`));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const requestTimeoutMs = Math.max(1, Number(options.timeoutMs || timeoutMs));
      const timer = setTimeout(() => {
        pending.delete(id);
        failures += 1;
        timeouts += 1;
        reject(new Error(`Status sidecar request timed out: ${method}`));
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      requests += 1;
      child.stdin.write(`${JSON.stringify({ id, method, args: requestArgs })}\n`, "utf8", (error) => {
        if (!error) return;
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        clearTimeout(timer);
        failures += 1;
        reject(error);
      });
    });
  }

  async function close() {
    if (terminated) return;
    try { await request("__close", [], { timeoutMs: 2000 }); } catch {}
    terminated = true;
    try { child.stdin.end(); } catch {}
    if (!child.killed) child.kill();
  }

  return {
    request,
    health: () => request("__health"),
    renderStatus: (snapshot) => request("renderStatus", [snapshot]),
    stats: () => ({
      pending: pending.size,
      maxPendingRequests,
      requests,
      responses,
      failures,
      timeouts,
      backpressureRejects,
      terminated,
      stderr: stderr.trim()
    }),
    close
  };
}
