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

function encodeReplayCursor(cursor, sourceRank) {
  return (Number(cursor || 0) * 10) + sourceRank;
}

function replayCursorParts(value) {
  const cursor = Math.max(0, Math.floor(Number(value || 0)));
  return {
    rawCursor: Math.floor(cursor / 10),
    sourceRank: cursor % 10
  };
}

export function createSqliteEventStore({ database }) {
  if (typeof database !== "function") throw new TypeError("createSqliteEventStore requires a database function.");
  try { database().exec(`CREATE TABLE IF NOT EXISTS event_acks (device_id TEXT NOT NULL, stream_id TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, event_id TEXT, acked_at TEXT NOT NULL, metadata_json TEXT, PRIMARY KEY(device_id, stream_id)); CREATE TABLE IF NOT EXISTS retention_policies (stream_id TEXT PRIMARY KEY, retention_days INTEGER NOT NULL DEFAULT 30, keep_latest INTEGER NOT NULL DEFAULT 5000, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS compaction_markers (marker_id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, from_cursor INTEGER NOT NULL, to_cursor INTEGER NOT NULL, compacted_at TEXT NOT NULL, metadata_json TEXT);`); } catch {}

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

  function normalizeStream(value) { return cleanString(value, 240); }
  function publicAck(row) {
    if (!row) return null;
    return { deviceId: row.device_id, streamId: row.stream_id, cursor: Number(row.cursor || 0), eventId: row.event_id || "", ackedAt: row.acked_at || "", metadata: fromJson(row.metadata_json, {}) || {} };
  }
  function upsertEventAck(deviceId, streamId, cursor = 0, options = {}) {
    const device = cleanString(deviceId, 160); const stream = normalizeStream(streamId);
    if (!device || !stream) throw new TypeError("deviceId and streamId are required.");
    const db = database(); const current = nowIso(); const next = Math.max(0, Math.floor(Number(cursor || 0)));
    db.prepare(`INSERT INTO event_acks (device_id, stream_id, cursor, event_id, acked_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, stream_id) DO UPDATE SET cursor = MAX(event_acks.cursor, excluded.cursor), event_id = excluded.event_id, acked_at = excluded.acked_at, metadata_json = excluded.metadata_json`).run(device, stream, next, cleanString(options.eventId, 240), current, toJson(options.metadata || {}));
    return publicAck(db.prepare("SELECT * FROM event_acks WHERE device_id = ? AND stream_id = ?").get(device, stream));
  }
  function getEventAck(deviceId, streamId) { return publicAck(database().prepare("SELECT * FROM event_acks WHERE device_id = ? AND stream_id = ?").get(deviceId, streamId)); }
  function listEventAcks({ deviceId = "", streamId = "" } = {}) {
    return database().prepare(`SELECT * FROM event_acks WHERE (? = '' OR device_id = ?) AND (? = '' OR stream_id = ?) ORDER BY stream_id, device_id`).all(deviceId, deviceId, streamId, streamId).map(publicAck);
  }
  function deleteDeviceEventAcks(deviceId) { return database().prepare("DELETE FROM event_acks WHERE device_id = ?").run(deviceId).changes; }
  function planRetention({ streamId = "", retentionDays = 30, keepLatest = 5000, now = Date.now() } = {}) {
    const normalizedStream = normalizeStream(streamId);
    const current = Number(now);
    const cutoff = new Date(current - Math.max(0, Number(retentionDays || 0)) * 86400000).toISOString();
    const db = database();
    const acks = normalizedStream
      ? db.prepare("SELECT device_id, cursor FROM event_acks WHERE stream_id = ? ORDER BY device_id").all(normalizedStream)
      : [];
    let activeDeviceIds = [];
    try {
      activeDeviceIds = db.prepare(`
        SELECT id FROM devices
        WHERE (revoked_at IS NULL OR revoked_at = '')
          AND (expires_at IS NULL OR expires_at = '' OR expires_at > ?)
        ORDER BY id
      `).all(new Date(current).toISOString()).map((row) => row.id);
    } catch {}
    const ackByDevice = new Map(acks.map((row) => [row.device_id, Number(row.cursor || 0)]));
    const blockedByDeviceIds = activeDeviceIds.filter((deviceId) => !ackByDevice.has(deviceId));
    const relevantCursors = activeDeviceIds.length
      ? activeDeviceIds.map((deviceId) => ackByDevice.get(deviceId)).filter(Number.isFinite)
      : acks.map((row) => Number(row.cursor || 0));
    const ackCursor = relevantCursors.length ? Math.min(...relevantCursors) : null;
    const safeCursor = blockedByDeviceIds.length || ackCursor == null ? null : Math.max(0, ackCursor);
    return {
      streamId: normalizedStream,
      cutoff,
      keepLatest: Math.max(0, Math.floor(Number(keepLatest || 0))),
      ackCursor,
      safeCursor,
      activeDeviceIds,
      blockedByDeviceIds
    };
  }
  function recordCompactionMarker({ markerId = crypto.randomUUID(), streamId, fromCursor = 0, toCursor = 0, metadata = {} } = {}) {
    const current = nowIso(); database().prepare("INSERT OR REPLACE INTO compaction_markers (marker_id, stream_id, from_cursor, to_cursor, compacted_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)").run(markerId, normalizeStream(streamId), Number(fromCursor || 0), Number(toCursor || 0), current, toJson(metadata));
    return { markerId, streamId: normalizeStream(streamId), fromCursor: Number(fromCursor || 0), toCursor: Number(toCursor || 0), compactedAt: current, metadata };
  }
  function listCompactionMarkers({ streamId = "", afterCursor = 0, limit = 100 } = {}) {
    return database().prepare("SELECT * FROM compaction_markers WHERE (? = '' OR stream_id = ?) AND to_cursor > ? ORDER BY to_cursor ASC LIMIT ?").all(streamId, streamId, Number(afterCursor || 0), Math.max(1, Math.min(1000, Number(limit || 100)))).map((row) => ({ markerId: row.marker_id, streamId: row.stream_id, fromCursor: row.from_cursor, toCursor: row.to_cursor, compactedAt: row.compacted_at, metadata: fromJson(row.metadata_json, {}) || {} }));
  }

  function compactEvents({ streamId, retentionDays = 30, keepLatest = 5000, spoolQuotaBytes = 0, now = Date.now(), dryRun = true } = {}) {
    const stream = normalizeStream(streamId);
    const match = /^(task|live-call|tool-event):(.+)$/.exec(stream);
    if (!match) throw new TypeError("streamId must use task:<id>, live-call:<id>, or tool-event:<id>.");
    const mappings = {
      task: { table: "task_events", key: "task_id" },
      "live-call": { table: "live_call_events", key: "session_id" },
      "tool-event": { table: "tool_events", key: "tool_run_id" }
    };
    const { table, key } = mappings[match[1]];
    const ownerId = cleanString(match[2], 160);
    if (!ownerId) throw new TypeError("streamId owner is required.");
    const plan = planRetention({ streamId: stream, retentionDays, keepLatest, now });
    const db = database();
    const quota = Math.max(0, Math.floor(Number(spoolQuotaBytes || 0)));
    const availableColumns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    const byteColumns = ["text", "payload_json", "event_json"].filter((column) => availableColumns.has(column));
    const byteExpression = byteColumns.map((column) => `LENGTH(COALESCE(${column}, ''))`).join(" + ") || "0";
    const retainedBytes = Number(db.prepare(`SELECT COALESCE(SUM(${byteExpression}), 0) AS bytes FROM ${table} WHERE ${key} = ?`).get(ownerId)?.bytes || 0);
    const quotaExceeded = quota > 0 && retainedBytes > quota;
    if (plan.safeCursor == null) {
      return { ...plan, retainedBytes, spoolQuotaBytes: quota, quotaExceeded, prunable: 0, deleted: 0, dryRun: Boolean(dryRun), marker: null };
    }
    const threshold = db.prepare(`SELECT cursor FROM ${table} WHERE ${key} = ? ORDER BY cursor DESC LIMIT 1 OFFSET ?`).get(ownerId, plan.keepLatest);
    const keepCursor = Number(threshold?.cursor || 0);
    const predicate = quotaExceeded
      ? `${key} = ? AND cursor <= ?`
      : `${key} = ? AND cursor <= ? AND event_at < ? AND (? = 0 OR (? > 0 AND cursor <= ?))`;
    const args = quotaExceeded
      ? [ownerId, plan.safeCursor]
      : [ownerId, plan.safeCursor, plan.cutoff, plan.keepLatest, keepCursor, keepCursor];
    const range = db.prepare(`SELECT COUNT(*) AS count, MIN(cursor) AS first_cursor, MAX(cursor) AS last_cursor FROM ${table} WHERE ${predicate}`).get(...args);
    const prunable = Number(range?.count || 0);
    let marker = null;
    if (!dryRun && prunable > 0) {
      withTransaction(() => {
        db.prepare(`DELETE FROM ${table} WHERE ${predicate}`).run(...args);
        marker = recordCompactionMarker({
          streamId: stream,
          fromCursor: Number(range.first_cursor || 0),
          toCursor: Number(range.last_cursor || 0),
          metadata: {
            reason: quotaExceeded ? "spool_quota" : "retention",
            deleted: prunable,
            retainedBytes,
            spoolQuotaBytes: quota
          }
        });
      });
    }
    return {
      ...plan,
      retainedBytes,
      spoolQuotaBytes: quota,
      quotaExceeded,
      prunable,
      deleted: dryRun ? 0 : prunable,
      dryRun: Boolean(dryRun),
      marker
    };
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

  function replayWindow(options = {}) {
    const limit = normalizeEventReplayLimit(options.limit, { defaultLimit: 200, maxLimit: 2000 });
    const queryLimit = limit + 1;
    const after = replayCursorParts(options.after);
    const qtaskId = cleanString(options.taskId, 160);
    const qsessionId = cleanString(options.liveCallSessionId, 160);
    const qtoolRunId = cleanString(options.toolRunId, 160);
    const items = [];
    const db = database();

    function minCursorFor(sourceRank) {
      return sourceRank > after.sourceRank ? after.rawCursor : after.rawCursor + 1;
    }

    if (!options.liveCallSessionId && !options.toolRunId) {
      const sourceRank = 1;
      const rows = db
        .prepare(`
          SELECT cursor, task_id, event_id, event_type, event_kind, turn_id, block_id,
                 event_at, text
          FROM task_events
          WHERE (? = '' OR task_id = ?) AND cursor >= ?
          ORDER BY cursor ASC
          LIMIT ?
        `)
        .all(qtaskId, qtaskId, minCursorFor(sourceRank), queryLimit);
      for (const row of rows) {
        items.push({
          cursor: encodeReplayCursor(row.cursor, sourceRank),
          rawCursor: row.cursor,
          eventId: row.event_id,
          type: row.event_type || "",
          kind: row.event_kind || "",
          at: row.event_at,
          text: row.text || "",
          sessionId: "",
          taskId: row.task_id || "",
          toolRunId: "",
          turnId: row.turn_id || "",
          blockId: ""
        });
      }
    }

    if (!options.liveCallSessionId) {
      const sourceRank = 2;
      const rows = db
        .prepare(`
          SELECT cursor, task_id, tool_run_id, event_id, event_type, event_at, text
          FROM tool_events
          WHERE (? = '' OR task_id = ?) AND (? = '' OR tool_run_id = ?) AND cursor >= ?
          ORDER BY cursor ASC
          LIMIT ?
        `)
        .all(qtaskId, qtaskId, qtoolRunId, qtoolRunId, minCursorFor(sourceRank), queryLimit);
      for (const row of rows) {
        items.push({
          cursor: encodeReplayCursor(row.cursor, sourceRank),
          rawCursor: row.cursor,
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

    if (!options.taskId && !options.toolRunId) {
      const sourceRank = 3;
      const rows = db
        .prepare(`
          SELECT cursor, session_id, event_id, event_type, event_at, text
          FROM live_call_events
          WHERE (? = '' OR session_id = ?) AND cursor >= ?
          ORDER BY cursor ASC
          LIMIT ?
        `)
        .all(qsessionId, qsessionId, minCursorFor(sourceRank), queryLimit);
      for (const row of rows) {
        items.push({
          cursor: encodeReplayCursor(row.cursor, sourceRank),
          rawCursor: row.cursor,
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

    items.sort((a, b) => a.cursor - b.cursor);
    const windowItems = items.slice(0, limit);
    const nextCursor = windowItems.length ? windowItems[windowItems.length - 1].cursor : Number(options.after || 0);
    return {
      items: windowItems,
      nextCursor,
      hasMore: items.length > windowItems.length,
      limit
    };
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
    listUnifiedEvents,
    replayWindow
    ,upsertEventAck, getEventAck, listEventAcks, deleteDeviceEventAcks, planRetention, compactEvents, recordCompactionMarker, listCompactionMarkers
  };
}

// Small repository facades keep persistence usable without exposing the event-store selector.
export function createEventAckRepository({ database }) {
  const store = createSqliteEventStore({ database });
  return { upsert: store.upsertEventAck, get: store.getEventAck, list: store.listEventAcks, removeDevice: store.deleteDeviceEventAcks };
}

export function createRetentionPlanner({ database }) {
  const store = createSqliteEventStore({ database });
  return { plan: store.planRetention, compact: store.compactEvents };
}

export function createCompactionMarkerRepository({ database }) {
  const store = createSqliteEventStore({ database });
  return { record: store.recordCompactionMarker, list: store.listCompactionMarkers };
}
