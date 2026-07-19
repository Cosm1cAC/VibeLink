const QUEUE_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);

function parseJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    priority: Number(row.priority || 0),
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 1),
    nextAttemptAt: row.next_attempt_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || "",
    completedAt: row.completed_at || "",
    lastError: row.last_error || "",
    payload: parseJson(row.payload_json, {}) || {}
  };
}

export function ensureTaskQueueSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_queue (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_attempt_at TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_queue_ready
      ON task_queue(status, next_attempt_at, priority DESC, created_at);
  `);
}

export function createTaskQueuePersistence({ database, now = () => new Date().toISOString() } = {}) {
  if (typeof database !== "function") throw new TypeError("database is required");
  let initialized = false;
  const db = () => {
    const value = database();
    if (!initialized) {
      ensureTaskQueueSchema(value);
      initialized = true;
    }
    return value;
  };
  const get = (id) => publicJob(db().prepare("SELECT * FROM task_queue WHERE id = ? OR task_id = ?").get(id, id));

  return {
    enqueue({ id, taskId, payload, priority = 0, maxAttempts = 3 }) {
      const at = now();
      db().prepare(`
        INSERT INTO task_queue (
          id, task_id, status, priority, attempts, max_attempts, next_attempt_at,
          payload_json, created_at, updated_at
        ) VALUES (?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?)
      `).run(id, taskId, Number(priority || 0), Math.max(1, Number(maxAttempts || 3)), at, JSON.stringify(payload || {}), at, at);
      return get(id);
    },
    get,
    list({ limit = 200 } = {}) {
      return db().prepare(`
        SELECT * FROM task_queue
        ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
          priority DESC, created_at DESC LIMIT ?
      `).all(Math.max(1, Math.min(1000, Number(limit || 200)))).map(publicJob);
    },
    counts() {
      const rows = db().prepare("SELECT status, COUNT(*) AS count FROM task_queue GROUP BY status").all();
      return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
    },
    recoverRunning({ preserveTaskIds = [] } = {}) {
      const at = now();
      const preserved = [...new Set(preserveTaskIds.filter(Boolean))];
      const exclusion = preserved.length ? ` AND task_id NOT IN (${preserved.map(() => "?").join(",")})` : "";
      return db().prepare(`
        UPDATE task_queue SET status = 'queued', next_attempt_at = ?, updated_at = ?,
          started_at = NULL, last_error = 'Bridge restarted while task was running.'
        WHERE status = 'running'${exclusion}
      `).run(at, at, ...preserved).changes;
    },
    claimNext() {
      const databaseValue = db();
      const at = now();
      databaseValue.exec("BEGIN IMMEDIATE");
      try {
        const row = databaseValue.prepare(`
          SELECT * FROM task_queue WHERE status = 'queued'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY priority DESC, created_at ASC LIMIT 1
        `).get(at);
        if (!row) {
          databaseValue.exec("COMMIT");
          return null;
        }
        databaseValue.prepare(`
          UPDATE task_queue SET status = 'running', attempts = attempts + 1,
            started_at = ?, updated_at = ?, next_attempt_at = NULL WHERE id = ? AND status = 'queued'
        `).run(at, at, row.id);
        databaseValue.exec("COMMIT");
        return get(row.id);
      } catch (error) {
        try { databaseValue.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    settle(id, { status, error = "", nextAttemptAt = "" } = {}) {
      if (!QUEUE_STATUSES.has(status)) throw new Error(`Invalid queue status: ${status}`);
      const at = now();
      const completedAt = ["completed", "failed", "cancelled"].includes(status) ? at : null;
      db().prepare(`
        UPDATE task_queue SET status = ?, updated_at = ?, completed_at = ?,
          next_attempt_at = ?, last_error = ? WHERE id = ?
      `).run(status, at, completedAt, nextAttemptAt || null, String(error || "").slice(0, 4000), id);
      return get(id);
    },
    retry(id) {
      const at = now();
      db().prepare(`
        UPDATE task_queue SET status = 'queued', attempts = 0, next_attempt_at = ?,
          completed_at = NULL, started_at = NULL, updated_at = ?, last_error = ''
        WHERE (id = ? OR task_id = ?) AND status IN ('failed', 'cancelled')
      `).run(at, at, id, id);
      const job = get(id);
      return job?.status === "queued" ? job : null;
    },
    cancel(id, { includeRunning = false } = {}) {
      const at = now();
      const statuses = includeRunning ? "('queued', 'running')" : "('queued')";
      db().prepare(`
        UPDATE task_queue SET status = 'cancelled', updated_at = ?, completed_at = ?, next_attempt_at = NULL
        WHERE (id = ? OR task_id = ?) AND status IN ${statuses}
      `).run(at, at, id, id);
      const job = get(id);
      return job?.status === "cancelled" ? job : null;
    }
  };
}
