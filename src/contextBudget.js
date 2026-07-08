// Token budget estimator and context window manager.
//
// Uses js-tiktoken (BPE tokenizer) for accurate token counting.
// Provides budget creation for different models and filtering of events
// to fit within the effective context window.

import { performance } from "node:perf_hooks";
import { getEncoding } from "js-tiktoken";

const encodings = new Map(); // cache encodings per model family
const contextBudgetMetrics = {
  textEstimateCalls: 0,
  eventEstimateCalls: 0,
  eventsEstimated: 0,
  charsEstimated: 0,
  totalEstimateMs: 0,
  lastEstimateMs: 0,
  maxEstimateMs: 0
};

function observeEstimate({ textCall = false, eventCall = false, eventCount = 0, charCount = 0, startedAt = 0 } = {}) {
  const elapsedMs = Math.max(0, performance.now() - startedAt);
  if (textCall) contextBudgetMetrics.textEstimateCalls += 1;
  if (eventCall) contextBudgetMetrics.eventEstimateCalls += 1;
  contextBudgetMetrics.eventsEstimated += eventCount;
  contextBudgetMetrics.charsEstimated += charCount;
  contextBudgetMetrics.totalEstimateMs += elapsedMs;
  contextBudgetMetrics.lastEstimateMs = elapsedMs;
  contextBudgetMetrics.maxEstimateMs = Math.max(contextBudgetMetrics.maxEstimateMs, elapsedMs);
}

export function resetContextBudgetMetrics() {
  contextBudgetMetrics.textEstimateCalls = 0;
  contextBudgetMetrics.eventEstimateCalls = 0;
  contextBudgetMetrics.eventsEstimated = 0;
  contextBudgetMetrics.charsEstimated = 0;
  contextBudgetMetrics.totalEstimateMs = 0;
  contextBudgetMetrics.lastEstimateMs = 0;
  contextBudgetMetrics.maxEstimateMs = 0;
}

export function getContextBudgetMetrics() {
  const estimateCalls = contextBudgetMetrics.textEstimateCalls + contextBudgetMetrics.eventEstimateCalls;
  return {
    textEstimateCalls: contextBudgetMetrics.textEstimateCalls,
    eventEstimateCalls: contextBudgetMetrics.eventEstimateCalls,
    eventsEstimated: contextBudgetMetrics.eventsEstimated,
    charsEstimated: contextBudgetMetrics.charsEstimated,
    totalEstimateMs: Number(contextBudgetMetrics.totalEstimateMs.toFixed(3)),
    lastEstimateMs: Number(contextBudgetMetrics.lastEstimateMs.toFixed(3)),
    avgEstimateMs: estimateCalls > 0 ? Number((contextBudgetMetrics.totalEstimateMs / estimateCalls).toFixed(3)) : 0,
    maxEstimateMs: Number(contextBudgetMetrics.maxEstimateMs.toFixed(3)),
    encoderCacheSize: encodings.size
  };
}

function getEncoder(modelHint = "") {
  const key = modelHint.includes("gpt") ? "cl100k_base" : "cl100k_base";
  if (!encodings.has(key)) {
    try {
      encodings.set(key, getEncoding(key));
    } catch {
      return null; // fallback: rough char-based estimate
    }
  }
  return encodings.get(key);
}

/**
 * Estimate the token count for a string.
 * Falls back to rough char/3 estimate if tiktoken init fails.
 */
export function estimateTokenCount(text = "", modelHint = "") {
  const startedAt = performance.now();
  const value = String(text || "");
  try {
    if (!value) return 0;
    const enc = getEncoder(modelHint);
    if (enc) return enc.encode(value).length;
    return Math.ceil(value.length / 3); // rough fallback for CJK text
  } finally {
    observeEstimate({ textCall: true, charCount: value.length, startedAt });
  }
}

/**
 * Estimate token count for an array of event objects.
 * Concatenates relevant text fields.
 */
export function estimateEventsTokenCount(events = [], modelHint = "") {
  const startedAt = performance.now();
  let totalChars = 0;
  try {
    for (const event of events) {
      totalChars += String(event.text || "").length;
      totalChars += String(event.type || "").length;
      if (event.payload?.text) totalChars += String(event.payload.text).length;
      if (event.payload?.input) totalChars += JSON.stringify(event.payload.input).length;
      if (event.payload?.result) totalChars += JSON.stringify(event.payload.result).length;
    }
    const enc = getEncoder(modelHint);
    if (enc) return enc.encode("").length + Math.ceil(totalChars / 2.5);
    return Math.ceil(totalChars / 3);
  } finally {
    observeEstimate({ eventCall: true, eventCount: events.length, charCount: totalChars, startedAt });
  }
}

/**
 * Default context window sizes by model family.
 */
const MODEL_WINDOWS = {
  "gpt-5": 200_000,
  "gpt-4": 128_000,
  claude: 200_000,
  "glm-5": 128_000,
  glm: 128_000,
  default: 128_000
};

function modelFamily(model = "") {
  if (model.includes("glm-5") || model === "glm-5.2" || model === "glm-5.1" || model === "glm-5.0") return "glm-5";
  if (model.startsWith("glm")) return "glm";
  if (model.startsWith("gpt-5")) return "gpt-5";
  if (model.startsWith("gpt-4")) return "gpt-4";
  if (model.includes("opus") || model.includes("sonnet") || model.includes("fable") || model.startsWith("claude")) return "claude";
  if (model.includes("[1m]")) return "gpt-5"; // million-context models
  return "default";
}

/**
 * Create a token budget for a given model.
 *
 * Returns:
 *   { total, reservedForSummary, effective, used, leftover }
 */
export function createTokenBudget(model = "", options = {}) {
  const total = options.total || MODEL_WINDOWS[modelFamily(model)] || MODEL_WINDOWS.default;
  const reservedForSummary = Math.min(
    options.reservedForSummary || 20_000,
    Math.floor(total * 0.15) // at most 15% of window
  );
  const effective = total - reservedForSummary;
  return { total, reservedForSummary, effective, used: 0, leftover: effective };
}

/**
 * Given a budget and an array of events, determine if the events fit.
 * Returns { fits: boolean, used: number, remaining: number }
 */
export function checkBudget(budget = {}, events = []) {
  const used = estimateEventsTokenCount(events);
  const remaining = (budget.effective || budget.total || 128_000) - used;
  return {
    fits: remaining >= 0,
    used,
    remaining,
    percentUsed: ((used / (budget.effective || budget.total || 128_000)) * 100).toFixed(0)
  };
}

/**
 * Estimate whether a new prompt plus existing event history fits in the
 * effective window for the given model.
 */
export function estimateHeadroom(prompt = "", historyEvents = [], model = "") {
  const budget = createTokenBudget(model);
  const promptTokens = estimateTokenCount(prompt, model);
  const historyTokens = estimateEventsTokenCount(historyEvents, model);
  const used = promptTokens + historyTokens;
  return {
    model,
    total: budget.effective,
    promptTokens,
    historyTokens,
    used,
    remaining: budget.effective - used,
    fits: used <= budget.effective
  };
}