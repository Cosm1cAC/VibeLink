import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "./config.js";

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

    CREATE TABLE IF NOT EXISTS desktop_observations (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      workspace_id TEXT,
      observed_at TEXT NOT NULL,
      hash TEXT NOT NULL,
      found INTEGER NOT NULL DEFAULT 0,
      ready INTEGER NOT NULL DEFAULT 0,
      running_count INTEGER NOT NULL DEFAULT 0,
      transcript_count INTEGER NOT NULL DEFAULT 0,
      observation_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_desktop_observations_cursor ON desktop_observations(cursor);
    CREATE INDEX IF NOT EXISTS idx_desktop_observations_hash ON desktop_observations(hash);

    CREATE TABLE IF NOT EXISTS settings_kv (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  try { db.exec("ALTER TABLE tasks ADD COLUMN workspace_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE desktop_observations ADD COLUMN workspace_id TEXT"); } catch {}

  return db;
}

function database() {
  return initDb();
}

export function getDbPath() {
  return dbPath;
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

export function createDevice({ label = "Device", token }) {
  const current = nowIso();
  const deviceToken = token || crypto.randomBytes(32).toString("hex");
  const device = {
    id: crypto.randomUUID(),
    label: cleanString(label, 120) || "Device",
    token: deviceToken,
    createdAt: current,
    lastSeenAt: current
  };

  database()
    .prepare(`
      INSERT INTO devices (id, label, token_hash, created_at, last_seen_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `)
    .run(device.id, device.label, hashToken(deviceToken), current, current);

  return device;
}

export function findDeviceByToken(token) {
  const row = database()
    .prepare("SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
    .get(hashToken(token));
  if (!row) return null;

  database().prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(nowIso(), row.id);
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at || "",
    revokedAt: row.revoked_at || ""
  };
}

export function listDevices() {
  return database()
    .prepare("SELECT id, label, created_at, last_seen_at, revoked_at FROM devices ORDER BY COALESCE(last_seen_at, created_at) DESC")
    .all()
    .map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at || "",
      revokedAt: row.revoked_at || ""
    }));
}

export function revokeDevice(id) {
  const result = database().prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id);
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
      toJson({ restored: Boolean(task.restored) })
    );
}

export function insertTaskEvent(taskId, event) {
  const current = nowIso();
  const eventAt = event.at || current;
  const eventId = event.id || `${taskId}:${eventAt}:${Math.random()}`;
  const payload = event.payload === undefined ? null : event.payload;
  const eventJson = {
    ...event,
    id: eventId,
    at: eventAt
  };

  database()
    .prepare(`
      INSERT OR IGNORE INTO task_events (
        task_id, event_id, event_type, event_at, text, payload_json, event_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      taskId,
      eventId,
      event.type || "",
      eventAt,
      typeof event.text === "string" ? event.text : "",
      toJson(payload),
      toJson(eventJson),
      current
    );

  const row = database()
    .prepare("SELECT cursor FROM task_events WHERE task_id = ? AND event_id = ?")
    .get(taskId, eventId);
  return row?.cursor || null;
}

export function listTaskEvents(taskId, { after = 0, limit = 5000 } = {}) {
  return database()
    .prepare(`
      SELECT cursor, event_json
      FROM task_events
      WHERE task_id = ? AND cursor > ?
      ORDER BY cursor ASC
      LIMIT ?
    `)
    .all(taskId, Number(after || 0), Number(limit || 5000))
    .map((row) => ({
      ...fromJson(row.event_json, {}),
      cursor: row.cursor
    }));
}

export function getTaskEventCount(taskId) {
  const row = database().prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?").get(taskId);
  return Number(row?.count || 0);
}

export function getThreadStateFromDb() {
  const itemRows = database().prepare("SELECT * FROM threads ORDER BY updated_at DESC").all();
  const forkRows = database().prepare("SELECT * FROM thread_forks ORDER BY updated_at DESC").all();
  const items = {};

  for (const row of itemRows) {
    items[row.key] = {
      ...(fromJson(row.meta_json, {}) || {}),
      key: row.key,
      title: row.title || "",
      group: row.group_name || "",
      pinned: rowBool(row.pinned),
      archived: rowBool(row.archived),
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

export function upsertThreadMeta(key, patch = {}) {
  const cleanKey = cleanString(key, 320);
  if (!cleanKey) throw new Error("Thread key is required.");

  const existing = database().prepare("SELECT * FROM threads WHERE key = ?").get(cleanKey);
  const current = nowIso();
  const next = {
    title: Object.hasOwn(patch, "title") ? cleanString(patch.title, 160) : existing?.title || "",
    group: Object.hasOwn(patch, "group") ? cleanString(patch.group, 80) : existing?.group_name || "",
    pinned: Object.hasOwn(patch, "pinned") ? Boolean(patch.pinned) : rowBool(existing?.pinned),
    archived: Object.hasOwn(patch, "archived") ? Boolean(patch.archived) : rowBool(existing?.archived),
    meta: {
      ...(fromJson(existing?.meta_json, {}) || {}),
      ...(patch.meta && typeof patch.meta === "object" ? patch.meta : {})
    }
  };

  database()
    .prepare(`
      INSERT INTO threads (
        key, provider, session_id, workspace_id, title, group_name, pinned,
        archived, source, meta_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        title = excluded.title,
        group_name = excluded.group_name,
        pinned = excluded.pinned,
        archived = excluded.archived,
        meta_json = excluded.meta_json,
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
      existing?.created_at || current,
      current
    );

  if (cleanKey.startsWith("fork:")) {
    const forkId = cleanKey.slice("fork:".length);
    database()
      .prepare(`
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

  return getThreadStateFromDb();
}

export function createThreadForkInDb(payload = {}) {
  const id = payload.id || crypto.randomUUID();
  const current = nowIso();
  const fork = {
    id,
    sourceKey: cleanString(payload.sourceKey, 320),
    sourceId: cleanString(payload.sourceId || payload.sessionId || payload.id, 320),
    provider: payload.provider === "claude" ? "claude" : "codex",
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

export function recordDesktopObservation(desktop, { source = "codex-desktop-ui" } = {}) {
  if (!desktop || typeof desktop !== "object") return null;

  const observedAt = desktop.updatedAt || nowIso();
  const hashSource = [
    desktop.found ? "found" : "missing",
    desktop.ready ? "ready" : "not-ready",
    desktop.sidebarRunningCount || 0,
    desktop.visibleTranscriptHash || "",
    JSON.stringify((desktop.conversations || []).map((item) => [item.title, item.running])),
    JSON.stringify((desktop.projects || []).map((item) => item.title))
  ].join("\n");
  const hash = crypto.createHash("sha1").update(hashSource).digest("hex").slice(0, 20);

  const previous = database()
    .prepare("SELECT hash FROM desktop_observations ORDER BY cursor DESC LIMIT 1")
    .get();
  if (previous?.hash === hash) return null;

  database()
    .prepare(`
      INSERT INTO desktop_observations (
        source, workspace_id, observed_at, hash, found, ready, running_count,
        transcript_count, observation_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      source,
      desktop.workspaceId || "",
      observedAt,
      hash,
      boolInt(desktop.found),
      boolInt(desktop.ready),
      Number(desktop.sidebarRunningCount || 0),
      Number(desktop.visibleTranscriptCount || desktop.visibleTranscript?.length || 0),
      toJson(desktop),
      nowIso()
    );

  const row = database()
    .prepare("SELECT cursor FROM desktop_observations WHERE hash = ? ORDER BY cursor DESC LIMIT 1")
    .get(hash);
  const cursor = row?.cursor || null;
  return cursor
    ? {
        cursor,
        type: "desktop.snapshot",
        source,
        observedAt,
        desktop
      }
    : null;
}

export function listDesktopObservations({ after = 0, limit = 100 } = {}) {
  return database()
    .prepare(`
      SELECT cursor, observed_at, hash, observation_json
      FROM desktop_observations
      WHERE cursor > ?
      ORDER BY cursor ASC
      LIMIT ?
    `)
    .all(Number(after || 0), Number(limit || 100))
    .map((row) => ({
      cursor: row.cursor,
      observedAt: row.observed_at,
      hash: row.hash,
      desktop: fromJson(row.observation_json, {})
    }));
}
