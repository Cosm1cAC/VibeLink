import crypto from "node:crypto";
import {
  createLiveCall as dbCreateLiveCall,
  getLiveCall as dbGetLiveCall,
  insertLiveCallEventAsync,
  listLiveCallEvents as dbListLiveCallEvents,
  listLiveCallEventsAsync as dbListLiveCallEventsAsync,
  listLiveCalls as dbListLiveCalls,
  updateLiveCall as dbUpdateLiveCall
} from "./db.js";

const sessions = new Map();
const subscribers = new Map();
const MAX_EVENTS = 500;
const QUESTION_PATTERN = /[?\uFF1F]|\u4EC0\u4E48|\u5982\u4F55|\u600E\u4E48|\u4E3A\u4EC0\u4E48|\u4ECB\u7ECD|\u7ECF\u9A8C|\u9879\u76EE|\u95EE\u9898|\u8BF7\u95EE|\u80FD\u5426|\u662F\u5426|\u600E\u6837|\u591A\u5C11|\u54EA\u91CC|\u54EA/;

function nowIso() {
  return new Date().toISOString();
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    title: session.title,
    source: session.source,
    workspaceId: session.workspaceId || session.workspace_id || "",
    agentTaskId: session.agentTaskId || session.agent_task_id || "",
    asrProvider: session.asrProvider || session.asr_provider || "",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    eventCursor: session.eventCursor || 0,
    remote: session.remote || { connected: false, bytes: 0, peak: 0, rms: 0, deviceName: "" },
    local: session.local || { connected: false, bytes: 0, peak: 0, rms: 0, deviceName: "" },
    lastTranscript: session.lastTranscript || "",
    lastQuestion: session.lastQuestion || "",
    lastAnswer: session.lastAnswer || ""
  };
}

function publicEvent(event) {
  return { ...event };
}

function pushEvent(session, type, payload = {}) {
  session.eventCursor = (session.eventCursor || 0) + 1;
  session.updatedAt = nowIso();
  const event = {
    id: `${session.id}:${session.eventCursor}`,
    cursor: session.eventCursor,
    type,
    at: session.updatedAt,
    sessionId: session.id,
    ...payload
  };
  session.events.push(event);
  if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS);

  // Persist to SQLite (best-effort; in-memory cache remains authoritative for SSE).
  try {
    insertLiveCallEventAsync(session.id, event).catch((error) => {
      console.error("[liveCall] event persist failed:", error.message);
    });
    dbUpdateLiveCall(session.id, {
      updatedAt: session.updatedAt,
      lastTranscript: session.lastTranscript || "",
      lastQuestion: session.lastQuestion || "",
      lastAnswer: session.lastAnswer || ""
    });
  } catch (error) {
    // Logging is best-effort; SSE fan-out must never break.
    console.error("[liveCall] persist failed:", error.message);
  }

  const listeners = subscribers.get(session.id) || new Set();
  for (const response of listeners) {
    try {
      response.write(`id: ${event.cursor}\n`);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(publicEvent(event))}\n\n`);
    } catch {
      listeners.delete(response);
    }
  }
  return event;
}

/**
 * Emit a structured event to all SSE subscribers of a session.
 * Used by liveCallAsr / liveCallAgent so they don't have to know
 * about SSE plumbing.
 */
export function emitLiveCallEvent(sessionId, type, payload = {}) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return pushEvent(session, type, payload);
}

/**
 * Append a streaming or final agent delta to the live-call SSE.
 * On the first non-empty delta we also mark the agent task id so the
 * panel can link to the underlying VibeLink Agent task.
 */
export function appendAgentTaskLiveCallDelta(sessionId, taskId, text, final = false, fullText = "") {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (!session.agentTaskId && taskId) {
    session.agentTaskId = taskId;
    dbUpdateLiveCall(sessionId, { agentTaskId: taskId });
  }
  if (final) {
    const answer = (fullText || text || "").trim();
    if (answer) {
      session.lastAnswer = answer;
      pushEvent(session, "live_call.agent.done", { text: answer, taskId: session.agentTaskId || taskId || "" });
    }
    return null;
  }
  if (!text) return null;
  return pushEvent(session, "live_call.agent.delta", { text, taskId: session.agentTaskId || taskId || "" });
}

export function createLiveCallSession(options = {}) {
  const current = nowIso();
  const id = crypto.randomUUID();
  const persisted = dbCreateLiveCall({
    id,
    status: "ready",
    title: String(options.title || "Live Call MVP").slice(0, 160),
    source: String(options.source || "windows-audio-probe").slice(0, 120),
    workspaceId: options.workspaceId || "",
    asrProvider: options.asrProvider || "",
    startedAt: current,
    meta: options.meta || null
  });
  const session = {
    id: persisted.id,
    status: persisted.status,
    title: persisted.title,
    source: persisted.source,
    workspaceId: persisted.workspaceId,
    agentTaskId: "",
    asrProvider: persisted.asrProvider,
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
    startedAt: persisted.startedAt,
    stoppedAt: persisted.stoppedAt,
    eventCursor: 0,
    remote: { connected: false, bytes: 0, peak: 0, rms: 0, deviceName: "" },
    local: { connected: false, bytes: 0, peak: 0, rms: 0, deviceName: "" },
    lastTranscript: "",
    lastQuestion: "",
    lastAnswer: "",
    events: []
  };
  sessions.set(session.id, session);
  pushEvent(session, "live_call.started", { session: publicSession(session) });
  return publicSession(session);
}

export function listLiveCallSessions() {
  // Fall back to DB if memory is empty (e.g., fresh process before any call was active).
  if (sessions.size === 0) {
    return dbListLiveCalls({ limit: 200 }).map((row) => ({
      ...row,
      remote: null,
      local: null,
      eventCursor: 0
    }));
  }
  return [...sessions.values()]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(publicSession);
}

export function getLiveCallSession(id) {
  const live = sessions.get(id);
  if (live) return publicSession(live);
  const persisted = dbGetLiveCall(id);
  if (!persisted) return null;
  return {
    ...persisted,
    remote: null,
    local: null,
    eventCursor: 0
  };
}

export function stopLiveCallSession(id, reason = "") {
  const session = sessions.get(id);
  if (!session) {
    // Make stopping idempotent across restart: just mark in DB.
    dbUpdateLiveCall(id, { status: "stopped", stoppedAt: nowIso() });
    return getLiveCallSession(id);
  }
  if (session.status !== "stopped") {
    session.status = "stopped";
    session.stoppedAt = nowIso();
    dbUpdateLiveCall(id, { status: "stopped", stoppedAt: session.stoppedAt });
    pushEvent(session, "live_call.stopped", { reason: String(reason || "manual") });
  }
  return publicSession(session);
}

export function pauseLiveCallSession(id, reason = "") {
  const session = sessions.get(id);
  if (!session) {
    dbUpdateLiveCall(id, { status: "paused" });
    return getLiveCallSession(id);
  }
  if (session.status !== "paused") {
    session.status = "paused";
    dbUpdateLiveCall(id, { status: "paused" });
    pushEvent(session, "live_call.paused", { reason: String(reason || "manual") });
  }
  return publicSession(session);
}

export function resumeLiveCallSession(id, reason = "") {
  const session = sessions.get(id);
  if (!session) {
    dbUpdateLiveCall(id, { status: "ready" });
    return getLiveCallSession(id);
  }
  if (session.status !== "ready" && session.status !== "active") {
    session.status = "ready";
    dbUpdateLiveCall(id, { status: "ready" });
    pushEvent(session, "live_call.resumed", { reason: String(reason || "manual") });
  }
  return publicSession(session);
}

export function recordLiveCallLevel(id, body = {}) {
  const session = sessions.get(id);
  if (!session) return null;
  const channel = body.channel === "local" ? "local" : "remote";
  const target = session[channel];
  target.connected = true;
  target.bytes = Number(body.bytes ?? target.bytes ?? 0);
  target.peak = Number(body.peak ?? target.peak ?? 0);
  target.rms = Number(body.rms ?? target.rms ?? 0);
  target.deviceName = String(body.deviceName || target.deviceName || "").slice(0, 240);
  pushEvent(session, "live_call.audio_level", { channel, level: { ...target } });
  return publicSession(session);
}

export function recordLiveCallTranscript(id, body = {}) {
  const session = sessions.get(id);
  if (!session) return null;
  const text = String(body.text || "").trim();
  if (!text) return publicSession(session);
  const final = Boolean(body.final ?? body.isFinal);
  session.lastTranscript = text;
  pushEvent(session, final ? "live_call.transcript.final" : "live_call.transcript.partial", {
    text,
    final,
    speaker: String(body.speaker || "remote").slice(0, 40)
  });
  if (final && QUESTION_PATTERN.test(text)) {
    session.lastQuestion = text;
    pushEvent(session, "live_call.question.detected", { text });
    // Fire-and-forget Live Call → VibeLink Agent dispatch. The function
    // self-guards against missing settings, disabled env, and rapid-fire
    // duplicate questions.
    if (session.questionDetectedHook) {
      try {
        session.questionDetectedHook(text, session);
      } catch (error) {
        console.error("[liveCall] question hook failed:", error.message);
      }
    }
  }
  return publicSession(session);
}

/**
 * Set a callback to be invoked whenever a question is detected on a session.
 * Used by the Live Call agent bridge (liveCallAgent.js) to dispatch tasks.
 * Returns a teardown function.
 */
export function setLiveCallQuestionHook(sessionId, hook) {
  const session = sessions.get(sessionId);
  if (!session) return () => {};
  session.questionDetectedHook = hook;
  return () => {
    const current = sessions.get(sessionId);
    if (current && current.questionDetectedHook === hook) delete current.questionDetectedHook;
  };
}

export function recordLiveCallAnswer(id, body = {}) {
  const session = sessions.get(id);
  if (!session) return null;
  const text = String(body.text || "").trim();
  if (!text) return publicSession(session);
  session.lastAnswer = text;
  pushEvent(session, "live_call.agent.done", { text });
  return publicSession(session);
}

export function listLiveCallEvents(id, { after = 0, limit = 200 } = {}) {
  const session = sessions.get(id);
  if (session) {
    return session.events
      .filter((event) => Number(event.cursor || 0) > Number(after || 0))
      .slice(0, Math.max(1, Math.min(Number(limit || 200), 500)))
      .map(publicEvent);
  }
  // Fall back to DB for stopped sessions across restart.
  return dbListLiveCallEvents({ sessionId: id, after, limit });
}

export async function listLiveCallEventsReplay(id, { after = 0, limit = 200 } = {}) {
  if (!sessions.has(id) && !dbGetLiveCall(id)) return null;
  const events = await dbListLiveCallEventsAsync({ sessionId: id, after, limit });
  if (events.length || !sessions.has(id)) return events.map(publicEvent);
  return listLiveCallEvents(id, { after, limit });
}

export async function subscribeLiveCallEvents(id, response, { after = 0 } = {}) {
  const session = sessions.get(id) || dbGetLiveCall(id);
  if (!session) return false;
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.write(`retry: 1500\n\n`);
  const events = await listLiveCallEventsReplay(id, { after, limit: MAX_EVENTS }) || [];
  for (const event of events) {
    response.write(`id: ${event.cursor}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  // Only keep live SSE subscribers on in-memory sessions; replay-only
  // subscriptions for stopped sessions don't need ongoing updates.
  if (sessions.has(id)) {
    let listeners = subscribers.get(id);
    if (!listeners) {
      listeners = new Set();
      subscribers.set(id, listeners);
    }
    listeners.add(response);
    response.on("close", () => listeners.delete(response));
  } else {
    response.on("close", () => {});
  }
  return true;
}

/**
 * Restore active (non-stopped) sessions from DB into memory on startup.
 * Cursor is reconstructed from the latest event in live_call_events.
 */
export function restoreLiveCallSessions() {
  const rows = dbListLiveCalls({ limit: 500 });
  const restoredIds = [];
  for (const row of rows) {
    if (row.status === "stopped") continue;
    const events = dbListLiveCallEvents({ sessionId: row.id, after: 0, limit: MAX_EVENTS });
    const lastCursor = events.reduce((max, ev) => Math.max(max, Number(ev.cursor || 0)), 0);
    sessions.set(row.id, {
      id: row.id,
      status: row.status,
      title: row.title,
      source: row.source,
      workspaceId: row.workspaceId,
      agentTaskId: row.agentTaskId,
      asrProvider: row.asrProvider,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt,
      eventCursor: lastCursor,
      remote: { connected: false, bytes: 0, peak: 0, rms: 0, deviceName: "" },
      local: { connected: false, bytes: 0, peak: 0, rms: 0, deviceName: "" },
      lastTranscript: row.lastTranscript,
      lastQuestion: row.lastQuestion,
      lastAnswer: row.lastAnswer,
      events
    });
    restoredIds.push(row.id);
  }
  return restoredIds;
}

/**
 * Allow other modules (liveCallAsr / liveCallAgent) to attach a task to a session.
 * Returns the in-memory session for direct manipulation.
 */
export function attachAgentTaskToSession(sessionId, taskId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.agentTaskId = taskId;
  dbUpdateLiveCall(sessionId, { agentTaskId: taskId });
  return session;
}

export function getInMemorySession(sessionId) {
  return sessions.get(sessionId) || null;
}

export function getSubscribers() {
  return subscribers;
}
