function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function cleanMethod(value) {
  return String(value || "unknown").trim().slice(0, 120) || "unknown";
}

function cleanMode(value) {
  return String(value || "sync").trim().slice(0, 40) || "sync";
}

function emptyMethodStats() {
  return {
    count: 0,
    failures: 0,
    fallbacks: 0,
    stalls: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    maxDurationMs: 0,
    lastDurationMs: 0,
    lastAt: "",
    modeCounts: {}
  };
}

export function createEventStoreMetrics({ now = () => new Date().toISOString(), stallThresholdMs } = {}) {
  const startedAt = now();
  const methods = new Map();
  let requests = 0;
  let failures = 0;
  let fallbacks = 0;
  let stalls = 0;
  let maxStallDurationMs = 0;

  function resolvedStallThresholdMs() {
    const value = stallThresholdMs === undefined
      ? Number(process.env.VIBELINK_EVENT_STORE_STALL_THRESHOLD_MS)
      : Number(stallThresholdMs);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 50;
  }

  function record({ method = "unknown", mode = "sync", ok = true, durationMs = 0, fallback = false } = {}) {
    const key = cleanMethod(method);
    const modeKey = cleanMode(mode);
    const stats = methods.get(key) || emptyMethodStats();
    const duration = roundMs(durationMs);

    requests += 1;
    stats.count += 1;
    stats.totalDurationMs = roundMs(stats.totalDurationMs + duration);
    stats.avgDurationMs = roundMs(stats.totalDurationMs / stats.count);
    stats.maxDurationMs = roundMs(Math.max(stats.maxDurationMs, duration));
    stats.lastDurationMs = duration;
    stats.lastAt = now();
    stats.modeCounts[modeKey] = Number(stats.modeCounts[modeKey] || 0) + 1;

    if (!ok) {
      failures += 1;
      stats.failures += 1;
    }
    if (fallback) {
      fallbacks += 1;
      stats.fallbacks += 1;
    }
    if (modeKey === "sync" && duration >= resolvedStallThresholdMs()) {
      stalls += 1;
      stats.stalls += 1;
      maxStallDurationMs = roundMs(Math.max(maxStallDurationMs, duration));
    }

    methods.set(key, stats);
  }

  function snapshot() {
    const methodStats = {};
    for (const [method, stats] of methods.entries()) {
      methodStats[method] = {
        count: stats.count,
        failures: stats.failures,
        fallbacks: stats.fallbacks,
        stalls: stats.stalls,
        avgDurationMs: stats.avgDurationMs,
        maxDurationMs: stats.maxDurationMs,
        lastDurationMs: stats.lastDurationMs,
        lastAt: stats.lastAt,
        modeCounts: { ...stats.modeCounts }
      };
    }
    return {
      startedAt,
      requests,
      failures,
      fallbacks,
      stalls: {
        thresholdMs: resolvedStallThresholdMs(),
        count: stalls,
        maxDurationMs: maxStallDurationMs
      },
      methods: methodStats
    };
  }

  return { record, snapshot };
}
