import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";
import { createThreadForkInDb, getThreadStateFromDb, importThreadState, upsertThreadMeta } from "./db.js";

const statePath = path.join(dataDir, "thread-state.json");

function nowIso() {
  return new Date().toISOString();
}

function emptyState() {
  return {
    version: 1,
    items: {},
    forks: []
  };
}

function cleanString(value, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function loadState() {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return {
      ...emptyState(),
      ...parsed,
      items: parsed.items && typeof parsed.items === "object" ? parsed.items : {},
      forks: Array.isArray(parsed.forks) ? parsed.forks : []
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyState();
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

function publicState(state) {
  return {
    version: state.version || 1,
    items: state.items || {},
    forks: (state.forks || []).filter((item) => item && item.id)
  };
}

let importedLegacyState = false;

function ensureLegacyImported() {
  if (importedLegacyState) return;
  importedLegacyState = true;

  try {
    if (fs.existsSync(statePath)) importThreadState(loadState());
  } catch {
    // Legacy JSON import is best-effort; SQLite remains the primary state store.
  }
}

export function getThreadState() {
  ensureLegacyImported();
  return getThreadStateFromDb();
}

export function updateThreadState(key, patch = {}) {
  const cleanKey = cleanString(key, 320);
  if (!cleanKey) throw new Error("Thread key is required.");

  ensureLegacyImported();
  return upsertThreadMeta(cleanKey, patch);
}

export function updateThreadStateBatch(updates = []) {
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("At least one thread update is required.");
  let state;
  for (const update of updates.slice(0, 200)) state = updateThreadState(update?.key, update?.patch || {});
  return state || getThreadState();
}

export function createThreadFork(payload = {}) {
  const sourceKey = cleanString(payload.sourceKey, 320);
  const provider = payload.provider === "claude" ? "claude" : "codex";
  const sourceId = cleanString(payload.sourceId || payload.sessionId || payload.id, 320);
  if (!sourceKey || !sourceId) throw new Error("Fork source is required.");

  ensureLegacyImported();
  return createThreadForkInDb({
    id: crypto.randomUUID(),
    sourceKey,
    sourceId,
    provider,
    title: cleanString(payload.title, 160) || "Forked thread",
    cwd: cleanString(payload.cwd, 500),
    group: cleanString(payload.group, 80),
    pinned: Boolean(payload.pinned),
    archived: false
  });
}
