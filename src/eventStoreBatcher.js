function cleanKey(value) {
  return String(value || "default");
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

export function createEventStoreBatcher({ flushBatch, delayMs = 50, maxBatchSize = 0 } = {}) {
  if (typeof flushBatch !== "function") {
    throw new TypeError("createEventStoreBatcher requires a flushBatch function.");
  }

  const queue = [];
  let timer = null;
  let flushing = null;
  let flushes = 0;
  let maxObservedBatchSize = 0;
  let lastFlushAt = "";
  let totalEvents = 0;
  let totalFlushDurationMs = 0;
  let lastFlushDurationMs = 0;
  const batchSizeLimit = Number.isFinite(Number(maxBatchSize)) ? Math.max(0, Number(maxBatchSize)) : 0;

  function clearTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    if (timer || delayMs <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      flushNow().catch(() => {});
    }, delayMs);
    timer.unref?.();
  }

  function enqueue(key, event) {
    return new Promise((resolve, reject) => {
      queue.push({ key: cleanKey(key), event, resolve, reject });
      if (batchSizeLimit > 0 && queue.length >= batchSizeLimit) {
        clearTimer();
        queueMicrotask(() => {
          flushNow().catch(() => {});
        });
      } else {
        schedule();
      }
    });
  }

  async function flushNow() {
    if (flushing) return flushing;
    clearTimer();
    if (queue.length === 0) return [];

    const items = queue.splice(0, queue.length);
    const startedAt = nowMs();
    flushing = (async () => {
      flushes += 1;
      totalEvents += items.length;
      maxObservedBatchSize = Math.max(maxObservedBatchSize, items.length);
      lastFlushAt = new Date().toISOString();
      const groups = new Map();
      for (const item of items) {
        if (!groups.has(item.key)) groups.set(item.key, []);
        groups.get(item.key).push(item);
      }

      for (const [key, group] of groups.entries()) {
        try {
          const results = await flushBatch(key, group.map((item) => item.event));
          group.forEach((item, index) => item.resolve(Array.isArray(results) ? results[index] : results));
        } catch (error) {
          group.forEach((item) => item.reject(error));
        }
      }
      return items.map((item) => item.event);
    })();

    try {
      return await flushing;
    } finally {
      lastFlushDurationMs = roundMs(nowMs() - startedAt);
      totalFlushDurationMs = roundMs(totalFlushDurationMs + lastFlushDurationMs);
      flushing = null;
      if (queue.length > 0) schedule();
    }
  }

  function pendingCount() {
    return queue.length;
  }

  function stats() {
    return {
      pending: pendingCount(),
      flushes,
      totalEvents,
      avgBatchSize: flushes > 0 ? roundMs(totalEvents / flushes) : 0,
      maxBatchSize: maxObservedBatchSize,
      lastFlushDurationMs,
      avgFlushDurationMs: flushes > 0 ? roundMs(totalFlushDurationMs / flushes) : 0,
      lastFlushAt
    };
  }

  return { enqueue, flushNow, pendingCount, stats };
}
