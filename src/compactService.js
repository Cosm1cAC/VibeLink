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
//   - Route B tasks have a predictable token footprint
//   - Restored tasks can start with a summary instead of full history
//   - The UI can display budget/headroom stats
//
// The actual summarization is delegated to the model itself via a
// compact prompt (auto-compact). This mirrors the Claude Code
// compact pattern where the assistant is asked to produce a "summary
// of what happened so far".

import { estimateEventsTokenCount, createTokenBudget, checkBudget } from "./contextBudget.js";
import { appendExternalTaskEvent } from "./agents.js";
import { listTaskEvents } from "./db.js";

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
export function checkTaskBudget(taskId, model = "", { total, threshold = 0.7 } = {}) {
  const budget = createTokenBudget(model, { total });
  const events = listTaskEvents(taskId, { after: 0, limit: 5000 }) || [];
  const report = checkBudget(budget, events);
  return {
    shouldCompact: report.percentUsed > threshold * 100,
    usedTokens: report.used,
    remainingTokens: report.remaining,
    percentUsed: report.percentUsed
  };
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
  const budget = createTokenBudget(model, { total: options.total });
  const events = listTaskEvents(taskId, { after: 0, limit: 5000 }) || [];

  if (!events.length) return null;

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

  if (!compactable.trim()) return null;

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
  return { ...summary, cursor };
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
  const budget = createTokenBudget(model);
  const report = checkBudget(budget, events);

  if (report.fits) return null; // No compaction needed.

  // Find the latest summary event.
  const summaries = events
    .filter((ev) => ev.type === "summarization" && ev.kind === "summary" && ev.payload?.trigger !== "auto_compact")
    .slice(-1);

  if (summaries.length > 0) {
    const summary = summaries[0];
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

  return null;
}
