const EXECUTION_KINDS = new Set(["terminal", "command", "provider.cli", "provider.appServer"]);
const EXECUTION_OWNERS = new Set(["execution-host", "legacy", "external"]);
const EXECUTION_STATUSES = new Set([
  "starting",
  "running",
  "awaiting_approval",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "lost",
  "outcome_unknown"
]);
const ATTACH_STATES = new Set(["attached", "reconnecting", "unreachable", "lost", "external"]);

export const EXECUTION_PERSISTENCE_SCHEMA_VERSION = 2026071701;
export const MAX_EXECUTION_EVENT_BYTES = 1024 * 1024;

function persistenceError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function cleanString(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function json(value) {
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

function boundedJson(value, maxBytes, code) {
  let serialized;
  try {
    serialized = json(value);
  } catch {
    throw persistenceError(code, "Value must be JSON serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw persistenceError(code, `JSON value exceeds ${maxBytes} bytes.`, { maxBytes });
  }
  return serialized;
}

function enumValue(value, allowed, field, fallback = "") {
  const normalized = cleanString(value, 80) || fallback;
  if (!allowed.has(normalized)) {
    throw persistenceError("EXECUTION_FIELD_INVALID", `Invalid ${field}.`, { field, value: normalized });
  }
  return normalized;
}

function nonNegativeInteger(value, field, fallback = 0) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw persistenceError("EXECUTION_FIELD_INVALID", `Invalid ${field}.`, { field });
  }
  return candidate;
}

function ensureColumn(db, table, name, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

export function ensureExecutionPersistenceSchema(db) {
  if (!db?.exec || !db?.prepare) throw new TypeError("A SQLite database is required.");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_bindings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        task_id TEXT,
        tool_run_id TEXT,
        provider TEXT,
        owner TEXT NOT NULL,
        status TEXT NOT NULL,
        attach_state TEXT NOT NULL,
        worker_pid INTEGER,
        process_pid INTEGER,
        process_started_at TEXT,
        worker_instance_id TEXT,
        protocol_version INTEGER NOT NULL DEFAULT 1,
        capabilities_json TEXT,
        last_seen_host_seq INTEGER NOT NULL DEFAULT 0,
        last_ingested_host_seq INTEGER NOT NULL DEFAULT 0,
        last_acked_host_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        lost_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_execution_bindings_status ON execution_bindings(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_execution_bindings_task ON execution_bindings(task_id);
      CREATE INDEX IF NOT EXISTS idx_execution_bindings_tool ON execution_bindings(tool_run_id);
      CREATE TABLE IF NOT EXISTS execution_host_events (
        execution_id TEXT NOT NULL,
        host_seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_at TEXT NOT NULL,
        payload_json TEXT,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(execution_id, host_seq),
        UNIQUE(execution_id, event_id),
        FOREIGN KEY(execution_id) REFERENCES execution_bindings(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS approval_outbox (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL UNIQUE,
        operation_id TEXT NOT NULL UNIQUE,
        continuation_ref TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        applied_at TEXT,
        last_error TEXT,
        FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_approval_outbox_ready
        ON approval_outbox(status, next_attempt_at, created_at);
    `);

    const approvalColumns = [
      ["provider", "TEXT"],
      ["thread_id", "TEXT"],
      ["turn_id", "TEXT"],
      ["item_id", "TEXT"],
      ["continuation_ref", "TEXT"],
      ["decision_version", "INTEGER NOT NULL DEFAULT 0"],
      ["delivery_status", "TEXT NOT NULL DEFAULT 'pending'"],
      ["requested_permissions_json", "TEXT"],
      ["available_decisions_json", "TEXT"]
    ];
    for (const [name, definition] of approvalColumns) {
      ensureColumn(db, "approval_requests", name, definition);
    }
    db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(EXECUTION_PERSISTENCE_SCHEMA_VERSION, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function publicBinding(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    taskId: row.task_id || "",
    toolRunId: row.tool_run_id || "",
    provider: row.provider || "",
    owner: row.owner,
    status: row.status,
    attachState: row.attach_state,
    workerPid: row.worker_pid ?? null,
    processPid: row.process_pid ?? null,
    processStartedAt: row.process_started_at || "",
    workerInstanceId: row.worker_instance_id || "",
    protocolVersion: Number(row.protocol_version || 1),
    capabilities: fromJson(row.capabilities_json, {}) || {},
    lastSeenHostSeq: Number(row.last_seen_host_seq || 0),
    lastIngestedHostSeq: Number(row.last_ingested_host_seq || 0),
    lastAckedHostSeq: Number(row.last_acked_host_seq || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at || "",
    exitCode: row.exit_code ?? null,
    signal: row.signal || "",
    lostReason: row.lost_reason || ""
  };
}

export function createExecutionPersistence({ database, now = () => new Date().toISOString() } = {}) {
  if (typeof database !== "function") throw new TypeError("A database function is required.");

  function getExecutionBinding(id) {
    return publicBinding(database().prepare("SELECT * FROM execution_bindings WHERE id = ?").get(cleanString(id, 160)));
  }

  function upsertExecutionBinding(input = {}) {
    const db = database();
    const id = cleanString(input.id, 160);
    if (!id) throw persistenceError("EXECUTION_ID_REQUIRED", "Execution id is required.");
    const existing = db.prepare("SELECT * FROM execution_bindings WHERE id = ?").get(id);
    const current = now();
    const kind = enumValue(input.kind ?? existing?.kind, EXECUTION_KINDS, "kind");
    const owner = enumValue(input.owner ?? existing?.owner, EXECUTION_OWNERS, "owner", "execution-host");
    const status = enumValue(input.status ?? existing?.status, EXECUTION_STATUSES, "status", "starting");
    const attachState = enumValue(
      input.attachState ?? existing?.attach_state,
      ATTACH_STATES,
      "attachState",
      owner === "external" ? "external" : "reconnecting"
    );
    const capabilities = boundedJson(input.capabilities ?? fromJson(existing?.capabilities_json, {}), 64 * 1024, "CAPABILITIES_TOO_LARGE");
    db.prepare(`
      INSERT INTO execution_bindings (
        id, kind, task_id, tool_run_id, provider, owner, status, attach_state,
        worker_pid, process_pid, process_started_at, worker_instance_id, protocol_version,
        capabilities_json, last_seen_host_seq, last_ingested_host_seq, last_acked_host_seq,
        created_at, updated_at, ended_at, exit_code, signal, lost_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, task_id=excluded.task_id, tool_run_id=excluded.tool_run_id,
        provider=excluded.provider, owner=excluded.owner, status=excluded.status,
        attach_state=excluded.attach_state, worker_pid=excluded.worker_pid,
        process_pid=excluded.process_pid, process_started_at=excluded.process_started_at,
        worker_instance_id=excluded.worker_instance_id, protocol_version=excluded.protocol_version,
        capabilities_json=excluded.capabilities_json, last_seen_host_seq=excluded.last_seen_host_seq,
        last_ingested_host_seq=excluded.last_ingested_host_seq,
        last_acked_host_seq=excluded.last_acked_host_seq, updated_at=excluded.updated_at,
        ended_at=excluded.ended_at, exit_code=excluded.exit_code, signal=excluded.signal,
        lost_reason=excluded.lost_reason
    `).run(
      id,
      kind,
      cleanString(input.taskId ?? existing?.task_id, 160),
      cleanString(input.toolRunId ?? existing?.tool_run_id, 160),
      cleanString(input.provider ?? existing?.provider, 80),
      owner,
      status,
      attachState,
      input.workerPid === null ? null : nonNegativeInteger(input.workerPid, "workerPid", existing?.worker_pid ?? 0) || null,
      input.processPid === null ? null : nonNegativeInteger(input.processPid, "processPid", existing?.process_pid ?? 0) || null,
      cleanString(input.processStartedAt ?? existing?.process_started_at, 80),
      cleanString(input.workerInstanceId ?? existing?.worker_instance_id, 160),
      nonNegativeInteger(input.protocolVersion, "protocolVersion", existing?.protocol_version ?? 1),
      capabilities,
      nonNegativeInteger(input.lastSeenHostSeq, "lastSeenHostSeq", existing?.last_seen_host_seq ?? 0),
      nonNegativeInteger(input.lastIngestedHostSeq, "lastIngestedHostSeq", existing?.last_ingested_host_seq ?? 0),
      nonNegativeInteger(input.lastAckedHostSeq, "lastAckedHostSeq", existing?.last_acked_host_seq ?? 0),
      existing?.created_at || input.createdAt || current,
      current,
      cleanString(input.endedAt ?? existing?.ended_at, 80),
      input.exitCode === null ? null : (input.exitCode ?? existing?.exit_code ?? null),
      cleanString(input.signal ?? existing?.signal, 80),
      cleanString(input.lostReason ?? existing?.lost_reason, 2000)
    );
    return getExecutionBinding(id);
  }

  function ingestExecutionEvent(executionId, event = {}) {
    const id = cleanString(executionId, 160);
    const hostSeq = nonNegativeInteger(event.hostSeq, "hostSeq");
    if (!id) throw persistenceError("EXECUTION_ID_REQUIRED", "Execution id is required.");
    if (hostSeq < 1) throw persistenceError("EXECUTION_FIELD_INVALID", "hostSeq must be positive.", { field: "hostSeq" });
    const eventId = cleanString(event.eventId, 200);
    const eventType = cleanString(event.type, 120);
    if (!eventId || !eventType) throw persistenceError("HOST_EVENT_INVALID", "Event id and type are required.");
    const eventAt = cleanString(event.at, 80) || now();
    const normalized = { executionId: id, hostSeq, eventId, type: eventType, at: eventAt, payload: event.payload ?? null };
    const eventJson = boundedJson(normalized, MAX_EXECUTION_EVENT_BYTES, "HOST_EVENT_TOO_LARGE");
    const payloadJson = boundedJson(normalized.payload, MAX_EXECUTION_EVENT_BYTES, "HOST_EVENT_TOO_LARGE");
    const db = database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const binding = db.prepare("SELECT * FROM execution_bindings WHERE id = ?").get(id);
      if (!binding) throw persistenceError("EXECUTION_NOT_FOUND", "Execution does not exist.", { executionId: id });
      const existing = db.prepare("SELECT event_id, event_json FROM execution_host_events WHERE execution_id = ? AND host_seq = ?")
        .get(id, hostSeq);
      if (existing) {
        if (existing.event_id !== eventId || existing.event_json !== eventJson) {
          throw persistenceError("HOST_EVENT_CONFLICT", "Host sequence already contains a different event.", { hostSeq });
        }
        db.exec("COMMIT");
        return { inserted: false, duplicate: true, hostSeq };
      }
      const expectedHostSeq = Number(binding.last_ingested_host_seq || 0) + 1;
      if (hostSeq !== expectedHostSeq) {
        const code = hostSeq > expectedHostSeq ? "HOST_SEQUENCE_GAP" : "HOST_SEQUENCE_REWIND";
        throw persistenceError(code, "Host sequence is not contiguous.", { hostSeq, expectedHostSeq });
      }
      db.prepare(`
        INSERT INTO execution_host_events (
          execution_id, host_seq, event_id, event_type, event_at, payload_json, event_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, hostSeq, eventId, eventType, eventAt, payloadJson, eventJson, now());
      db.prepare(`
        UPDATE execution_bindings
        SET last_seen_host_seq = ?, last_ingested_host_seq = ?, updated_at = ?
        WHERE id = ?
      `).run(hostSeq, hostSeq, now(), id);
      db.exec("COMMIT");
      return { inserted: true, duplicate: false, hostSeq };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function listExecutionEvents(executionId, { after = 0, limit = 500 } = {}) {
    const boundedLimit = Math.min(5000, Math.max(1, Math.floor(Number(limit) || 500)));
    return database().prepare(`
      SELECT event_json FROM execution_host_events
      WHERE execution_id = ? AND host_seq > ?
      ORDER BY host_seq ASC LIMIT ?
    `).all(cleanString(executionId, 160), nonNegativeInteger(after, "after"), boundedLimit)
      .map((row) => fromJson(row.event_json, {}));
  }

  function ackExecutionEvents(executionId, hostSeq) {
    const id = cleanString(executionId, 160);
    const acknowledged = nonNegativeInteger(hostSeq, "hostSeq");
    const db = database();
    const binding = db.prepare("SELECT * FROM execution_bindings WHERE id = ?").get(id);
    if (!binding) throw persistenceError("EXECUTION_NOT_FOUND", "Execution does not exist.", { executionId: id });
    if (acknowledged > Number(binding.last_ingested_host_seq || 0)) {
      throw persistenceError("HOST_ACK_AHEAD", "Cannot acknowledge events that are not ingested.", {
        hostSeq: acknowledged,
        lastIngestedHostSeq: Number(binding.last_ingested_host_seq || 0)
      });
    }
    if (acknowledged <= Number(binding.last_acked_host_seq || 0)) return getExecutionBinding(id);
    db.prepare("UPDATE execution_bindings SET last_acked_host_seq = ?, updated_at = ? WHERE id = ?")
      .run(acknowledged, now(), id);
    return getExecutionBinding(id);
  }

  return {
    getExecutionBinding,
    upsertExecutionBinding,
    ingestExecutionEvent,
    listExecutionEvents,
    ackExecutionEvents
  };
}
