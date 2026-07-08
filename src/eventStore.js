import crypto from "node:crypto";

export const DEFAULT_EVENT_REPLAY_LIMIT = 500;
export const MAX_EVENT_REPLAY_LIMIT = 5000;

function nowIso() {
  return new Date().toISOString();
}

function toJson(value) {
  return JSON.stringify(value ?? null);
}

function fromJson(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanString(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeEventReplayLimit(value, { defaultLimit = DEFAULT_EVENT_REPLAY_LIMIT, maxLimit = MAX_EVENT_REPLAY_LIMIT } = {}) {
  const requested = Number(value);
  const fallback = Math.max(1, Number(defaultLimit || DEFAULT_EVENT_REPLAY_LIMIT));
  const maximum = Math.max(1, Number(maxLimit || MAX_EVENT_REPLAY_LIMIT));
  if (!Number.isFinite(requested) || requested <= 0) return Math.min(fallback, maximum);
  return Math.min(Math.max(1, Math.floor(requested)), maximum);
}

export function classifyTaskEventKind(event = {}) {
  const type = String(event.type || "");
  if (type === "user_message" || type === "user" || type === "attachment") return "user";
  if (type === "assistant_message" || type === "assistant") return "assistant";
  if (type === "system") return "system";
  if (type === "error") return "error";
  if (type === "summarization") return "summary";
  if (type.startsWith("live_call.")) return "live_call";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("tool.")) return "tool";
  if (type === "stderr" || type === "stdout") return "output";
  return "system";
}

export function createSqliteEventStore({ database }) {
  if (typeof database !== "function") throw new TypeError("createSqliteEventStore requires a database function.");

  function withTransaction(callback) {
    const db = database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function insertTaskEvent(taskId, event = {}) {
    const current = nowIso();
    const eventAt = event.at || current;
    const eventId = event.id || `${taskId}:${eventAt}:${Math.random()}`;
    const payload = event.payload === undefined ? null : event.payload;
    const eventKind = event.kind || classifyTaskEventKind(event);
    const turnId = event.turnId || "";
    const blockId = event.blockId || "";
    const eventJson = { ...event, id: eventId, at: eventAt, kind: eventKind, turnId, blockId };
    const db = database();

    db.prepare(`
      INSERT OR IGNORE INTO task_events (
        task_id, event_id, event_type, event_at, text, payload_json, event_json,
        created_at, event_kind, turn_id, block_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      eventId,
      event.type || "",
      eventAt,
      typeof event.text === "string" ? event.text : "",
      toJson(payload),
      toJson(eventJson),
      current,
      eventKind,
      turnId,
      blockId
    );

    const row = db.prepare("SELECT cursor FROM task_events WHERE task_id = ? AND event_id = ?").get(taskId, eventId);
    return row?.cursor || null;
  }

  function insertTaskEvents(taskId, events = []) {
    if (!Array.isArray(events) || events.length === 0) return [];
    return withTransaction(() => events.map((event) => insertTaskEvent(taskId, event)));
  }

  function listTaskEvents(taskId, { after = 0, limit = DEFAULT_EVENT_REPLAY_LIMIT } = {}) {
    return database()
      .prepare(`
        SELECT cursor, event_json
        FROM task_events
        WHERE task_id = ? AND cursor > ?
        ORDER BY cursor ASC
        LIMIT ?
      `)
      .all(taskId, Number(after || 0), normalizeEventReplayLimit(limit))
      .map((row) => ({ ...fromJson(row.event_json, {}), cursor: row.cursor }));
  }

  function getTaskEventCount(taskId) {
    const row = database().prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?").get(taskId);
    return Number(row?.count || 0);
  }

  function insertToolEvent(toolRunId, event = {}) {
    const db = database();
    const run = db.prepare("SELECT * FROM tool_runs WHERE id = ?").get(toolRunId);
    if (!run) return null;
    const current = nowIso();
    const eventAt = event.at || current;
    const eventId = event.id || crypto.randomUUID();
    const payload = event.payload === undefined ? null : event.payload;
    const eventJson = {
      ...event,
      id: eventId,
      at: eventAt,
      toolRunId,
      taskId: event.taskId || run.task_id || "",
      workspaceId: event.workspaceId || run.workspace_id || ""
    };

    db.prepare(`
      INSERT OR IGNORE INTO tool_events (
        tool_run_id, task_id, workspace_id, event_id, event_type, event_at,
        text, payload_json, event_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      toolRunId,
      run.task_id || "",
      run.workspace_id || "",
      eventId,
      cleanString(event.type || "tool.event", 120),
      eventAt,
      typeof event.text === "string" ? event.text : "",
      toJson(payload),
      toJson(eventJson),
      current
    );

    const row = db.prepare("SELECT cursor FROM tool_events WHERE tool_run_id = ? AND event_id = ?").get(toolRunId, eventId);
    return row?.cursor || null;
  }

  function insertToolEvents(toolRunId, events = []) {
    if (!Array.isArray(events) || events.length === 0) return [];
    return withTransaction(() => events.map((event) => insertToolEvent(toolRunId, event)));
  }

  function listToolEvents({ toolRunId = "", workspaceId = "", taskId = "", after = 0, limit = DEFAULT_EVENT_REPLAY_LIMIT } = {}) {
    return database()
      .prepare(`
        SELECT cursor, event_json
        FROM tool_events
        WHERE cursor > ?
          AND (? = '' OR tool_run_id = ?)
          AND (? = '' OR workspace_id = ?)
          AND (? = '' OR task_id = ?)
        ORDER BY cursor ASC
        LIMIT ?
      `)
      .all(
        Number(after || 0),
        cleanString(toolRunId, 160),
        cleanString(toolRunId, 160),
        cleanString(workspaceId, 160),
        cleanString(workspaceId, 160),
        cleanString(taskId, 160),
        cleanString(taskId, 160),
        normalizeEventReplayLimit(limit)
      )
      .map((row) => ({ ...fromJson(row.event_json, {}), cursor: row.cursor }));
  }

  function getToolEventStats() {
    const row = database()
      .prepare(`
        SELECT
          COUNT(*) AS count,
          MIN(cursor) AS min_cursor,
          MAX(cursor) AS max_cursor,
          MIN(event_at) AS oldest_at,
          MAX(event_at) AS newest_at
        FROM tool_events
      `)
      .get();
    return {
      count: Number(row?.count || 0),
      minCursor: Number(row?.min_cursor || 0),
      maxCursor: Number(row?.max_cursor || 0),
      oldestAt: row?.oldest_at || "",
      newestAt: row?.newest_at || ""
    };
  }

  function pruneToolEvents({ before = "", keepLatest = 5000, dryRun = true } = {}) {
    const cutoff = before || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const keep = Math.max(0, Number(keepLatest || 0));
    const db = database();
    const thresholdRow = db.prepare("SELECT cursor FROM tool_events ORDER BY cursor DESC LIMIT 1 OFFSET ?").get(keep);
    const maxPrunableCursor = Number(thresholdRow?.cursor || 0);
    const countRow = db
      .prepare("SELECT COUNT(*) AS count FROM tool_events WHERE event_at < ? AND (? = 0 OR cursor <= ?)")
      .get(cutoff, maxPrunableCursor, maxPrunableCursor);
    const prunable = Number(countRow?.count || 0);
    if (!dryRun && prunable > 0) {
      db.prepare("DELETE FROM tool_events WHERE event_at < ? AND (? = 0 OR cursor <= ?)").run(cutoff, maxPrunableCursor, maxPrunableCursor);
    }
    return {
      cutoff,
      keepLatest: keep,
      maxPrunableCursor,
      prunable,
      deleted: dryRun ? 0 : prunable,
      dryRun: Boolean(dryRun),
      stats: getToolEventStats()
    };
  }

  function insertLiveCallEvent(sessionId, event = {}) {
    const db = database();
    const session = db.prepare("SELECT id FROM live_calls WHERE id = ?").get(sessionId);
    if (!session) return null;
    const current = nowIso();
    const eventAt = event.at || current;
    const eventId = event.id || crypto.randomUUID();
    const payload = event.payload === undefined ? null : event.payload;
    const eventJson = { ...event, id: eventId, at: eventAt, sessionId };

    db.prepare(`
      INSERT OR IGNORE INTO live_call_events (
        session_id, event_id, event_type, event_at,
        text, payload_json, event_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      eventId,
      cleanString(event.type || "live_call.event", 120),
      eventAt,
      typeof event.text === "string" ? event.text : "",
      toJson(payload),
      toJson(eventJson),
      current
    );

    const row = db.prepare("SELECT cursor FROM live_call_events WHERE session_id = ? AND event_id = ?").get(sessionId, eventId);
    return row?.cursor || null;
  }

  function insertLiveCallEvents(sessionId, events = []) {
    if (!Array.isArray(events) || events.length === 0) return [];
    return withTransaction(() => events.map((event) => insertLiveCallEvent(sessionId, event)));
  }

  function listLiveCallEvents({ sessionId = "", after = 0, limit = DEFAULT_EVENT_REPLAY_LIMIT } = {}) {
    if (!sessionId) return [];
    return database()
      .prepare(`
        SELECT cursor, event_json
        FROM live_call_events
        WHERE session_id = ?
          AND cursor > ?
        ORDER BY cursor ASC
        LIMIT ?
      `)
      .all(sessionId, Number(after || 0), normalizeEventReplayLimit(limit, { maxLimit: 2000 }))
      .map((row) => ({ ...fromJson(row.event_json, {}), cursor: row.cursor }));
  }

  function pruneLiveCallEvents({ retentionDays = 30, keepLatest = 5000 } = {}) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    try {
      database()
        .prepare("DELETE FROM live_call_events WHERE event_at < ? AND cursor NOT IN (SELECT cursor FROM live_call_events WHERE session_id IN (SELECT id FROM live_calls) ORDER BY cursor DESC LIMIT ?)")
        .run(cutoff, Number(keepLatest || 5000));
    } catch {}
  }

  function listUnifiedEvents({
    taskId = "",
    liveCallSessionId = "",
    toolRunId = "",
    after = 0,
    limit = 200
  } = {}) {
    const queryLimit = normalizeEventReplayLimit(limit, { defaultLimit: 200, maxLimit: 2000 });
    const afterCursor = Number(after || 0);
    const qtaskId = cleanString(taskId, 160);
    const qsessionId = cleanString(liveCallSessionId, 160);
    const qtoolRunId = cleanString(toolRunId, 160);
    const results = [];
    const db = database();

    if (!liveCallSessionId && !toolRunId) {
      const rows = db
        .prepare(`
          SELECT cursor, task_id, event_id, event_type, event_kind, turn_id, block_id,
                 event_at, text
          FROM task_events
          WHERE (? = '' OR task_id = ?) AND cursor > ?
          ORDER BY cursor ASC
          LIMIT ?
        `)
        .all(qtaskId, qtaskId, afterCursor, queryLimit);
      for (const row of rows) {
        results.push({
          cursor: row.cursor,
          eventId: row.event_id,
          type: row.event_type || "",
          kind: row.event_kind || "",
          at: row.event_at,
          text: row.text || "",
          sessionId: "",
          taskId: row.task_id || "",
          toolRunId: "",
          turnId: row.turn_id || "",
          blockId: row.block_id || ""
        });
      }
    }

    if (!liveCallSessionId) {
      const remaining = queryLimit - results.length;
      if (remaining > 0) {
        const rows = db
          .prepare(`
            SELECT cursor, task_id, tool_run_id, event_id, event_type, event_at, text
            FROM tool_events
            WHERE (? = '' OR task_id = ?) AND (? = '' OR tool_run_id = ?) AND cursor > ?
            ORDER BY cursor ASC
            LIMIT ?
          `)
          .all(qtaskId, qtaskId, qtoolRunId, qtoolRunId, afterCursor, remaining);
        for (const row of rows) {
          results.push({
            cursor: row.cursor,
            eventId: row.event_id,
            type: row.event_type,
            kind: "tool",
            at: row.event_at,
            text: row.text || "",
            sessionId: "",
            taskId: row.task_id || "",
            toolRunId: row.tool_run_id || "",
            turnId: "",
            blockId: ""
          });
        }
      }
    }

    if (!taskId && !toolRunId) {
      const remaining = queryLimit - results.length;
      if (remaining > 0) {
        const rows = db
          .prepare(`
            SELECT cursor, session_id, event_id, event_type, event_at, text
            FROM live_call_events
            WHERE (? = '' OR session_id = ?) AND cursor > ?
            ORDER BY cursor ASC
            LIMIT ?
          `)
          .all(qsessionId, qsessionId, afterCursor, remaining);
        for (const row of rows) {
          results.push({
            cursor: row.cursor,
            eventId: row.event_id,
            type: row.event_type,
            kind: "live_call",
            at: row.event_at,
            text: row.text || "",
            sessionId: row.session_id || "",
            taskId: "",
            toolRunId: "",
            turnId: "",
            blockId: ""
          });
        }
      }
    }

    results.sort((a, b) => a.cursor - b.cursor);
    return results.slice(0, queryLimit);
  }

  return {
    insertTaskEvent,
    insertTaskEvents,
    listTaskEvents,
    getTaskEventCount,
    insertToolEvent,
    insertToolEvents,
    listToolEvents,
    getToolEventStats,
    pruneToolEvents,
    insertLiveCallEvent,
    insertLiveCallEvents,
    listLiveCallEvents,
    pruneLiveCallEvents,
    listUnifiedEvents
  };
}
