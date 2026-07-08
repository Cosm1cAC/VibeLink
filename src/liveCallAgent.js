// Live Call Agent bridge.
//
// When `live_call.question.detected` is emitted from liveCall.js, we
// kick off a VibeLink Agent task via `createTask` and forward the agent's
// streaming output to the live-call SSE as `live_call.agent.delta` /
// `live_call.agent.done` events.
//
// The agent prompt is shaped for live-call interview assistance:
//   - Keep the answer short (<= 80 zh chars / <= 240 en chars)
//   - Speakable in a phone call (no markdown, no code blocks)
//   - Stay on topic; never invent facts about the user
//
// We rely on the in-process task event bus (`task.listeners`) — `agents.js`
// pushes every Claude stream-json event into that bus via `appendTaskEvent`,
// and `liveCallAgent.js` subscribes a callback that translates each event
// into a live-call SSE event.

import crypto from "node:crypto";
import {
  appendAgentTaskLiveCallDelta,
  attachAgentTaskToSession,
  emitLiveCallEvent,
  getInMemorySession
} from "./liveCall.js";
import {
  appendExternalTaskEvent,
  createTask,
  stopTask
} from "./agents.js";
import { listTaskEvents, resolveEventReplayLimit } from "./db.js";
import { buildCompactedContext } from "./compactService.js";

const SESSION_QUESTION_DEBOUNCE_MS = 1500;

const liveCallTasks = new Map(); // sessionId -> { taskId, lastQuestionAt, accumulated }

export function isLiveCallAgentEnabled() {
  return process.env.VIBELINK_LIVE_CALL_AGENT !== "0";
}

/**
 * Build the live-call interview prompt.
 * `question` is the latest final transcript detected by question pattern.
 * `history` is the recent transcript for context.
 */
function buildLiveCallPrompt(question, history) {
  const trimmedHistory = (history || []).slice(-6).map((entry) => `${entry.speaker || "remote"}: ${entry.text}`).join("\n");
  return [
    "你正在通过电话帮用户接听一场面试。对方刚刚提出了问题，你需要给出一个简短的、可以直接在电话里朗读出来的回答。",
    "",
    "硬性约束：",
    "- 回答长度不超过 80 个汉字或 240 个英文字符。",
    "- 不使用 Markdown、代码块、列表、表情或链接。",
    "- 不要编造用户简历/项目里没有的事实，只能基于对话上下文。",
    "- 如果信息不足以回答，先给一个保守的占位（例如：'我可以先讲一下相关的整体思路，等会儿再补充细节'）。",
    "- 始终使用与对话相同的语言（中文问题用中文，英文问题用英文）。",
    "",
    "最近的对话上下文：",
    trimmedHistory || "(无)",
    "",
    "现在请针对下面的问题给出一段适合在电话里朗读的简短回答：",
    question
  ].join("\n");
}

/**
 * Subscribe to a VibeLink Agent task's event stream and translate each event
 * into live-call SSE events. We do this by polling `listTaskEvents`
 * because `subscribeTask` returns an http.ServerResponse — not great
 * for an internal pipe. The poll interval is small enough to feel
 * streaming but cheap enough to ignore.
 */
function subscribeTaskForLiveCall(sessionId, taskId) {
  let after = 0;
  let stopped = false;
  let accumulator = "";

  const tick = async () => {
    if (stopped) return;
    try {
      const events = listTaskEvents(taskId, { after, limit: 200 }) || [];
      for (const event of events) {
        after = Math.max(after, Number(event.cursor || 0));
        const text = textFromAgentEvent(event);
        if (text) {
          accumulator += text;
          appendAgentTaskLiveCallDelta(sessionId, taskId, text, false);
        }
        if (event.type === "system" && /Exited with code 0/i.test(event.text || "")) {
          appendAgentTaskLiveCallDelta(sessionId, taskId, "", true, accumulator.trim());
          stopped = true;
          return;
        }
        if (event.type === "error" || (event.type === "system" && /Exited with code [1-9]/.test(event.text || ""))) {
          appendAgentTaskLiveCallDelta(sessionId, taskId, `[error] ${event.text || ""}`, true, accumulator.trim());
          stopped = true;
          return;
        }
      }
    } catch (error) {
      console.error("[liveCallAgent] poll failed:", error.message);
    }
    setTimeout(tick, 150);
  };
  setImmediate(tick);

  // Also listen directly to task listeners via appendExternalTaskEvent
  // — the task is in-memory (just created) so this fires synchronously.
  const session = getInMemorySession(sessionId);
  // We don't have a clean hook into `task.listeners` without exporting
  // it from agents.js. The polling loop above is sufficient.

  return {
    stop() { stopped = true; },
    accumulator: () => accumulator
  };
}

function textFromAgentEvent(event) {
  if (!event) return "";
  if (event.type === "json") {
    const payload = event.payload || {};
    // Claude stream-json with --include-partial-messages emits these shapes:
    //   { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
    //   { type: "content_block_start", content_block: { type: "text", text: "" } }
    //   { type: "message_delta", delta: { content: [{ type: "text", text: "..." }] } }
    //   { type: "message", message: { content: [{ type: "text", text: "..." }] } }
    // Codex JSONL:
    //   { type: "item", item: { type: "agent_message", text: "..." } }
    if (payload.delta?.text) return payload.delta.text;
    if (payload.delta?.content) {
      const parts = Array.isArray(payload.delta.content) ? payload.delta.content : [payload.delta.content];
      return parts.map((p) => p?.text || "").join("");
    }
    if (payload.item?.type === "agent_message" && payload.item.text) return payload.item.text;
    if (payload.message?.content) {
      const parts = Array.isArray(payload.message.content) ? payload.message.content : [payload.message.content];
      return parts.map((p) => p?.text || "").join("");
    }
    if (payload.content_block?.text) return payload.content_block.text;
    if (typeof payload.text === "string") return payload.text;
    return "";
  }
  if (event.type === "stdout" || event.type === "stderr") {
    return event.text || "";
  }
  return "";
}

/**
 * Try to dispatch a VibeLink Agent task for a detected question.
 * No-ops if the session is missing, the agent is disabled, or the question
 * is too close to the previous one (debounce).
 */
export async function dispatchLiveCallQuestion({ sessionId, question, history, settings, agent = "claude", model = "" }) {
  if (!isLiveCallAgentEnabled()) return null;
  const session = getInMemorySession(sessionId);
  if (!session) return null;

  const tracker = liveCallTasks.get(sessionId) || { lastQuestionAt: 0, accumulated: "" };
  const now = Date.now();
  if (now - tracker.lastQuestionAt < SESSION_QUESTION_DEBOUNCE_MS) return null;
  tracker.lastQuestionAt = now;
  liveCallTasks.set(sessionId, tracker);

  emitLiveCallEvent(sessionId, "live_call.agent.thinking", {
    question: String(question || "").slice(0, 400)
  });

  let task;
  try {
    // Inject compacted context if the event history is large.
    const events = listTaskEvents("", { after: 0, limit: resolveEventReplayLimit(undefined) }) || [];
    const compacted = buildCompactedContext("", events, model);
    const agentPrompt = compacted
      ? `${compacted.text}\n\n---\n\n${buildLiveCallPrompt(question, history)}\n\n(Note: the conversation above was compacted from ${compacted.payload?.eventCount || 0} previous events.)`
      : buildLiveCallPrompt(question, history);

    task = await createTask({
      agent,
      title: `Live Call Q: ${String(question || "").slice(0, 60)}`,
      prompt: agentPrompt,
      cwd: session.workspaceId ? undefined : process.cwd(),
      workspaceId: session.workspaceId || undefined,
      mode: "new",
      model: model || "",
      reasoningEffort: "low",
      permissionMode: "default",
      security: { networkAccess: false, sandboxMode: "workspace-write" }
    }, settings);
  } catch (error) {
    emitLiveCallEvent(sessionId, "live_call.agent.error", {
      error: String(error?.message || error),
      question: String(question || "").slice(0, 400)
    });
    return null;
  }

  attachAgentTaskToSession(sessionId, task.id);
  tracker.taskId = task.id;
  tracker.subscriber = subscribeTaskForLiveCall(sessionId, task.id);
  liveCallTasks.set(sessionId, tracker);
  return task.id;
}

export async function stopLiveCallAgentTask(sessionId) {
  const tracker = liveCallTasks.get(sessionId);
  if (!tracker) return;
  tracker.subscriber?.stop?.();
  if (tracker.taskId) {
    try { await stopTask(tracker.taskId); } catch {}
  }
  liveCallTasks.delete(sessionId);
}

export function getLiveCallTaskId(sessionId) {
  return liveCallTasks.get(sessionId)?.taskId || "";
}
