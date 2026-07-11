function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

export function summarizeLatencySamples(values = [], stallThresholdMs = 50) {
  const samples = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const trimEachSide = samples.length >= 10 ? Math.floor(samples.length * 0.1) : 0;
  const trimmed = trimEachSide > 0 && trimEachSide * 2 < sorted.length
    ? sorted.slice(trimEachSide, sorted.length - trimEachSide)
    : sorted;
  const trimmedTotal = trimmed.reduce((sum, value) => sum + value, 0);
  const p95Index = sorted.length
    ? Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
    : 0;
  return {
    count: samples.length,
    avgMs: roundMs(samples.length ? total / samples.length : 0),
    trimmedCount: trimmed.length,
    trimmedAvgMs: roundMs(trimmed.length ? trimmedTotal / trimmed.length : 0),
    maxMs: roundMs(sorted[sorted.length - 1] || 0),
    p95Ms: roundMs(sorted[p95Index] || 0),
    stalls: samples.filter((value) => value >= stallThresholdMs).length
  };
}

export function evaluateLatency({ baseline = {}, candidate = {}, latencyMarginMs = 0 } = {}) {
  const baselineMs = Number(baseline.trimmedAvgMs || 0);
  const candidateMs = Number(candidate.trimmedAvgMs || 0);
  const limitMs = Math.max(baselineMs * 1.1, baselineMs + Number(latencyMarginMs || 0));
  return {
    pass: baselineMs === 0 ? candidateMs === 0 : candidateMs <= limitMs,
    baselineMs: roundMs(baselineMs),
    candidateMs: roundMs(candidateMs),
    limitMs: roundMs(limitMs)
  };
}
