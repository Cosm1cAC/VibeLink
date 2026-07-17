export const EXECUTION_PERSISTENCE_SCHEMA_VERSION = 2026071701;

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
