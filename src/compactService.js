// Compact service — automatic summary/token-budget management for agent tasks.
//
// For long-running tasks, this module:
//   1. Monitors task events and estimates token consumption
//   2. When the budget threshold is exceeded, generates a summary event
//   3. Injects the summary into subsequent agent prompts so the model
//      retains key context without consuming the full event history
//
// This is an augmentative step — the upstream CLI (Codex/Claude) still
// manages its own history. We add budget monitoring and summarization
// at the VibeLink bridge level so that:
//   - VibeLink Agent tasks have a predictable token footprint
//   - Restored tasks can start with a summary instead of full history
//   - The UI can display budget/headroom stats
//
// The actual summarization is delegated to the model itself via a
// compact prompt (auto-compact). This mirrors the Claude Code
// compact pattern where the assistant is asked to produce a "summary
// of what happened so far".

import { performance } from "node:perf_hooks";
import { estimateEventsTokenCount, createTokenBudget, checkBudget } from "./contextBudget.js";
import { appendExternalTaskEvent } from "./agents.js";
import { listTaskEvents, resolveEventReplayLimit } from "./db.js";

export const DEFAULT_COMPACT_EVENT_LIMIT = 1000;
export const DEFAULT_COMPACT_INPUT_MAX_CHARS = 120_000;

const compactServiceMetrics = {
  budgetChecks: 0,
  compactTaskCalls: 0,
  buildContextCalls: 0,
  eventsChecked: 0,
  summaryRequestsCreated: 0,
  compactedContextsReturned: 0,
  nullResults: 0,
  summaryInputsBuilt: 0,
  summaryInputTruncations: 0,
  summaryInputDroppedEvents: 0,
  summaryInputSourceChars: 0,
  summaryInputChars: 0,
  totalMs: 0,
  lastMs: 0,
  maxMs: 0
};

export function resolveCompactEventLimit(value, options = {}) {
  return resolveEventReplayLimit(value, { defaultLimit: DEFAULT_COMPACT_EVENT_LIMIT, ...options });
}

export function buildCompactSummaryInput(events = [], { maxChars = DEFAULT_COMPACT_INPUT_MAX_CHARS, maxBufferedLines = 0 } = {}) {
  const maximum = Math.max(1, Number(maxChars || DEFAULT_COMPACT_INPUT_MAX_CHARS));
  const maximumBufferedLines = Math.max(0, Number(maxBufferedLines || 0));
  let sourceChars = 0;
  let includedEvents = 0;
  let skippedEvents = 0;
  let droppedEvents = 0;
  const compactableLines = [];

  for (const ev of events) {
    const type = ev.type || "";
    if (type.startsWith("tool.output") || type.startsWith("stderr") || type.startsWith("tool.started")) {
      skippedEvents += 1;
      continue;
    }

    const role = kindToRole(ev.kind || ev.type || "");
    const text = ev.text || ev.payload?.text || "";
    if (!role && !text) {
      skippedEvents += 1;
      continue;
    }

    const line = `${role ? role + ": " : ""}${text}`;
    sourceChars += String(text).length;
    includedEvents += 1;
    compactableLines.push(line);
    if (maximumBufferedLines && compactableLines.length > maximumBufferedLines) {
      compactableLines.shift();
      droppedEvents += 1;
    }
  }

  const lines = [];
  let usedChars = 0;
  let truncated = droppedEvents > 0;
  for (let index = compactableLines.length - 1; index >= 0; index -= 1) {
    const line = compactableLines[index];
    const separatorChars = lines.length ? 1 : 0;
    const available = maximum - usedChars - separatorChars;
    if (available <= 0) {
      truncated = true;
      break;
    }
    if (line.length > available) {
      lines.unshift(line.slice(-available));
      truncated = true;
      break;
    }
    lines.unshift(line);
    usedChars += line.length + separatorChars;
  }

  const result = {
    text: lines.join("\n"),
    sourceChars,
    includedEvents,
    skippedEvents,
    droppedEvents,
    truncated
  };
  compactServiceMetrics.summaryInputsBuilt += 1;
  if (result.truncated) compactServiceMetrics.summaryInputTruncations += 1;
  compactServiceMetrics.summaryInputDroppedEvents += result.droppedEvents;
  compactServiceMetrics.summaryInputSourceChars += result.sourceChars;
  compactServiceMetrics.summaryInputChars += result.text.length;
  return result;
}

function observeCompactService(operation, { eventCount = 0, summaryRequest = false, compactedContext = false, nullResult = false, startedAt = 0 } = {}) {
  const elapsedMs = Math.max(0, performance.now() - startedAt);
  if (operation === "budget") compactServiceMetrics.budgetChecks += 1;
  if (operation === "compactTask") compactServiceMetrics.compactTaskCalls += 1;
  if (operation === "buildContext") compactServiceMetrics.buildContextCalls += 1;
  compactServiceMetrics.eventsChecked += eventCount;
  if (summaryRequest) compactServiceMetrics.summaryRequestsCreated += 1;
  if (compactedContext) compactServiceMetrics.compactedContextsReturned += 1;
  if (nullResult) compactServiceMetrics.nullResults += 1;
  compactServiceMetrics.totalMs += elapsedMs;
  compactServiceMetrics.lastMs = elapsedMs;
  compactServiceMetrics.maxMs = Math.max(compactServiceMetrics.maxMs, elapsedMs);
}

export function resetCompactServiceMetrics() {
  compactServiceMetrics.budgetChecks = 0;
  compactServiceMetrics.compactTaskCalls = 0;
  compactServiceMetrics.buildContextCalls = 0;
  compactServiceMetrics.eventsChecked = 0;
  compactServiceMetrics.summaryRequestsCreated = 0;
  compactServiceMetrics.compactedContextsReturned = 0;
  compactServiceMetrics.nullResults = 0;
  compactServiceMetrics.summaryInputsBuilt = 0;
  compactServiceMetrics.summaryInputTruncations = 0;
  compactServiceMetrics.summaryInputDroppedEvents = 0;
  compactServiceMetrics.summaryInputSourceChars = 0;
  compactServiceMetrics.summaryInputChars = 0;
  compactServiceMetrics.totalMs = 0;
  compactServiceMetrics.lastMs = 0;
  compactServiceMetrics.maxMs = 0;
}

export function getCompactServiceMetrics() {
  const calls = compactServiceMetrics.budgetChecks + compactServiceMetrics.compactTaskCalls + compactServiceMetrics.buildContextCalls;
  return {
    budgetChecks: compactServiceMetrics.budgetChecks,
    compactTaskCalls: compactServiceMetrics.compactTaskCalls,
    buildContextCalls: compactServiceMetrics.buildContextCalls,
    eventsChecked: compactServiceMetrics.eventsChecked,
    summaryRequestsCreated: compactServiceMetrics.summaryRequestsCreated,
    compactedContextsReturned: compactServiceMetrics.compactedContextsReturned,
    nullResults: compactServiceMetrics.nullResults,
    summaryInputsBuilt: compactServiceMetrics.summaryInputsBuilt,
    summaryInputTruncations: compactServiceMetrics.summaryInputTruncations,
    summaryInputDroppedEvents: compactServiceMetrics.summaryInputDroppedEvents,
    summaryInputSourceChars: compactServiceMetrics.summaryInputSourceChars,
    summaryInputChars: compactServiceMetrics.summaryInputChars,
    totalMs: Number(compactServiceMetrics.totalMs.toFixed(3)),
    lastMs: Number(compactServiceMetrics.lastMs.toFixed(3)),
    avgMs: calls > 0 ? Number((compactServiceMetrics.totalMs / calls).toFixed(3)) : 0,
    maxMs: Number(compactServiceMetrics.maxMs.toFixed(3))
  };
}

const SUMMARY_PROMPT = `Please provide a concise summary of the task so far. Focus on:
- What has been accomplished
- Key decisions made
- Current state / what remains
- Files changed or created (with paths)
- Tools used

Keep the summary under 300 words. Use the same language as the conversation.`;

/**
 * Check whether a task's event history exceeds the budget threshold.
 *
 * Returns:
 *   { shouldCompact, usedTokens, remainingTokens, percentUsed }
 */
export function checkTaskBudget(taskId, model = "", { total, threshold = 0.7, limit } = {}) {
  const startedAt = performance.now();
  let eventCount = 0;
  try {
    const budget = createTokenBudget(model, { total });
    const events = listTaskEvents(taskId, { after: 0, limit: resolveCompactEventLimit(limit) }) || [];
    eventCount = events.length;
    const report = checkBudget(budget, events);
    return {
      shouldCompact: report.percentUsed > threshold * 100,
      usedTokens: report.used,
      remainingTokens: report.remaining,
      percentUsed: report.percentUsed
    };
  } finally {
    observeCompactService("budget", { eventCount, startedAt });
  }
}

/**
 * Auto-compact a task: generate a summary event by asking the model
 * (via appendExternalTaskEvent) to compact the current history.
 *
 * This does NOT call the model itself — it schedules a summary event
 * that the next agent interaction can use. The summary is written as
 * a `summarization` event in the task event stream.
 *
 * Returns the summary event envelope.
 */
export async function compactTask(taskId, model = "", options = {}) {
  const startedAt = performance.now();
  let eventCount = 0;
  let summaryRequest = false;
  let nullResult = false;
  try {
    const budget = createTokenBudget(model, { total: options.total });
    const events = listTaskEvents(taskId, { after: 0, limit: resolveCompactEventLimit(options.limit) }) || [];
    eventCount = events.length;

    if (!events.length) {
      nullResult = true;
      return null;
    }

    const compactable = buildCompactSummaryInput(events, {
      maxChars: options.maxInputChars,
      maxBufferedLines: options.maxBufferedLines
    });

    if (!compactable.text.trim()) {
      nullResult = true;
      return null;
    }

    // Estimate how many tokens we need to free.
    const report = checkBudget(budget, events);
    const excessTokens = Math.max(0, report.used - budget.effective);

    // Write a summary request event.
    const summary = {
      type: "summarization",
      kind: "summary",
      text: SUMMARY_PROMPT,
      payload: {
        trigger: "auto_compact",
        eventCount: events.length,
        tokenEstimate: report.used,
        excessTokens,
        compactableLength: compactable.text.length,
        compactableSourceChars: compactable.sourceChars,
        compactableDroppedEvents: compactable.droppedEvents,
        compactableTruncated: compactable.truncated
      }
    };

    const cursor = appendExternalTaskEvent(taskId, summary);
    summaryRequest = true;
    return { ...summary, cursor };
  } finally {
    observeCompactService("compactTask", { eventCount, summaryRequest, nullResult, startedAt });
  }
}

function kindToRole(kind) {
  if (kind === "user" || kind === "user_message") return "user";
  if (kind === "assistant" || kind === "assistant_message") return "assistant";
  if (kind === "tool" || kind === "approval") return "system";
  return "";
}

/**
 * Build compacted context prompt for a task, injecting a summary
 * if one exists.
 */
export function buildCompactedContext(taskId, events = [], model = "") {
  const startedAt = performance.now();
  let compactedContext = false;
  let nullResult = false;
  try {
    const budget = createTokenBudget(model);
    const report = checkBudget(budget, events);

    if (report.fits) {
      nullResult = true;
      return null; // No compaction needed.
    }

    // Find the latest summary event.
    const summaries = events
      .filter((ev) => ev.type === "summarization" && ev.kind === "summary" && ev.payload?.trigger !== "auto_compact")
      .slice(-1);

    if (summaries.length > 0) {
      const summary = summaries[0];
      compactedContext = true;
      return {
        type: "compacted_context",
        text: summary.text || "",
        payload: {
          originalTokens: report.used,
          compacted: true,
          eventCount: events.length
        }
      };
    }

    nullResult = true;
    return null;
  } finally {
    observeCompactService("buildContext", { eventCount: events.length, compactedContext, nullResult, startedAt });
  }
}
