import crypto from "node:crypto";

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function createTaskScheduler({
  store,
  execute,
  concurrency = 2,
  pollIntervalMs = 250,
  retryBaseMs = 1000,
  onTransition = () => {}
} = {}) {
  if (!store || typeof execute !== "function") throw new TypeError("store and execute are required");
  const limit = boundedInteger(concurrency, 2, 1, 32);
  const active = new Map();
  const reservedTaskIds = new Set();
  let timer = null;
  let draining = false;

  const transition = (job, detail = {}) => {
    try { onTransition(job, detail); } catch {}
  };

  async function run(job) {
    active.set(job.id, job);
    transition(job, { type: "started" });
    try {
      const result = await execute(job);
      if (result?.status === "failed") throw new Error(result.error || "Task failed.");
      const completed = store.settle(job.id, { status: result?.status === "cancelled" ? "cancelled" : "completed" });
      transition(completed, { type: "completed" });
    } catch (error) {
      const latest = store.get(job.id) || job;
      if (latest.status === "cancelled") {
        transition(latest, { type: "cancelled" });
      } else if (latest.attempts < latest.maxAttempts) {
        const delay = Math.min(60_000, retryBaseMs * (2 ** Math.max(0, latest.attempts - 1)));
        const queued = store.settle(job.id, {
          status: "queued",
          error: error?.message || String(error),
          nextAttemptAt: new Date(Date.now() + delay).toISOString()
        });
        transition(queued, { type: "retry_scheduled", delayMs: delay, error });
      } else {
        const failed = store.settle(job.id, { status: "failed", error: error?.message || String(error) });
        transition(failed, { type: "failed", error });
      }
    } finally {
      active.delete(job.id);
      queueMicrotask(drain);
    }
  }

  function drain() {
    if (draining) return;
    draining = true;
    try {
      while (active.size + reservedTaskIds.size < limit) {
        const job = store.claimNext();
        if (!job) break;
        void run(job);
      }
    } finally {
      draining = false;
    }
  }

  return {
    enqueue({ taskId, payload, priority = 0, maxAttempts = 3 }) {
      const job = store.enqueue({ id: crypto.randomUUID(), taskId, payload, priority, maxAttempts });
      transition(job, { type: "queued" });
      queueMicrotask(drain);
      return job;
    },
    start({ preserveTaskIds = [] } = {}) {
      if (timer) return;
      for (const taskId of preserveTaskIds) if (taskId) reservedTaskIds.add(taskId);
      store.recoverRunning({ preserveTaskIds });
      timer = setInterval(drain, Math.max(25, Number(pollIntervalMs || 250)));
      timer.unref?.();
      drain();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    retry(id) {
      const job = store.retry(id);
      if (job?.status === "queued") {
        transition(job, { type: "retry_requested" });
        queueMicrotask(drain);
      }
      return job;
    },
    cancel(id) {
      const job = store.cancel(id);
      if (job?.status === "cancelled") transition(job, { type: "cancelled" });
      return job;
    },
    cancelRunning(id) {
      const job = store.cancel(id, { includeRunning: true });
      if (job?.status === "cancelled") transition(job, { type: "cancelled" });
      return job;
    },
    settleTask(taskId, result = {}) {
      const wasReserved = reservedTaskIds.delete(taskId);
      const job = store.get(taskId);
      if (!job || job.status !== "running" || active.has(job.id)) {
        if (wasReserved) queueMicrotask(drain);
        return job;
      }
      if (result.status === "failed" && job.attempts < job.maxAttempts) {
        const delay = Math.min(60_000, retryBaseMs * (2 ** Math.max(0, job.attempts - 1)));
        const queued = store.settle(job.id, { status: "queued", error: result.error || "Task failed.", nextAttemptAt: new Date(Date.now() + delay).toISOString() });
        transition(queued, { type: "retry_scheduled", delayMs: delay });
        return queued;
      }
      const status = result.status === "failed" ? "failed" : result.status === "cancelled" ? "cancelled" : "completed";
      const settled = store.settle(job.id, { status, error: result.error || "" });
      transition(settled, { type: status });
      queueMicrotask(drain);
      return settled;
    },
    status() {
      const jobs = store.list();
      const storedCounts = store.counts?.() || {};
      const counts = Object.fromEntries(["queued", "running", "completed", "failed", "cancelled"].map((key) => [key, Number(storedCounts[key] || 0)]));
      return { concurrency: limit, active: active.size + reservedTaskIds.size, counts, items: jobs };
    },
    drain
  };
}
