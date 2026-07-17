import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "./config.js";
import { createEventStoreBatcher } from "./eventStoreBatcher.js";
import { DEFAULT_EVENT_REPLAY_LIMIT, createSqliteEventStore, normalizeEventReplayLimit } from "./eventStore.js";
import { EVENT_STORE_CONTRACT_METHODS, EVENT_STORE_SIDECAR_PROTOCOL_VERSION } from "./eventStoreContract.js";
import { createEventStoreMetrics } from "./eventStoreMetrics.js";
import { createEventStoreSidecarClient } from "./eventStoreSidecarClient.js";
import { createEventStoreWorkerClient } from "./eventStoreWorkerClient.js";
import { createApprovalOutboxPersistence } from "./approvalOutbox.js";
import { createExecutionPersistence, ensureExecutionPersistenceSchema } from "./executionPersistence.js";

const dbPath = path.join(dataDir, "mobile-agent.sqlite");

let db = null;

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

function boolInt(value) {
  return value ? 1 : 0;
}

function rowBool(value) {
  return Boolean(Number(value || 0));
}

function cleanString(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function addDays(days) {
  return new Date(Date.now() + Number(days || 0) * 24 * 60 * 60 * 1000).toISOString();
}

function publicDevice(row) {
  if (!row) return null;
  const expiresAt = row.expires_at || "";
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at || "",
    revokedAt: row.revoked_at || "",
    expiresAt,
    rotatedAt: row.rotated_at || "",
    expired: Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now()),
    meta: fromJson(row.meta_json, {}) || {}
  };
}

function pairingCodeHash(id, code) {
  return hashToken(`${id}:${String(code || "").trim().toUpperCase()}`);
}

export function initDb() {
  if (db) return db;

  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      allowed_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT,
      expires_at TEXT,
      rotated_at TEXT,
      meta_json TEXT
    );

    CREATE TABLE IF NOT EXISTS pairing_sessions (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      label TEXT,
      ip TEXT,
      user_agent TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      approved_by_device_id TEXT,
      claimed_at TEXT,
      device_id TEXT,
      meta_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pairing_sessions_status_expires ON pairing_sessions(status, expires_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      device_id TEXT,
      ip TEXT,
      user_agent TEXT,
      method TEXT,
      path TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      target TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_cursor ON audit_log(cursor);
    CREATE INDEX IF NOT EXISTS idx_audit_log_event_at ON audit_log(event_at);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      device_id TEXT,
      endpoint TEXT NOT NULL UNIQUE,
      subscription_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS threads (
      key TEXT PRIMARY KEY,
      provider TEXT,
      session_id TEXT,
      workspace_id TEXT,
      title TEXT,
      group_name TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'local',
      meta_json TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      field_revisions_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_forks (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT,
      group_name TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT,
      workspace_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      exit_code INTEGER,
      session_id TEXT,
      command_label TEXT,
      log_path TEXT,
      meta_json TEXT
    );

    CREATE TABLE IF NOT EXISTS task_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT,
      event_at TEXT NOT NULL,
      text TEXT,
      payload_json TEXT,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, event_id),
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_events_task_cursor ON task_events(task_id, cursor);

    CREATE TABLE IF NOT EXISTS tool_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      workspace_id TEXT,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT,
      input_json TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tool_runs_updated ON tool_runs(updated_at);
    CREATE INDEX IF NOT EXISTS idx_tool_runs_workspace ON tool_runs(workspace_id, updated_at);

    CREATE TABLE IF NOT EXISTS tool_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_run_id TEXT NOT NULL,
      task_id TEXT,
      workspace_id TEXT,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      text TEXT,
      payload_json TEXT,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tool_run_id, event_id),
      FOREIGN KEY(tool_run_id) REFERENCES tool_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tool_events_tool_cursor ON tool_events(tool_run_id, cursor);
    CREATE INDEX IF NOT EXISTS idx_tool_events_workspace_cursor ON tool_events(workspace_id, cursor);

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      tool_run_id TEXT,
      task_id TEXT,
      workspace_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT,
      reason TEXT,
      request_json TEXT,
      risk_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      decided_at TEXT,
      decided_by_device_id TEXT,
      decision_reason TEXT,
      decision_json TEXT,
      FOREIGN KEY(tool_run_id) REFERENCES tool_runs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_approval_requests_tool ON approval_requests(tool_run_id);

    CREATE TABLE IF NOT EXISTS approval_decisions (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      tool_run_id TEXT,
      task_id TEXT,
      workspace_id TEXT,
      decision TEXT NOT NULL,
      reason TEXT,
      device_id TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_approval_decisions_approval ON approval_decisions(approval_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_approval_decisions_workspace ON approval_decisions(workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS desktop_observations (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'desktop.snapshot',
      workspace_id TEXT,
      observed_at TEXT NOT NULL,
      hash TEXT NOT NULL,
      found INTEGER NOT NULL DEFAULT 0,
      ready INTEGER NOT NULL DEFAULT 0,
      running_count INTEGER NOT NULL DEFAULT 0,
      transcript_count INTEGER NOT NULL DEFAULT 0,
      observation_json TEXT NOT NULL,
      event_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_desktop_observations_cursor ON desktop_observations(cursor);
    CREATE INDEX IF NOT EXISTS idx_desktop_observations_hash ON desktop_observations(hash);

    CREATE TABLE IF NOT EXISTS desktop_remote_queue (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      permission_mode TEXT,
      model TEXT,
      reasoning_effort TEXT,
      settings_policy TEXT,
      target_json TEXT,
      settings_check_json TEXT,
      restore_check_json TEXT,
      preflight_json TEXT,
      postflight_json TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_desktop_remote_queue_updated ON desktop_remote_queue(updated_at);

    CREATE TABLE IF NOT EXISTS settings_kv (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS live_calls (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      workspace_id TEXT,
      agent_task_id TEXT,
      asr_provider TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      stopped_at TEXT,
      last_transcript TEXT,
      last_question TEXT,
      last_answer TEXT,
      meta_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_live_calls_updated ON live_calls(updated_at);
    CREATE INDEX IF NOT EXISTS idx_live_calls_workspace ON live_calls(workspace_id, updated_at);

    CREATE TABLE IF NOT EXISTS live_call_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      text TEXT,
      payload_json TEXT,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_live_call_events_session_cursor ON live_call_events(session_id, cursor);
    CREATE INDEX IF NOT EXISTS idx_live_call_events_session_at ON live_call_events(session_id, event_at);

    CREATE TABLE IF NOT EXISTS mcp_tools (
      server_name TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      full_name TEXT NOT NULL PRIMARY KEY,
      title TEXT,
      description TEXT,
      input_schema TEXT,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  try { db.exec("ALTER TABLE tasks ADD COLUMN workspace_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE desktop_observations ADD COLUMN workspace_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE desktop_observations ADD COLUMN event_type TEXT NOT NULL DEFAULT 'desktop.snapshot'"); } catch {}
  try { db.exec("ALTER TABLE desktop_observations ADD COLUMN event_json TEXT"); } catch {}
  try { db.exec("ALTER TABLE devices ADD COLUMN expires_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE devices ADD COLUMN rotated_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE devices ADD COLUMN meta_json TEXT"); } catch {}
  try { db.exec("ALTER TABLE tool_runs ADD COLUMN workspace_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE tool_events ADD COLUMN workspace_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE approval_requests ADD COLUMN workspace_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE task_events ADD COLUMN event_kind TEXT"); } catch {}
  try { db.exec("ALTER TABLE task_events ADD COLUMN turn_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE task_events ADD COLUMN block_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE threads ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE threads ADD COLUMN field_revisions_json TEXT"); } catch {}
  ensureExecutionPersistenceSchema(db);

  return db;
}

function database() {
  return initDb();
}

let executionPersistence = null;
let approvalOutboxPersistence = null;

function executionPersistenceStore() {
  if (!executionPersistence) executionPersistence = createExecutionPersistence({ database });
  return executionPersistence;
}

function approvalOutboxStore() {
  if (!approvalOutboxPersistence) approvalOutboxPersistence = createApprovalOutboxPersistence({ database });
  return approvalOutboxPersistence;
}

let eventStore = null;

function sqliteEventStore() {
  if (!eventStore) eventStore = createSqliteEventStore({ database });
  return eventStore;
}

let eventStoreWorker = null;
let eventStoreWorkerFailed = false;
let eventStoreRustSidecar = null;
let eventStoreRustSidecarFailed = false;
let eventStoreRustSidecarReady = false;
let taskEventAppendBatcher = null;
let toolEventAppendBatcher = null;
let liveCallEventAppendBatcher = null;
const eventStoreMetrics = createEventStoreMetrics();
const eventStoreRustSidecarStats = {
  starts: 0,
  failures: 0,
  fallbacks: 0,
  lastFailureAt: "",
  lastError: ""
};

export function isEventStoreRustSidecarEnabled() {
  const mode = String(process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR || "").trim().toLowerCase();
  if (mode === "1" || mode === "true") return true;
  if (mode === "auto") return eventStoreRustSidecarAvailable();
  return false;
}

function isEventStoreRustSidecarAuto() {
  return String(process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR || "").trim().toLowerCase() === "auto";
}

export function isEventStoreWorkerEnabled() {
  return process.env.VIBELINK_EVENT_STORE_WORKER === "1";
}

export function isEventStoreBatchAppendEnabled() {
  return process.env.VIBELINK_EVENT_STORE_BATCH_APPEND === "1";
}

export function isLiveCallEventBatchAppendEnabled() {
  return process.env.VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND === "1";
}

export function isTaskEventBatchAppendEnabled() {
  return process.env.VIBELINK_EVENT_STORE_BATCH_TASK_APPEND === "1";
}

export function eventStoreMode() {
  if (isEventStoreRustSidecarEnabled()) {
    if (!eventStoreRustSidecarFailed) return "rust-sidecar";
    if (!isEventStoreWorkerEnabled()) return "sync-fallback";
    return eventStoreWorkerFailed ? "sync-fallback" : "worker-fallback";
  }
  if (!isEventStoreWorkerEnabled()) return "sync";
  return eventStoreWorkerFailed ? "sync-fallback" : "worker";
}

function eventStoreRustSidecarCommand() {
  if (process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND) {
    return process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND;
  }
  return path.join(
    process.cwd(),
    "apps",
    "windows",
    "target",
    "debug",
    process.platform === "win32" ? "vibelink.exe" : "vibelink"
  );
}

function eventStoreRustSidecarAvailable() {
  try {
    return fs.existsSync(eventStoreRustSidecarCommand());
  } catch {
    return false;
  }
}

function eventStoreRustSidecarArgs() {
  if (!process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON) return ["event-store-sidecar"];
  try {
    const parsed = JSON.parse(process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON);
    return Array.isArray(parsed) ? parsed.map(String) : ["event-store-sidecar"];
  } catch {
    return ["event-store-sidecar"];
  }
}

function eventStoreRustSidecarTimeoutMs() {
  const value = Number(process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_TIMEOUT_MS || 10000);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10000;
}

function eventStoreRustSidecarMaxPendingRequests() {
  const value = Number(
    process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_MAX_PENDING_REQUESTS ||
    process.env.VIBELINK_EVENT_STORE_SIDECAR_MAX_PENDING_REQUESTS
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 128;
}

function eventStoreWorkerMaxPendingRequests() {
  const value = Number(process.env.VIBELINK_EVENT_STORE_WORKER_MAX_PENDING_REQUESTS);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return 128;
}

function eventStoreRustSidecarClient() {
  if (!isEventStoreRustSidecarEnabled() || eventStoreRustSidecarFailed) return null;
  initDb();
  if (!eventStoreRustSidecar) {
    eventStoreRustSidecar = createEventStoreSidecarClient({
      command: eventStoreRustSidecarCommand(),
      args: [...eventStoreRustSidecarArgs(), dbPath],
      timeoutMs: eventStoreRustSidecarTimeoutMs(),
      maxPendingRequests: eventStoreRustSidecarMaxPendingRequests()
    });
    eventStoreRustSidecarStats.starts += 1;
  }
  return eventStoreRustSidecar;
}

function getEventStoreRustSidecarStats() {
  const auto = isEventStoreRustSidecarAuto();
  const available = auto ? eventStoreRustSidecarAvailable() : true;
  return {
    enabled: isEventStoreRustSidecarEnabled(),
    auto,
    available,
    active: Boolean(eventStoreRustSidecar),
    ready: eventStoreRustSidecarReady,
    failed: eventStoreRustSidecarFailed,
    command: isEventStoreRustSidecarEnabled() ? eventStoreRustSidecarCommand() : "",
    args: isEventStoreRustSidecarEnabled() ? [...eventStoreRustSidecarArgs(), dbPath] : [],
    starts: eventStoreRustSidecarStats.starts,
    failures: eventStoreRustSidecarStats.failures,
    fallbacks: eventStoreRustSidecarStats.fallbacks,
    lastFailureAt: eventStoreRustSidecarStats.lastFailureAt,
    lastError: eventStoreRustSidecarStats.lastError,
    client: eventStoreRustSidecar?.stats() || { pending: 0, terminated: true }
  };
}

function getEventStoreWorkerStats() {
  const stats = eventStoreWorker?.stats?.();
  return {
    enabled: isEventStoreWorkerEnabled(),
    active: Boolean(eventStoreWorker),
    failed: eventStoreWorkerFailed,
    pending: stats?.pending ?? 0,
    maxPendingRequests: stats?.maxPendingRequests ?? eventStoreWorkerMaxPendingRequests()
  };
}

export function getEventStoreRuntimeStats() {
  return {
    mode: eventStoreMode(),
    rustSidecarEnabled: isEventStoreRustSidecarEnabled(),
    rustSidecarFailed: eventStoreRustSidecarFailed,
    rustSidecar: getEventStoreRustSidecarStats(),
    workerEnabled: isEventStoreWorkerEnabled(),
    workerFailed: eventStoreWorkerFailed,
    worker: getEventStoreWorkerStats(),
    taskBatchAppend: getTaskEventBatchAppendStats(),
    batchAppend: getToolEventBatchAppendStats(),
    liveCallBatchAppend: getLiveCallEventBatchAppendStats(),
    metrics: eventStoreMetrics.snapshot()
  };
}

function eventStoreBatchDelayMs() {
  const value = Number(process.env.VIBELINK_EVENT_STORE_BATCH_DELAY_MS || 50);
  return Number.isFinite(value) && value >= 0 ? value : 50;
}

function eventStoreBatchMaxSize() {
  const value = Number(process.env.VIBELINK_EVENT_STORE_BATCH_MAX_SIZE || 100);
  return Number.isFinite(value) && value >= 0 ? value : 100;
}

function toolEventBatcher() {
  if (!toolEventAppendBatcher) {
    toolEventAppendBatcher = createEventStoreBatcher({
      delayMs: eventStoreBatchDelayMs(),
      maxBatchSize: eventStoreBatchMaxSize(),
      flushBatch: (toolRunId, events) => insertToolEventsAsync(toolRunId, events)
    });
  }
  return toolEventAppendBatcher;
}

function taskEventBatcher() {
  if (!taskEventAppendBatcher) {
    taskEventAppendBatcher = createEventStoreBatcher({
      delayMs: eventStoreBatchDelayMs(),
      maxBatchSize: eventStoreBatchMaxSize(),
      flushBatch: (taskId, events) => insertTaskEventsAsync(taskId, events)
    });
  }
  return taskEventAppendBatcher;
}

function liveCallEventBatcher() {
  if (!liveCallEventAppendBatcher) {
    liveCallEventAppendBatcher = createEventStoreBatcher({
      delayMs: eventStoreBatchDelayMs(),
      maxBatchSize: eventStoreBatchMaxSize(),
      flushBatch: (sessionId, events) => insertLiveCallEventsAsync(sessionId, events)
    });
  }
  return liveCallEventAppendBatcher;
}

function getTaskEventBatchAppendStats() {
  const stats = taskEventAppendBatcher?.stats() || {
    pending: 0,
    flushes: 0,
    totalEvents: 0,
    avgBatchSize: 0,
    maxBatchSize: 0,
    lastFlushDurationMs: 0,
    avgFlushDurationMs: 0,
    lastFlushAt: ""
  };
  return {
    enabled: isTaskEventBatchAppendEnabled(),
    ...stats
  };
}

function getToolEventBatchAppendStats() {
  const stats = toolEventAppendBatcher?.stats() || {
    pending: 0,
    flushes: 0,
    totalEvents: 0,
    avgBatchSize: 0,
    maxBatchSize: 0,
    lastFlushDurationMs: 0,
    avgFlushDurationMs: 0,
    lastFlushAt: ""
  };
  return {
    enabled: isEventStoreBatchAppendEnabled(),
    ...stats
  };
}

function getLiveCallEventBatchAppendStats() {
  const stats = liveCallEventAppendBatcher?.stats() || {
    pending: 0,
    flushes: 0,
    totalEvents: 0,
    avgBatchSize: 0,
    maxBatchSize: 0,
    lastFlushDurationMs: 0,
    avgFlushDurationMs: 0,
    lastFlushAt: ""
  };
  return {
    enabled: isLiveCallEventBatchAppendEnabled(),
    ...stats
  };
}

function eventStoreWorkerClient() {
  if (!isEventStoreWorkerEnabled() || eventStoreWorkerFailed) return null;
  initDb();
  if (!eventStoreWorker) eventStoreWorker = createEventStoreWorkerClient({ dbPath });
  return eventStoreWorker;
}

function validateEventStoreRustSidecarHealth(health = {}) {
  if (!health.ok) throw new Error("Event store Rust sidecar health check failed.");
  if (health.protocolVersion !== EVENT_STORE_SIDECAR_PROTOCOL_VERSION) {
    throw new Error(`Event store Rust sidecar protocol mismatch: ${health.protocolVersion || "unknown"}.`);
  }
  if (health.schemaReady !== true) {
    throw new Error("Event store Rust sidecar schema is not ready.");
  }
  const supported = new Set(Array.isArray(health.supportedMethods) ? health.supportedMethods : []);
  const missing = EVENT_STORE_CONTRACT_METHODS.filter((method) => !supported.has(method));
  if (missing.length) {
    throw new Error(`Event store Rust sidecar is missing method(s): ${missing.join(", ")}.`);
  }
}

async function ensureEventStoreRustSidecarReady(client) {
  if (eventStoreRustSidecarReady) return;
  const health = await client.request("__health", [], { timeout: eventStoreRustSidecarTimeoutMs() });
  validateEventStoreRustSidecarHealth(health);
  eventStoreRustSidecarReady = true;
}

function recordEventStoreRustSidecarFailure(error) {
  eventStoreRustSidecarStats.failures += 1;
  eventStoreRustSidecarStats.fallbacks += 1;
  eventStoreRustSidecarStats.lastFailureAt = nowIso();
  eventStoreRustSidecarStats.lastError = error?.message || String(error);
}

async function closeEventStoreRustSidecar({ resetFailure = true } = {}) {
  if (eventStoreRustSidecar) {
    const client = eventStoreRustSidecar;
    eventStoreRustSidecar = null;
    await client.close().catch(() => {});
  }
  eventStoreRustSidecarReady = false;
  if (resetFailure) eventStoreRustSidecarFailed = false;
}

function eventStoreSyncCall(method, callback) {
  const start = performance.now();
  try {
    const result = callback();
    eventStoreMetrics.record({ method, mode: "sync", ok: true, durationMs: performance.now() - start });
    return result;
  } catch (error) {
    eventStoreMetrics.record({ method, mode: "sync", ok: false, durationMs: performance.now() - start });
    throw error;
  }
}

async function eventStoreRustSidecarCall(method, args) {
  const client = eventStoreRustSidecarClient();
  if (!client) return { ok: false, attempted: false };

  const start = performance.now();
  try {
    await ensureEventStoreRustSidecarReady(client);
    const result = await client.request(method, args, { timeout: eventStoreRustSidecarTimeoutMs() });
    eventStoreMetrics.record({ method, mode: "rust-sidecar", ok: true, durationMs: performance.now() - start });
    return { ok: true, attempted: true, result };
  } catch (error) {
    eventStoreMetrics.record({ method, mode: "rust-sidecar", ok: false, durationMs: performance.now() - start, fallback: true });
    recordEventStoreRustSidecarFailure(error);
    eventStoreRustSidecarFailed = true;
    await closeEventStoreRustSidecar({ resetFailure: false });
    console.warn(`[eventStore] Rust sidecar failed; falling back: ${error.message}`);
    return { ok: false, attempted: true, error };
  }
}

async function eventStoreWorkerOrSyncCall(method, args, fallback) {
  const client = eventStoreWorkerClient();
  if (!client) {
    const start = performance.now();
    try {
      const result = await fallback();
      eventStoreMetrics.record({ method, mode: eventStoreMode(), ok: true, durationMs: performance.now() - start });
      return result;
    } catch (error) {
      eventStoreMetrics.record({ method, mode: eventStoreMode(), ok: false, durationMs: performance.now() - start });
      throw error;
    }
  }

  const workerStart = performance.now();
  try {
    const result = await client.request(method, args);
    eventStoreMetrics.record({ method, mode: "worker", ok: true, durationMs: performance.now() - workerStart });
    return result;
  } catch (error) {
    eventStoreMetrics.record({ method, mode: "worker", ok: false, durationMs: performance.now() - workerStart, fallback: true });
    eventStoreWorkerFailed = true;
    const failedWorker = eventStoreWorker;
    eventStoreWorker = null;
    failedWorker?.close().catch(() => {});
    console.warn(`[eventStore] worker failed; falling back to sync SQLite: ${error.message}`);
    const fallbackStart = performance.now();
    try {
      const result = await fallback();
      eventStoreMetrics.record({ method, mode: "sync-fallback", ok: true, durationMs: performance.now() - fallbackStart });
      return result;
    } catch (fallbackError) {
      eventStoreMetrics.record({ method, mode: "sync-fallback", ok: false, durationMs: performance.now() - fallbackStart });
      throw fallbackError;
    }
  }
}

async function eventStoreWorkerCall(method, args, fallback) {
  const rust = await eventStoreRustSidecarCall(method, args);
  if (rust.ok) return rust.result;
  return eventStoreWorkerOrSyncCall(method, args, fallback);
}

export async function closeEventStoreWorker() {
  if (!eventStoreWorker) return;
  await eventStoreWorker.close();
  eventStoreWorker = null;
  eventStoreWorkerFailed = false;
}

export async function drainEventStoreRuntime() {
  await flushTaskEventBatches();
  await flushToolEventBatches();
  await flushLiveCallEventBatches();
  await closeEventStoreRustSidecar();
  await closeEventStoreWorker();
}

export function getDbPath() {
  return dbPath;
}

export function getDefaultEventReplayLimit() {
  return DEFAULT_EVENT_REPLAY_LIMIT;
}

export function resolveEventReplayLimit(value, options = {}) {
  return normalizeEventReplayLimit(value, options);
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function upsertWorkspace(input = {}) {
  const workspacePath = path.resolve(cleanString(input.path, 1000) || process.cwd());
  const current = nowIso();
  const id = input.id || crypto.createHash("sha1").update(workspacePath.toLowerCase()).digest("hex").slice(0, 16);
  const title = cleanString(input.title, 160) || path.basename(workspacePath) || workspacePath;
  const allowedRoot = path.resolve(cleanString(input.allowedRoot, 1000) || workspacePath);

  database()
    .prepare(`
      INSERT INTO workspaces (id, path, title, allowed_root, created_at, updated_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        allowed_root = excluded.allowed_root,
        updated_at = excluded.updated_at,
        last_used_at = excluded.last_used_at
    `)
    .run(id, workspacePath, title, allowedRoot, input.createdAt || current, current, input.lastUsedAt || current);

  return getWorkspaceByPath(workspacePath) || { id, path: workspacePath, title, allowedRoot, createdAt: current, updatedAt: current, lastUsedAt: current };
}

export function listWorkspaces() {
  return database()
    .prepare("SELECT * FROM workspaces ORDER BY COALESCE(last_used_at, updated_at) DESC, title ASC")
    .all()
    .map((row) => ({
      id: row.id,
      path: row.path,
      title: row.title,
      allowedRoot: row.allowed_root,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at || ""
    }));
}

export function getWorkspace(id) {
  const row = database().prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    allowedRoot: row.allowed_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at || ""
  };
}

export function getWorkspaceByPath(value) {
  const workspacePath = path.resolve(value || "");
  const row = database().prepare("SELECT * FROM workspaces WHERE path = ?").get(workspacePath);
  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    allowedRoot: row.allowed_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at || ""
  };
}

export function findWorkspaceForPath(value) {
  const target = path.resolve(value || "");
  const candidates = listWorkspaces()
    .filter((workspace) => {
      const root = path.resolve(workspace.allowedRoot || workspace.path);
      return target === root || target.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`);
    })
    .sort((a, b) => path.resolve(b.allowedRoot || b.path).length - path.resolve(a.allowedRoot || a.path).length);
  return candidates[0] || null;
}

export function deleteWorkspaceByPath(value) {
  const workspacePath = path.resolve(value || "");
  const result = database().prepare("DELETE FROM workspaces WHERE path = ?").run(workspacePath);
  return result.changes > 0;
}

export function touchWorkspace(id) {
  database().prepare("UPDATE workspaces SET last_used_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), id);
}

export function createDevice({ label = "Device", token, expiresAt = "", meta = {} } = {}) {
  const current = nowIso();
  const deviceToken = token || crypto.randomBytes(32).toString("hex");
  const device = {
    id: crypto.randomUUID(),
    label: cleanString(label, 120) || "Device",
    token: deviceToken,
    createdAt: current,
    lastSeenAt: current,
    expiresAt: expiresAt || addDays(90)
  };

  database()
    .prepare(`
      INSERT INTO devices (id, label, token_hash, created_at, last_seen_at, revoked_at, expires_at, rotated_at, meta_json)
      VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?)
    `)
    .run(device.id, device.label, hashToken(deviceToken), current, current, device.expiresAt, toJson(meta));

  return device;
}

export function findDeviceByToken(token) {
  const row = database()
    .prepare("SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at = '' OR expires_at > ?)")
    .get(hashToken(token), nowIso());
  if (!row) return null;

  database().prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(nowIso(), row.id);
  return publicDevice({ ...row, last_seen_at: nowIso() });
}

export function listDevices() {
  return database()
    .prepare("SELECT * FROM devices ORDER BY COALESCE(last_seen_at, created_at) DESC")
    .all()
    .map(publicDevice);
}

export function revokeDevice(id) {
  const result = database().prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id);
  return result.changes > 0;
}

export function rotateDeviceToken(id, { ttlDays = 90 } = {}) {
  const row = database().prepare("SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL").get(id);
  if (!row) return null;

  const token = crypto.randomBytes(32).toString("hex");
  const current = nowIso();
  const expiresAt = addDays(ttlDays);
  database()
    .prepare("UPDATE devices SET token_hash = ?, rotated_at = ?, expires_at = ?, last_seen_at = ? WHERE id = ?")
    .run(hashToken(token), current, expiresAt, current, id);
  return {
    token,
    device: publicDevice({ ...row, token_hash: hashToken(token), rotated_at: current, expires_at: expiresAt, last_seen_at: current })
  };
}

export function createPairingSession({ label = "New device", ip = "", userAgent = "", ttlMs = 5 * 60 * 1000, meta = {} } = {}) {
  const id = crypto.randomUUID();
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const current = nowIso();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  database()
    .prepare(`
      INSERT INTO pairing_sessions (
        id, code_hash, label, ip, user_agent, status, created_at, expires_at,
        approved_at, approved_by_device_id, claimed_at, device_id, meta_json
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, ?)
    `)
    .run(id, pairingCodeHash(id, code), cleanString(label, 160), cleanString(ip, 120), cleanString(userAgent, 500), current, expiresAt, toJson(meta));

  return {
    id,
    code,
    label: cleanString(label, 160),
    ip: cleanString(ip, 120),
    userAgent: cleanString(userAgent, 500),
    status: "pending",
    createdAt: current,
    expiresAt
  };
}

function publicPairingSession(row, { includeMeta = false } = {}) {
  if (!row) return null;
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  const status = row.status === "pending" && expired ? "expired" : row.status;
  return {
    id: row.id,
    label: row.label || "",
    ip: row.ip || "",
    userAgent: row.user_agent || "",
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at || "",
    approvedByDeviceId: row.approved_by_device_id || "",
    claimedAt: row.claimed_at || "",
    deviceId: row.device_id || "",
    expired,
    ...(includeMeta ? { meta: fromJson(row.meta_json, {}) || {} } : {})
  };
}

export function getPairingSession(id) {
  const row = database().prepare("SELECT * FROM pairing_sessions WHERE id = ?").get(id);
  return publicPairingSession(row);
}

export function listPairingSessions({ status = "pending", limit = 20 } = {}) {
  const rows = database()
    .prepare(`
      SELECT * FROM pairing_sessions
      WHERE (? = '' OR status = ?)
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(status, status, Number(limit || 20));
  return rows.map(publicPairingSession);
}

export function approvePairingSession(id, deviceId) {
  const row = database().prepare("SELECT * FROM pairing_sessions WHERE id = ?").get(id);
  if (!row) return null;
  if (row.status !== "pending" || new Date(row.expires_at).getTime() <= Date.now()) return publicPairingSession(row);
  const current = nowIso();
  database()
    .prepare("UPDATE pairing_sessions SET status = 'approved', approved_at = ?, approved_by_device_id = ? WHERE id = ?")
    .run(current, deviceId || "", id);
  return getPairingSession(id);
}

export function denyPairingSession(id, deviceId = "") {
  const row = database().prepare("SELECT * FROM pairing_sessions WHERE id = ?").get(id);
  if (!row) return null;
  const current = nowIso();
  database()
    .prepare("UPDATE pairing_sessions SET status = 'denied', approved_at = COALESCE(approved_at, ?), approved_by_device_id = COALESCE(approved_by_device_id, ?) WHERE id = ?")
    .run(current, deviceId || "", id);
  return getPairingSession(id);
}

export function claimPairingSession({ id, code, label = "Browser", meta = {} } = {}) {
  const row = database().prepare("SELECT * FROM pairing_sessions WHERE id = ?").get(id);
  if (!row) {
    const error = new Error("Pairing session not found.");
    error.status = 404;
    throw error;
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    const error = new Error("Pairing session expired.");
    error.status = 410;
    throw error;
  }
  if (row.status !== "approved") {
    const error = new Error(row.status === "pending" ? "Pairing session is waiting for confirmation." : `Pairing session is ${row.status}.`);
    error.status = 409;
    throw error;
  }
  if (row.code_hash !== pairingCodeHash(id, code)) {
    const error = new Error("Pairing code mismatch.");
    error.status = 401;
    throw error;
  }

  const device = createDevice({
    label: label || row.label || "Browser",
    meta: {
      ...meta,
      pairingSessionId: id,
      pairedIp: row.ip || "",
      approvedByDeviceId: row.approved_by_device_id || ""
    }
  });
  database()
    .prepare("UPDATE pairing_sessions SET status = 'claimed', claimed_at = ?, device_id = ? WHERE id = ?")
    .run(nowIso(), device.id, id);
  return {
    device,
    session: getPairingSession(id)
  };
}

export function recordAuditLog(event = {}) {
  const current = nowIso();
  database()
    .prepare(`
      INSERT INTO audit_log (
        event_type, event_at, device_id, ip, user_agent, method, path,
        success, reason, target, meta_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      cleanString(event.type || event.eventType || "event", 120),
      event.at || current,
      cleanString(event.deviceId, 160),
      cleanString(event.ip, 120),
      cleanString(event.userAgent, 500),
      cleanString(event.method, 16),
      cleanString(event.path, 500),
      boolInt(event.success),
      cleanString(event.reason, 1000),
      cleanString(event.target, 500),
      toJson(event.meta || {}),
      current
    );

  const row = database().prepare("SELECT last_insert_rowid() AS cursor").get();
  return row?.cursor || null;
}

export function listAuditLogs({ after = 0, limit = 200 } = {}) {
  return database()
    .prepare(`
      SELECT *
      FROM audit_log
      WHERE cursor > ?
      ORDER BY cursor DESC
      LIMIT ?
    `)
    .all(Number(after || 0), Number(limit || 200))
    .map((row) => ({
      cursor: row.cursor,
      type: row.event_type,
      at: row.event_at,
      deviceId: row.device_id || "",
      ip: row.ip || "",
      userAgent: row.user_agent || "",
      method: row.method || "",
      path: row.path || "",
      success: rowBool(row.success),
      reason: row.reason || "",
      target: row.target || "",
      meta: fromJson(row.meta_json, {}) || {}
    }));
}

export function upsertPushSubscription({ deviceId = "", subscription } = {}) {
  if (!subscription?.endpoint) {
    const error = new Error("Push subscription endpoint is required.");
    error.status = 400;
    throw error;
  }
  const current = nowIso();
  const id = crypto.createHash("sha1").update(subscription.endpoint).digest("hex").slice(0, 24);
  const nextSubscription = {
    kind: subscription.kind || (String(subscription.endpoint).startsWith("native:") ? "native" : "web"),
    ...subscription
  };
  database()
    .prepare(`
      INSERT INTO push_subscriptions (id, device_id, endpoint, subscription_json, created_at, updated_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(endpoint) DO UPDATE SET
        device_id = excluded.device_id,
        subscription_json = excluded.subscription_json,
        updated_at = excluded.updated_at,
        revoked_at = NULL
    `)
    .run(id, deviceId || "", subscription.endpoint, toJson(nextSubscription), current, current);
  return {
    id,
    deviceId: deviceId || "",
    endpoint: subscription.endpoint,
    kind: nextSubscription.kind,
    subscription: nextSubscription,
    createdAt: current,
    updatedAt: current
  };
}

export function upsertNativePushToken({ deviceId = "", provider = "android", token = "", platform = "android", appId = "", installationId = "" } = {}) {
  const cleanToken = cleanString(token, 4096);
  if (!cleanToken) {
    const error = new Error("Native push token is required.");
    error.status = 400;
    throw error;
  }
  const cleanProvider = cleanString(provider, 80).toLowerCase() || "android";
  const endpoint = `native:${cleanProvider}:${crypto.createHash("sha256").update(cleanToken).digest("hex").slice(0, 40)}`;
  const subscription = upsertPushSubscription({
    deviceId,
    subscription: {
      kind: "native",
      endpoint,
      provider: cleanProvider,
      token: cleanToken,
      platform: cleanString(platform, 80).toLowerCase() || "android",
      appId: cleanString(appId, 200),
      installationId: cleanString(installationId, 200)
    }
  });
  return {
    ...subscription,
    provider: subscription.subscription.provider,
    platform: subscription.subscription.platform,
    appId: subscription.subscription.appId,
    installationId: subscription.subscription.installationId
  };
}

export function listPushSubscriptions({ kind = "web" } = {}) {
  return database()
    .prepare("SELECT * FROM push_subscriptions WHERE revoked_at IS NULL ORDER BY updated_at DESC")
    .all()
    .map((row) => {
      const subscription = fromJson(row.subscription_json, {}) || {};
      const itemKind = subscription.kind || (String(row.endpoint || "").startsWith("native:") ? "native" : "web");
      return {
        id: row.id,
        deviceId: row.device_id || "",
        endpoint: row.endpoint,
        kind: itemKind,
        subscription,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    })
    .filter((item) => !kind || item.kind === kind);
}

export function revokePushSubscription(idOrEndpoint) {
  const current = nowIso();
  const result = database()
    .prepare("UPDATE push_subscriptions SET revoked_at = ? WHERE revoked_at IS NULL AND (id = ? OR endpoint = ?)")
    .run(current, idOrEndpoint, idOrEndpoint);
  return result.changes > 0;
}

export function upsertTask(task) {
  const current = nowIso();
  const workspace = task.workspaceId ? getWorkspace(task.workspaceId) : findWorkspaceForPath(task.cwd || "");
  database()
    .prepare(`
      INSERT INTO tasks (
        id, agent, title, cwd, workspace_id, status, created_at, updated_at, exit_code,
        session_id, command_label, log_path, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent = excluded.agent,
        title = excluded.title,
        cwd = excluded.cwd,
        workspace_id = excluded.workspace_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        exit_code = excluded.exit_code,
        session_id = excluded.session_id,
        command_label = excluded.command_label,
        log_path = excluded.log_path,
        meta_json = excluded.meta_json
    `)
    .run(
      task.id,
      task.agent,
      task.title,
      task.cwd || "",
      workspace?.id || "",
      task.status,
      task.createdAt || current,
      task.updatedAt || current,
      task.exitCode ?? null,
      task.sessionId || "",
      task.commandLabel || "",
      task.logPath || "",
      toJson({
        restored: Boolean(task.restored),
        security: task.security || null
      })
    );
}

export function insertTaskEvent(taskId, event) {
  return eventStoreSyncCall("insertTaskEvent", () => sqliteEventStore().insertTaskEvent(taskId, event));
}

export function insertTaskEvents(taskId, events = []) {
  return eventStoreSyncCall("insertTaskEvents", () => sqliteEventStore().insertTaskEvents(taskId, events));
}

export async function insertTaskEventAsync(taskId, event) {
  return eventStoreWorkerCall(
    "insertTaskEvent",
    [taskId, event],
    () => sqliteEventStore().insertTaskEvent(taskId, event)
  );
}

export async function insertTaskEventsAsync(taskId, events = []) {
  return eventStoreWorkerCall(
    "insertTaskEvents",
    [taskId, events],
    () => sqliteEventStore().insertTaskEvents(taskId, events)
  );
}

export async function insertTaskEventBatchedAsync(taskId, event = {}) {
  if (!isTaskEventBatchAppendEnabled()) return insertTaskEvent(taskId, event);
  return taskEventBatcher().enqueue(cleanString(taskId, 160), event);
}

export async function flushTaskEventBatches() {
  if (!taskEventAppendBatcher) return [];
  return taskEventAppendBatcher.flushNow();
}

export function listTaskEvents(taskId, { after = 0, limit = DEFAULT_EVENT_REPLAY_LIMIT } = {}) {
  return sqliteEventStore().listTaskEvents(taskId, { after, limit });
}

export async function listTaskEventsAsync(taskId, { after = 0, limit = DEFAULT_EVENT_REPLAY_LIMIT } = {}) {
  return eventStoreWorkerCall(
    "listTaskEvents",
    [taskId, { after, limit }],
    () => listTaskEvents(taskId, { after, limit })
  );
}

export function getTaskEventCount(taskId) {
  return sqliteEventStore().getTaskEventCount(taskId);
}

function publicToolRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id || "",
    workspaceId: row.workspace_id || "",
    toolName: row.tool_name || "",
    status: row.status || "",
    title: row.title || "",
    input: fromJson(row.input_json, null),
    result: fromJson(row.result_json, null),
    error: row.error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || "",
    completedAt: row.completed_at || ""
  };
}

export function createToolRun(input = {}) {
  const current = nowIso();
  const id = input.id || crypto.randomUUID();
  database()
    .prepare(`
      INSERT INTO tool_runs (
        id, task_id, workspace_id, tool_name, status, title, input_json,
        result_json, error, created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      cleanString(input.taskId || "", 160),
      cleanString(input.workspaceId || "", 160),
      cleanString(input.toolName || "tool", 120),
      cleanString(input.status || "pending", 40),
      cleanString(input.title || "", 200),
      toJson(input.input || null),
      toJson(input.result || null),
      cleanString(input.error || "", 2000),
      input.createdAt || current,
      input.updatedAt || current,
      input.startedAt || "",
      input.completedAt || ""
    );
  return getToolRun(id);
}

export function updateToolRun(id, patch = {}) {
  const existing = database().prepare("SELECT * FROM tool_runs WHERE id = ?").get(id);
  if (!existing) return null;
  const current = nowIso();
  const next = {
    status: Object.hasOwn(patch, "status") ? cleanString(patch.status, 40) : existing.status,
    title: Object.hasOwn(patch, "title") ? cleanString(patch.title || "", 200) : existing.title,
    input: Object.hasOwn(patch, "input") ? patch.input : fromJson(existing.input_json, null),
    result: Object.hasOwn(patch, "result") ? patch.result : fromJson(existing.result_json, null),
    error: Object.hasOwn(patch, "error") ? cleanString(patch.error || "", 2000) : existing.error,
    startedAt: Object.hasOwn(patch, "startedAt") ? patch.startedAt || "" : existing.started_at || "",
    completedAt: Object.hasOwn(patch, "completedAt") ? patch.completedAt || "" : existing.completed_at || ""
  };
  database()
    .prepare(`
      UPDATE tool_runs
      SET status = ?, title = ?, input_json = ?, result_json = ?, error = ?,
          updated_at = ?, started_at = ?, completed_at = ?
      WHERE id = ?
    `)
    .run(next.status, next.title, toJson(next.input), toJson(next.result), next.error, current, next.startedAt, next.completedAt, id);
  return getToolRun(id);
}

export function getToolRun(id) {
  const row = database().prepare("SELECT * FROM tool_runs WHERE id = ?").get(id);
  return publicToolRun(row);
}

export function attachToolRunToTask(id, { taskId = "", workspaceId = "" } = {}) {
  const existing = database().prepare("SELECT * FROM tool_runs WHERE id = ?").get(id);
  if (!existing) return null;
  const nextTaskId = cleanString(taskId || existing.task_id || "", 160);
  const nextWorkspaceId = cleanString(workspaceId || existing.workspace_id || "", 160);
  const current = nowIso();
  const eventRows = database().prepare("SELECT cursor, event_json FROM tool_events WHERE tool_run_id = ?").all(id);
  database()
    .prepare("UPDATE tool_runs SET task_id = ?, workspace_id = ?, updated_at = ? WHERE id = ?")
    .run(nextTaskId, nextWorkspaceId, current, id);
  database()
    .prepare("UPDATE tool_events SET task_id = ?, workspace_id = ? WHERE tool_run_id = ?")
    .run(nextTaskId, nextWorkspaceId, id);
  const updateEvent = database().prepare("UPDATE tool_events SET event_json = ? WHERE cursor = ?");
  for (const row of eventRows) {
    const event = fromJson(row.event_json, {});
    updateEvent.run(toJson({ ...event, taskId: nextTaskId, workspaceId: nextWorkspaceId }), row.cursor);
  }
  database()
    .prepare("UPDATE approval_requests SET task_id = ?, workspace_id = ?, updated_at = ? WHERE tool_run_id = ?")
    .run(nextTaskId, nextWorkspaceId, current, id);
  database()
    .prepare("UPDATE approval_decisions SET task_id = ?, workspace_id = ? WHERE tool_run_id = ?")
    .run(nextTaskId, nextWorkspaceId, id);
  return getToolRun(id);
}

export function listToolRuns({ workspaceId = "", taskId = "", limit = 100 } = {}) {
  const rows = database()
    .prepare(`
      SELECT *
      FROM tool_runs
      WHERE (? = '' OR workspace_id = ?)
        AND (? = '' OR task_id = ?)
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(cleanString(workspaceId, 160), cleanString(workspaceId, 160), cleanString(taskId, 160), cleanString(taskId, 160), Number(limit || 100));
  return rows.map(publicToolRun);
}

export function insertToolEvent(toolRunId, event = {}) {
  return eventStoreSyncCall("insertToolEvent", () => sqliteEventStore().insertToolEvent(toolRunId, event));
}

export function insertToolEvents(toolRunId, events = []) {
  return eventStoreSyncCall("insertToolEvents", () => sqliteEventStore().insertToolEvents(toolRunId, events));
}

export async function insertToolEventAsync(toolRunId, event = {}) {
  return eventStoreWorkerCall(
    "insertToolEvent",
    [toolRunId, event],
    () => sqliteEventStore().insertToolEvent(toolRunId, event)
  );
}

export async function insertToolEventsAsync(toolRunId, events = []) {
  return eventStoreWorkerCall(
    "insertToolEvents",
    [toolRunId, events],
    () => sqliteEventStore().insertToolEvents(toolRunId, events)
  );
}

export async function insertToolEventBatchedAsync(toolRunId, event = {}) {
  if (!isEventStoreBatchAppendEnabled()) return insertToolEvent(toolRunId, event);
  return toolEventBatcher().enqueue(cleanString(toolRunId, 160), event);
}

export async function flushToolEventBatches() {
  if (!toolEventAppendBatcher) return [];
  return toolEventAppendBatcher.flushNow();
}

export function listToolEvents({ toolRunId = "", workspaceId = "", taskId = "", after = 0, limit = DEFAULT_EVENT_REPLAY_LIMIT } = {}) {
  return sqliteEventStore().listToolEvents({ toolRunId, workspaceId, taskId, after, limit });
}

export async function listToolEventsAsync({ toolRunId = "", workspaceId = "", taskId = "", after = 0, limit = DEFAULT_EVENT_REPLAY_LIMIT } = {}) {
  return eventStoreWorkerCall(
    "listToolEvents",
    [{ toolRunId, workspaceId, taskId, after, limit }],
    () => listToolEvents({ toolRunId, workspaceId, taskId, after, limit })
  );
}

export function getToolEventStats() {
  return sqliteEventStore().getToolEventStats();
}

export async function getToolEventStatsAsync() {
  return eventStoreWorkerCall("getToolEventStats", [], () => getToolEventStats());
}

export function pruneToolEvents({ before = "", keepLatest = 5000, dryRun = true } = {}) {
  return sqliteEventStore().pruneToolEvents({ before, keepLatest, dryRun });
}

export async function pruneToolEventsAsync({ before = "", keepLatest = 5000, dryRun = true } = {}) {
  return eventStoreWorkerCall(
    "pruneToolEvents",
    [{ before, keepLatest, dryRun }],
    () => pruneToolEvents({ before, keepLatest, dryRun })
  );
}

function publicApprovalRequest(row) {
  if (!row) return null;
  const expiresAt = row.expires_at || "";
  return {
    id: row.id,
    toolRunId: row.tool_run_id || "",
    taskId: row.task_id || "",
    workspaceId: row.workspace_id || "",
    kind: row.kind || "",
    status: row.status || "",
    title: row.title || "",
    reason: row.reason || "",
    request: fromJson(row.request_json, null),
    risk: fromJson(row.risk_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt,
    expired: Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now()),
    decidedAt: row.decided_at || "",
    decidedByDeviceId: row.decided_by_device_id || "",
    decisionReason: row.decision_reason || "",
    decision: fromJson(row.decision_json, null)
  };
}

export function createApprovalRequest(input = {}) {
  const current = nowIso();
  const id = input.id || crypto.randomUUID();
  database()
    .prepare(`
      INSERT INTO approval_requests (
        id, tool_run_id, task_id, workspace_id, kind, status, title, reason,
        request_json, risk_json, created_at, updated_at, expires_at, decided_at,
        decided_by_device_id, decision_reason, decision_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
    `)
    .run(
      id,
      cleanString(input.toolRunId || "", 160),
      cleanString(input.taskId || "", 160),
      cleanString(input.workspaceId || "", 160),
      cleanString(input.kind || "tool", 120),
      cleanString(input.status || "pending", 40),
      cleanString(input.title || "", 200),
      cleanString(input.reason || "", 2000),
      toJson(input.request || null),
      toJson(input.risk || null),
      input.createdAt || current,
      input.updatedAt || current,
      input.expiresAt || ""
    );
  return getApprovalRequest(id);
}

export function getApprovalRequest(id) {
  const row = database().prepare("SELECT * FROM approval_requests WHERE id = ?").get(id);
  const approval = publicApprovalRequest(row);
  if (approval?.status === "pending" && approval.expired) {
    return updateApprovalRequest(id, { status: "expired", decisionReason: "Approval request expired." });
  }
  return approval;
}

export function listApprovalRequests({ status = "", workspaceId = "", after = 0, limit = 100 } = {}) {
  return database()
    .prepare(`
      SELECT *
      FROM approval_requests
      WHERE (? = '' OR status = ?)
        AND (? = '' OR workspace_id = ?)
        AND rowid > ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(cleanString(status, 40), cleanString(status, 40), cleanString(workspaceId, 160), cleanString(workspaceId, 160), Number(after || 0), Number(limit || 100))
    .map(publicApprovalRequest)
    .map((approval) => (approval?.status === "pending" && approval.expired ? updateApprovalRequest(approval.id, { status: "expired", decisionReason: "Approval request expired." }) : approval));
}

export function updateApprovalRequest(id, patch = {}) {
  const existing = database().prepare("SELECT * FROM approval_requests WHERE id = ?").get(id);
  if (!existing) return null;
  const current = nowIso();
  const status = Object.hasOwn(patch, "status") ? cleanString(patch.status, 40) : existing.status;
  const decidedAt = ["approved", "denied", "expired"].includes(status) && !existing.decided_at ? current : existing.decided_at || "";
  database()
    .prepare(`
      UPDATE approval_requests
      SET status = ?,
          updated_at = ?,
          decided_at = ?,
          decided_by_device_id = ?,
          decision_reason = ?,
          decision_json = ?
      WHERE id = ?
    `)
    .run(
      status,
      current,
      Object.hasOwn(patch, "decidedAt") ? patch.decidedAt || "" : decidedAt,
      Object.hasOwn(patch, "decidedByDeviceId") ? cleanString(patch.decidedByDeviceId || "", 160) : existing.decided_by_device_id || "",
      Object.hasOwn(patch, "decisionReason") ? cleanString(patch.decisionReason || "", 2000) : existing.decision_reason || "",
      Object.hasOwn(patch, "decision") ? toJson(patch.decision || null) : existing.decision_json,
      id
    );
  if (Object.hasOwn(patch, "status") && status !== existing.status && ["approved", "denied", "expired"].includes(status)) {
    database()
      .prepare(`
        INSERT INTO approval_decisions (
          id, approval_id, tool_run_id, task_id, workspace_id, decision,
          reason, device_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        crypto.randomUUID(),
        id,
        existing.tool_run_id || "",
        existing.task_id || "",
        existing.workspace_id || "",
        status,
        Object.hasOwn(patch, "decisionReason") ? cleanString(patch.decisionReason || "", 2000) : existing.decision_reason || "",
        Object.hasOwn(patch, "decidedByDeviceId") ? cleanString(patch.decidedByDeviceId || "", 160) : existing.decided_by_device_id || "",
        Object.hasOwn(patch, "decision") ? toJson(patch.decision || null) : existing.decision_json,
        current
      );
  }
  return publicApprovalRequest(database().prepare("SELECT * FROM approval_requests WHERE id = ?").get(id));
}

function desktopRemoteQueueItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text || "",
    status: row.status || "queued",
    error: row.error || "",
    attempts: Number(row.attempts || 0),
    permissionMode: row.permission_mode || "",
    model: row.model || "",
    reasoningEffort: row.reasoning_effort || "",
    settingsPolicy: row.settings_policy || "useExisting",
    target: fromJson(row.target_json, null),
    settingsCheck: fromJson(row.settings_check_json, null),
    restoreCheck: fromJson(row.restore_check_json, null),
    preflight: fromJson(row.preflight_json, null),
    postflight: fromJson(row.postflight_json, null),
    result: fromJson(row.result_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at || ""
  };
}

export function listDesktopRemoteQueue({ limit = 120 } = {}) {
  return database()
    .prepare("SELECT * FROM desktop_remote_queue ORDER BY created_at DESC LIMIT ?")
    .all(Number(limit || 120))
    .map(desktopRemoteQueueItem)
    .reverse();
}

export function upsertDesktopRemoteQueueItem(item = {}) {
  const current = nowIso();
  const id = item.id || crypto.randomUUID();
  const createdAt = item.createdAt || current;
  const updatedAt = item.updatedAt || current;
  database()
    .prepare(`
      INSERT INTO desktop_remote_queue (
        id, text, status, error, attempts, permission_mode, model, reasoning_effort,
        settings_policy, target_json, settings_check_json, restore_check_json,
        preflight_json, postflight_json, result_json, created_at, updated_at, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        status = excluded.status,
        error = excluded.error,
        attempts = excluded.attempts,
        permission_mode = excluded.permission_mode,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        settings_policy = excluded.settings_policy,
        target_json = excluded.target_json,
        settings_check_json = excluded.settings_check_json,
        restore_check_json = excluded.restore_check_json,
        preflight_json = excluded.preflight_json,
        postflight_json = excluded.postflight_json,
        result_json = excluded.result_json,
        updated_at = excluded.updated_at,
        sent_at = excluded.sent_at
    `)
    .run(
      id,
      String(item.text || ""),
      cleanString(item.status || "queued", 40),
      cleanString(item.error || "", 1000),
      Number(item.attempts || 0),
      cleanString(item.permissionMode || "", 80),
      cleanString(item.model || "", 120),
      cleanString(item.reasoningEffort || "", 80),
      cleanString(item.settingsPolicy || "useExisting", 80),
      toJson(item.target || null),
      toJson(item.settingsCheck || null),
      toJson(item.restoreCheck || null),
      toJson(item.preflight || null),
      toJson(item.postflight || null),
      toJson(item.result || null),
      createdAt,
      updatedAt,
      item.sentAt || ""
    );
  return id;
}

export function getThreadStateFromDb() {
  const itemRows = database().prepare("SELECT * FROM threads ORDER BY updated_at DESC").all();
  const forkRows = database().prepare("SELECT * FROM thread_forks ORDER BY updated_at DESC").all();
  const items = {};

  for (const row of itemRows) {
    const rowMeta = fromJson(row.meta_json, {}) || {};
    items[row.key] = {
      ...rowMeta,
      key: row.key,
      title: row.title || "",
      group: row.group_name || "",
      pinned: rowBool(row.pinned),
      archived: rowBool(row.archived),
      tags: Array.isArray(rowMeta.tags) ? rowMeta.tags : [],
      favorite: Boolean(rowMeta.favorite),
      revision: Number(row.revision || 0),
      updatedAt: row.updated_at
    };
  }

  const forks = forkRows.map((row) => ({
    id: row.id,
    sourceKey: row.source_key,
    sourceId: row.source_id,
    provider: row.provider,
    title: row.title,
    cwd: row.cwd || "",
    group: row.group_name || "",
    pinned: rowBool(row.pinned),
    archived: rowBool(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));

  return {
    version: 2,
    items,
    forks
  };
}

function cleanTags(value) {
  const tags = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const raw of tags) {
    const tag = cleanString(raw, 40);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= 20) break;
  }
  return result;
}

function threadStateError(message, status = 400, code = "THREAD_STATE_INVALID") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function threadStateConflict(conflicts) {
  const error = threadStateError("Thread state conflict.", 409, "THREAD_STATE_CONFLICT");
  error.conflicts = conflicts;
  return error;
}

function publicThreadItem(key, row, next) {
  return {
    key,
    title: next.title || "",
    group: next.group || "",
    pinned: Boolean(next.pinned),
    archived: Boolean(next.archived),
    tags: Array.isArray(next.meta?.tags) ? next.meta.tags : [],
    favorite: Boolean(next.meta?.favorite),
    revision: Number(row?.revision || 0),
    updatedAt: row?.updated_at || ""
  };
}

function expectedRevisionValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? revision : null;
}

function applyThreadMetaPatch(db, cleanKey, patch = {}, options = {}) {
  const hasTagsReplace = Object.hasOwn(patch, "tags");
  const hasTagOps = Object.hasOwn(patch, "addTags") || Object.hasOwn(patch, "removeTags");
  if (hasTagsReplace && hasTagOps) {
    throw threadStateError("Use either tags replacement or addTags/removeTags, not both.", 400);
  }

  const existing = db.prepare("SELECT * FROM threads WHERE key = ?").get(cleanKey);
  const current = nowIso();
  const currentMeta = fromJson(existing?.meta_json, {}) || {};
  const currentTags = cleanTags(currentMeta.tags);
  const fieldRevisions = fromJson(existing?.field_revisions_json, {}) || {};
  const currentRevision = Number(existing?.revision || 0);
  const expectedRevision = expectedRevisionValue(options.expectedRevision);
  const touched = new Set();
  const mergeSafeFields = new Set();

  const next = {
    title: Object.hasOwn(patch, "title") ? cleanString(patch.title, 160) : existing?.title || "",
    group: Object.hasOwn(patch, "group") ? cleanString(patch.group, 80) : existing?.group_name || "",
    pinned: Object.hasOwn(patch, "pinned") ? Boolean(patch.pinned) : rowBool(existing?.pinned),
    archived: Object.hasOwn(patch, "archived") ? Boolean(patch.archived) : rowBool(existing?.archived),
    meta: {
      ...currentMeta,
      ...(patch.meta && typeof patch.meta === "object" ? patch.meta : {})
    }
  };

  for (const field of ["title", "group", "pinned", "archived", "favorite"]) {
    if (Object.hasOwn(patch, field)) touched.add(field);
  }
  if (patch.meta && typeof patch.meta === "object") touched.add("meta");

  if (hasTagsReplace) {
    next.meta.tags = cleanTags(patch.tags);
    touched.add("tags");
  } else if (hasTagOps) {
    const remove = new Set(cleanTags(patch.removeTags));
    const merged = currentTags.filter((tag) => !remove.has(tag));
    next.meta.tags = cleanTags([...merged, ...cleanTags(patch.addTags)]);
    touched.add("tags");
    mergeSafeFields.add("tags");
  } else if (Array.isArray(next.meta.tags)) {
    next.meta.tags = currentTags;
  }

  if (Object.hasOwn(patch, "favorite")) next.meta.favorite = Boolean(patch.favorite);

  if (expectedRevision !== null && currentRevision > expectedRevision) {
    const conflictingFields = [...touched].filter((field) => {
      if (mergeSafeFields.has(field)) return false;
      return Number(fieldRevisions[field] || 0) > expectedRevision;
    });
    if (conflictingFields.length) {
      throw threadStateConflict([{
        key: cleanKey,
        expectedRevision,
        actualRevision: currentRevision,
        conflictingFields,
        current: publicThreadItem(cleanKey, { ...existing, revision: currentRevision, updated_at: existing?.updated_at || "" }, {
          title: existing?.title || "",
          group: existing?.group_name || "",
          pinned: rowBool(existing?.pinned),
          archived: rowBool(existing?.archived),
          meta: currentMeta
        })
      }]);
    }
  }

  const nextRevision = currentRevision + 1;
  for (const field of touched) fieldRevisions[field] = nextRevision;

  db.prepare(`
    INSERT INTO threads (
      key, provider, session_id, workspace_id, title, group_name, pinned,
      archived, source, meta_json, revision, field_revisions_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      title = excluded.title,
      group_name = excluded.group_name,
      pinned = excluded.pinned,
      archived = excluded.archived,
      meta_json = excluded.meta_json,
      revision = excluded.revision,
      field_revisions_json = excluded.field_revisions_json,
      updated_at = excluded.updated_at
  `)
    .run(
      cleanKey,
      patch.provider || existing?.provider || "",
      patch.sessionId || existing?.session_id || "",
      patch.workspaceId || existing?.workspace_id || "",
      next.title,
      next.group,
      boolInt(next.pinned),
      boolInt(next.archived),
      patch.source || existing?.source || "local",
      toJson(next.meta),
      nextRevision,
      toJson(fieldRevisions),
      existing?.created_at || current,
      current
    );

  if (cleanKey.startsWith("fork:")) {
    const forkId = cleanKey.slice("fork:".length);
    db.prepare(`
      UPDATE thread_forks
      SET title = COALESCE(NULLIF(?, ''), title),
          group_name = ?,
          pinned = ?,
          archived = ?,
          updated_at = ?
      WHERE id = ?
    `)
      .run(next.title, next.group, boolInt(next.pinned), boolInt(next.archived), current, forkId);
  }
}

export function upsertThreadMeta(key, patch = {}, options = {}) {
  const cleanKey = cleanString(key, 320);
  if (!cleanKey) throw new Error("Thread key is required.");

  applyThreadMetaPatch(database(), cleanKey, patch, options);
  return getThreadStateFromDb();
}

export function upsertThreadMetaBatch(updates = []) {
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("At least one thread update is required.");
  const bounded = updates.slice(0, 200).map((update) => ({
    key: cleanString(update?.key, 320),
    patch: update?.patch || {},
    expectedRevision: update?.expectedRevision
  }));
  if (bounded.some((update) => !update.key)) throw new Error("Thread key is required.");

  const db = database();
  db.exec("BEGIN");
  try {
    for (const update of bounded) {
      applyThreadMetaPatch(db, update.key, update.patch, { expectedRevision: update.expectedRevision });
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return getThreadStateFromDb();
}

export function createThreadForkInDb(payload = {}) {
  const id = payload.id || crypto.randomUUID();
  const current = nowIso();
  const fork = {
    id,
    sourceKey: cleanString(payload.sourceKey, 320),
    sourceId: cleanString(payload.sourceId || payload.sessionId || payload.id, 320),
    provider: ["codex", "claude", "doubao", "zhipu"].includes(payload.provider) ? payload.provider : "codex",
    title: cleanString(payload.title, 160) || "Forked thread",
    cwd: cleanString(payload.cwd, 500),
    group: cleanString(payload.group, 80),
    pinned: Boolean(payload.pinned),
    archived: Boolean(payload.archived),
    createdAt: payload.createdAt || current,
    updatedAt: payload.updatedAt || current
  };

  if (!fork.sourceKey || !fork.sourceId) throw new Error("Fork source is required.");

  database()
    .prepare(`
      INSERT INTO thread_forks (
        id, source_key, source_id, provider, title, cwd, group_name,
        pinned, archived, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        group_name = excluded.group_name,
        pinned = excluded.pinned,
        archived = excluded.archived,
        updated_at = excluded.updated_at
    `)
    .run(
      fork.id,
      fork.sourceKey,
      fork.sourceId,
      fork.provider,
      fork.title,
      fork.cwd,
      fork.group,
      boolInt(fork.pinned),
      boolInt(fork.archived),
      fork.createdAt,
      fork.updatedAt
    );

  upsertThreadMeta(`fork:${fork.id}`, {
    title: fork.title,
    group: fork.group,
    pinned: fork.pinned,
    archived: fork.archived,
    provider: fork.provider,
    sessionId: fork.sourceId,
    meta: { sourceKey: fork.sourceKey, cwd: fork.cwd }
  });

  return {
    fork,
    state: getThreadStateFromDb()
  };
}

export function importThreadState(state = {}) {
  const items = state.items && typeof state.items === "object" ? state.items : {};
  for (const [key, item] of Object.entries(items)) {
    upsertThreadMeta(key, {
      title: item.title || "",
      group: item.group || "",
      pinned: Boolean(item.pinned),
      archived: Boolean(item.archived),
      meta: item
    });
  }

  for (const fork of Array.isArray(state.forks) ? state.forks : []) {
    if (!fork?.id) continue;
    createThreadForkInDb({ ...fork, archived: Boolean(fork.archived) });
  }
}

export function recordDesktopObservation(desktop, { source = "codex-desktop-ui", type = "desktop.snapshot", extra = {} } = {}) {
  if (!desktop || typeof desktop !== "object") return null;

  const observedAt = desktop.updatedAt || nowIso();
  const hashSource = [
    type,
    desktop.found ? "found" : "missing",
    desktop.ready ? "ready" : "not-ready",
    desktop.sidebarRunningCount || 0,
    desktop.visibleTranscriptHash || "",
    JSON.stringify((desktop.conversations || []).map((item) => [item.title, item.running])),
    JSON.stringify((desktop.projects || []).map((item) => item.title)),
    JSON.stringify(extra || {})
  ].join("\n");
  const hash = crypto.createHash("sha1").update(hashSource).digest("hex").slice(0, 20);

  const previous = database()
    .prepare("SELECT hash FROM desktop_observations ORDER BY cursor DESC LIMIT 1")
    .get();
  if (previous?.hash === hash) return null;

  const event = {
    type,
    source,
    observedAt,
    desktop,
    ...(extra && typeof extra === "object" ? extra : {})
  };

  database()
    .prepare(`
      INSERT INTO desktop_observations (
        source, event_type, workspace_id, observed_at, hash, found, ready, running_count,
        transcript_count, observation_json, event_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      source,
      type,
      desktop.workspaceId || "",
      observedAt,
      hash,
      boolInt(desktop.found),
      boolInt(desktop.ready),
      Number(desktop.sidebarRunningCount || 0),
      Number(desktop.visibleTranscriptCount || desktop.visibleTranscript?.length || 0),
      toJson(desktop),
      toJson(event),
      nowIso()
    );

  const row = database()
    .prepare("SELECT cursor FROM desktop_observations WHERE hash = ? ORDER BY cursor DESC LIMIT 1")
    .get(hash);
  const cursor = row?.cursor || null;
  return cursor
    ? {
        cursor,
        hash,
        ...event
      }
    : null;
}

export function listDesktopObservations({ after = 0, limit = 100 } = {}) {
  return database()
    .prepare(`
      SELECT cursor, observed_at, hash, event_type, observation_json, event_json
      FROM desktop_observations
      WHERE cursor > ?
      ORDER BY cursor ASC
      LIMIT ?
    `)
    .all(Number(after || 0), Number(limit || 100))
    .map((row) => {
      const desktop = fromJson(row.observation_json, {});
      const event = fromJson(row.event_json, null);
      return {
        ...(event || {}),
        type: event?.type || row.event_type || "desktop.snapshot",
        cursor: row.cursor,
        observedAt: event?.observedAt || row.observed_at,
        hash: row.hash,
        desktop: event?.desktop || desktop
      };
    });
}

// ───────── Live Call persistence ─────────

export function createLiveCall(input = {}) {
  const current = nowIso();
  const id = input.id || crypto.randomUUID();
  database()
    .prepare(`
      INSERT INTO live_calls (
        id, status, title, source, workspace_id, agent_task_id, asr_provider,
        created_at, updated_at, started_at, stopped_at,
        last_transcript, last_question, last_answer, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      cleanString(input.status || "ready", 40),
      cleanString(input.title || "Live Call", 160),
      cleanString(input.source || "live-call-mvp", 120),
      cleanString(input.workspaceId || "", 160),
      cleanString(input.agentTaskId || "", 80),
      cleanString(input.asrProvider || "", 60),
      input.createdAt || current,
      input.updatedAt || current,
      input.startedAt || current,
      input.stoppedAt || "",
      cleanString(input.lastTranscript || "", 4000),
      cleanString(input.lastQuestion || "", 4000),
      cleanString(input.lastAnswer || "", 8000),
      toJson(input.meta || null)
    );
  return getLiveCall(id);
}

export function getLiveCall(id) {
  const row = database().prepare("SELECT * FROM live_calls WHERE id = ?").get(id);
  return publicLiveCall(row);
}

export function listLiveCalls({ workspaceId = "", limit = 200 } = {}) {
  return database()
    .prepare(`
      SELECT * FROM live_calls
      WHERE (? = '' OR workspace_id = ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .all(cleanString(workspaceId, 160), cleanString(workspaceId, 160), Number(limit || 200))
    .map(publicLiveCall)
    .filter(Boolean);
}

export function updateLiveCall(id, patch = {}) {
  const existing = database().prepare("SELECT * FROM live_calls WHERE id = ?").get(id);
  if (!existing) return null;
  const current = nowIso();
  const next = {
    status: patch.status ?? existing.status,
    title: patch.title ?? existing.title,
    source: patch.source ?? existing.source,
    workspace_id: patch.workspaceId ?? existing.workspace_id ?? "",
    agent_task_id: patch.agentTaskId ?? existing.agent_task_id ?? "",
    asr_provider: patch.asrProvider ?? existing.asr_provider ?? "",
    updated_at: current,
    started_at: patch.startedAt ?? existing.started_at ?? "",
    stopped_at: patch.stoppedAt ?? existing.stopped_at ?? "",
    last_transcript: patch.lastTranscript ?? existing.last_transcript ?? "",
    last_question: patch.lastQuestion ?? existing.last_question ?? "",
    last_answer: patch.lastAnswer ?? existing.last_answer ?? "",
    meta_json: patch.meta === undefined ? existing.meta_json : toJson(patch.meta || null)
  };
  database()
    .prepare(`
      UPDATE live_calls SET
        status = ?, title = ?, source = ?, workspace_id = ?, agent_task_id = ?, asr_provider = ?,
        updated_at = ?, started_at = ?, stopped_at = ?,
        last_transcript = ?, last_question = ?, last_answer = ?, meta_json = ?
      WHERE id = ?
    `)
    .run(
      cleanString(next.status, 40),
      cleanString(next.title, 160),
      cleanString(next.source, 120),
      cleanString(next.workspace_id, 160),
      cleanString(next.agent_task_id, 80),
      cleanString(next.asr_provider, 60),
      next.updated_at,
      next.started_at,
      next.stopped_at,
      cleanString(next.last_transcript, 4000),
      cleanString(next.last_question, 4000),
      cleanString(next.last_answer, 8000),
      next.meta_json,
      id
    );
  return getLiveCall(id);
}

export function insertLiveCallEvent(sessionId, event = {}) {
  return eventStoreSyncCall("insertLiveCallEvent", () => sqliteEventStore().insertLiveCallEvent(sessionId, event));
}

export function insertLiveCallEvents(sessionId, events = []) {
  return eventStoreSyncCall("insertLiveCallEvents", () => sqliteEventStore().insertLiveCallEvents(sessionId, events));
}

export async function insertLiveCallEventAsync(sessionId, event = {}) {
  return eventStoreWorkerCall(
    "insertLiveCallEvent",
    [sessionId, event],
    () => sqliteEventStore().insertLiveCallEvent(sessionId, event)
  );
}

export async function insertLiveCallEventsAsync(sessionId, events = []) {
  return eventStoreWorkerCall(
    "insertLiveCallEvents",
    [sessionId, events],
    () => sqliteEventStore().insertLiveCallEvents(sessionId, events)
  );
}

export async function insertLiveCallEventBatchedAsync(sessionId, event = {}) {
  if (!isLiveCallEventBatchAppendEnabled()) return insertLiveCallEventAsync(sessionId, event);
  return liveCallEventBatcher().enqueue(cleanString(sessionId, 160), event);
}

export async function flushLiveCallEventBatches() {
  if (!liveCallEventAppendBatcher) return [];
  return liveCallEventAppendBatcher.flushNow();
}

export function listLiveCallEvents({ sessionId = "", after = 0, limit = DEFAULT_EVENT_REPLAY_LIMIT } = {}) {
  return sqliteEventStore().listLiveCallEvents({ sessionId, after, limit });
}

export async function listLiveCallEventsAsync({ sessionId = "", after = 0, limit = DEFAULT_EVENT_REPLAY_LIMIT } = {}) {
  return eventStoreWorkerCall(
    "listLiveCallEvents",
    [{ sessionId, after, limit }],
    () => listLiveCallEvents({ sessionId, after, limit })
  );
}

export function pruneLiveCallEvents({ retentionDays = 30, keepLatest = 5000 } = {}) {
  return sqliteEventStore().pruneLiveCallEvents({ retentionDays, keepLatest });
}

function publicLiveCall(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    source: row.source,
    workspaceId: row.workspace_id || "",
    agentTaskId: row.agent_task_id || "",
    asrProvider: row.asr_provider || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || "",
    stoppedAt: row.stopped_at || "",
    lastTranscript: row.last_transcript || "",
    lastQuestion: row.last_question || "",
    lastAnswer: row.last_answer || "",
    remote: null,
    local: null
  };
}

// ───────── Unified event log ─────────

/**
 * Query events from all three event tables (task_events, tool_events,
 * live_call_events) in cursor order, filtered by an optional foreign key.
 *
 * Parameters:
 *   - taskId: filter by task_events.task_id / tool_events.task_id
 *   - liveCallSessionId: filter by live_call_events.session_id
 *   - toolRunId: filter by tool_events.tool_run_id
 *   - after: minimum cursor (numeric)
 *   - limit: max rows
 *
 * Each event is normalized to a uniform shape:
 *   { cursor, eventId, type, kind, at, text, sessionId, taskId, toolRunId, turnId, blockId }
 */
export function listUnifiedEvents({
  taskId = "",
  liveCallSessionId = "",
  toolRunId = "",
  after = 0,
  limit = 200
} = {}) {
  return sqliteEventStore().listUnifiedEvents({ taskId, liveCallSessionId, toolRunId, after, limit });
}

export function replayEventWindow({
  taskId = "",
  liveCallSessionId = "",
  toolRunId = "",
  after = 0,
  limit = 200
} = {}) {
  return sqliteEventStore().replayWindow({ taskId, liveCallSessionId, toolRunId, after, limit });
}

export async function listUnifiedEventsAsync({
  taskId = "",
  liveCallSessionId = "",
  toolRunId = "",
  after = 0,
  limit = 200
} = {}) {
  return eventStoreWorkerCall(
    "listUnifiedEvents",
    [{ taskId, liveCallSessionId, toolRunId, after, limit }],
    () => listUnifiedEvents({ taskId, liveCallSessionId, toolRunId, after, limit })
  );
}

export async function replayEventWindowAsync({
  taskId = "",
  liveCallSessionId = "",
  toolRunId = "",
  after = 0,
  limit = 200
} = {}) {
  return eventStoreWorkerCall(
    "replayWindow",
    [{ taskId, liveCallSessionId, toolRunId, after, limit }],
    () => replayEventWindow({ taskId, liveCallSessionId, toolRunId, after, limit })
  );
}

// ── MCP tool cache ──

export function storeMcpTools(serverName, tools = []) {
  const db = database();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO mcp_tools (server_name, tool_name, full_name, title, description, input_schema, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  db.exec("BEGIN");
  try {
    for (const tool of tools) {
      insert.run(
        serverName,
        tool.name || "",
        tool.fullName || `${serverName}__${tool.name || "unknown"}`,
        tool.title || "",
        tool.description || "",
        tool.inputSchema ? JSON.stringify(tool.inputSchema) : null
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return tools.length;
}

export function getCachedMcpTools() {
  const rows = database().prepare(`
    SELECT server_name, tool_name, full_name, title, description, input_schema, discovered_at, last_seen_at
    FROM mcp_tools
    ORDER BY server_name, tool_name
  `).all();
  return rows.map((row) => ({
    ...row,
    inputSchema: row.input_schema ? JSON.parse(row.input_schema) : null
  }));
}

export function clearStaleMcpTools(maxAgeDays = 7) {
  const result = database().prepare(`
    DELETE FROM mcp_tools WHERE last_seen_at < datetime('now', '-' || ? || ' days')
  `).run(String(maxAgeDays));
  return result.changes;
} 
