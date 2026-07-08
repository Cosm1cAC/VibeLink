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

const compactServiceMetrics = {
  budgetChecks: 0,
  compactTaskCalls: 0,
  buildContextCalls: 0,
  eventsChecked: 0,
  summaryRequestsCreated: 0,
  compactedContextsReturned: 0,
  nullResults: 0,
  totalMs: 0,
  lastMs: 0,
  maxMs: 0
};

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
    const events = listTaskEvents(taskId, { after: 0, limit: resolveEventReplayLimit(limit, { defaultLimit: 5000 }) }) || [];
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
    const events = listTaskEvents(taskId, { after: 0, limit: resolveEventReplayLimit(options.limit, { defaultLimit: 5000 }) }) || [];
    eventCount = events.length;

    if (!events.length) {
      nullResult = true;
      return null;
    }

    // Extract compactable text (skip binary/running tool output).
    const compactable = events
      .filter((ev) => {
        const type = ev.type || "";
        return !type.startsWith("tool.output") &&
               !type.startsWith("stderr") &&
               !type.startsWith("tool.started");
      })
      .map((ev) => {
        const role = kindToRole(ev.kind || ev.type || "");
        const text = ev.text || ev.payload?.text || "";
        if (!role && !text) return "";
        return `${role ? role + ": " : ""}${text}`;
      })
      .filter(Boolean)
      .join("\n");

    if (!compactable.trim()) {
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
        compactableLength: compactable.length
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
