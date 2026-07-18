import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const SKIP_DIRS = new Set([".git", ".gradle", ".idea", ".next", ".turbo", ".vscode", "build", "coverage", "dist", "node_modules", "target"]);

function cleanWorkspace(workspace = {}) {
  return {
    id: String(workspace.id || "").trim(),
    path: path.resolve(String(workspace.path || "")),
    title: String(workspace.title || "").trim()
  };
}

function relativeWorkspacePath(root, candidate) {
  const relative = path.relative(root, candidate).replaceAll("\\", "/");
  if (!relative || relative === "." || relative.startsWith("../") || path.isAbsolute(relative)) return "";
  return relative;
}

function shouldSkipEntry(entry) {
  if (entry.name.startsWith(".") && entry.name !== ".env.example") return true;
  return entry.isDirectory() && SKIP_DIRS.has(entry.name);
}

async function readIndexContent(filePath, size, maxContentBytes) {
  if (size > maxContentBytes) return "";
  try {
    const buffer = await fs.promises.readFile(filePath);
    if (buffer.includes(0)) return "";
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

async function scanWorkspace(root, maxFiles) {
  const files = [];
  const stack = [root];
  let complete = true;

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (shouldSkipEntry(entry)) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.stat(absolutePath);
        files.push({
          absolutePath,
          path: relativeWorkspacePath(root, absolutePath),
          size: stat.size,
          mtimeMs: Math.trunc(stat.mtimeMs)
        });
      } catch {
        continue;
      }
      if (files.length >= maxFiles) {
        complete = false;
        stack.length = 0;
        break;
      }
    }
  }

  return { files: files.filter((item) => item.path), complete };
}

export function createWorkspaceSearchIndexer({
  store,
  getWorkspaces,
  maxContentBytes = DEFAULT_MAX_CONTENT_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  watch = fs.watch,
  enableWatchers = process.env.VIBELINK_SEARCH_INDEX_WATCH === "1" || (process.platform !== "win32" && process.env.VIBELINK_SEARCH_INDEX_WATCH !== "0"),
  logger = console
} = {}) {
  if (!store) throw new Error("Workspace search indexer requires a search store.");
  if (typeof getWorkspaces !== "function") throw new Error("Workspace search indexer requires getWorkspaces.");

  const watchers = new Map();
  const debounceTimers = new Map();
  const pendingPaths = new Map();
  const workspaceQueues = new Map();
  let refreshTimer = null;
  let started = false;
  let stopping = false;
  const state = {
    ready: false,
    running: false,
    indexedFiles: 0,
    indexedWorkspaces: 0,
    changedFiles: 0,
    deletedFiles: 0,
    lastStartedAt: "",
    lastCompletedAt: "",
    lastError: ""
  };

  function updateCounts() {
    const counts = store.stats();
    state.indexedFiles = counts.files;
    state.indexedWorkspaces = counts.workspaces;
  }

  function queueWorkspace(workspace, operation) {
    const clean = cleanWorkspace(workspace);
    const previous = workspaceQueues.get(clean.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => operation(clean));
    workspaceQueues.set(clean.id, next);
    const settled = () => {
      if (workspaceQueues.get(clean.id) === next) workspaceQueues.delete(clean.id);
    };
    next.then(settled, settled);
    return next;
  }

  async function refreshWorkspaceNow(workspace) {
    if (!workspace.id || !workspace.path) return { workspaceId: workspace.id, changed: 0, deleted: 0, skipped: true };
    let rootStat;
    try {
      rootStat = await fs.promises.stat(workspace.path);
    } catch {
      const deleted = store.removeWorkspace(workspace.id);
      return { workspaceId: workspace.id, changed: 0, deleted, missing: true };
    }
    if (!rootStat.isDirectory()) return { workspaceId: workspace.id, changed: 0, deleted: 0, skipped: true };

    const existing = new Map(store.listWorkspaceMetadata(workspace.id).map((item) => [item.path, item]));
    const snapshot = await scanWorkspace(workspace.path, maxFiles);
    const seen = new Set();
    const upserts = [];
    for (const file of snapshot.files) {
      seen.add(file.path);
      const previous = existing.get(file.path);
      if (previous && previous.size === file.size && previous.mtimeMs === file.mtimeMs) continue;
      upserts.push({
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        content: await readIndexContent(file.absolutePath, file.size, maxContentBytes),
        indexable: true
      });
    }
    const deletedPaths = snapshot.complete ? [...existing.keys()].filter((relativePath) => !seen.has(relativePath)) : [];
    store.applyWorkspaceChanges(workspace.id, { upserts, deletedPaths });
    state.changedFiles += upserts.length;
    state.deletedFiles += deletedPaths.length;
    return { workspaceId: workspace.id, changed: upserts.length, deleted: deletedPaths.length, complete: snapshot.complete };
  }

  function refreshWorkspace(workspace) {
    return queueWorkspace(workspace, refreshWorkspaceNow);
  }

  async function refreshPathsNow(workspace, paths = []) {
    const upserts = [];
    const deletedPaths = [];
    for (const relativePath of [...new Set(paths.map((value) => String(value || "").replaceAll("\\", "/")).filter(Boolean))]) {
      const absolutePath = path.resolve(workspace.path, relativePath);
      const cleanRelativePath = relativeWorkspacePath(workspace.path, absolutePath);
      if (!cleanRelativePath) continue;
      let stat;
      try {
        stat = await fs.promises.stat(absolutePath);
      } catch {
        deletedPaths.push(cleanRelativePath);
        continue;
      }
      if (stat.isDirectory()) return refreshWorkspaceNow(workspace);
      if (!stat.isFile()) continue;
      upserts.push({
        path: cleanRelativePath,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        content: await readIndexContent(absolutePath, stat.size, maxContentBytes),
        indexable: true
      });
    }
    store.applyWorkspaceChanges(workspace.id, { upserts, deletedPaths });
    state.changedFiles += upserts.length;
    state.deletedFiles += deletedPaths.length;
    updateCounts();
    return { workspaceId: workspace.id, changed: upserts.length, deleted: deletedPaths.length, complete: true };
  }

  function refreshPaths(workspace, paths = []) {
    return queueWorkspace(workspace, (clean) => refreshPathsNow(clean, paths));
  }

  function schedulePaths(workspace, changedPath) {
    if (stopping) return;
    const workspaceId = workspace.id;
    if (!pendingPaths.has(workspaceId)) pendingPaths.set(workspaceId, new Set());
    if (changedPath) pendingPaths.get(workspaceId).add(String(changedPath));
    clearTimeout(debounceTimers.get(workspaceId));
    const timer = setTimeout(() => {
      debounceTimers.delete(workspaceId);
      const paths = [...(pendingPaths.get(workspaceId) || [])];
      pendingPaths.delete(workspaceId);
      const refresh = paths.length ? refreshPaths(workspace, paths) : refreshWorkspace(workspace);
      refresh.catch((error) => {
        state.lastError = error.message;
        logger.error?.(`[search-index] incremental refresh failed for ${workspace.path}: ${error.message}`);
      });
    }, 300);
    timer.unref?.();
    debounceTimers.set(workspaceId, timer);
  }

  function reconcileWatchers(workspaces) {
    if (!enableWatchers) return;
    const activeIds = new Set(workspaces.map((workspace) => workspace.id));
    for (const [workspaceId, watcher] of watchers) {
      if (activeIds.has(workspaceId)) continue;
      try { watcher.close(); } catch {}
      watchers.delete(workspaceId);
    }
    for (const workspace of workspaces) {
      if (!workspace.id || !workspace.path || watchers.has(workspace.id)) continue;
      try {
        const watcher = watch(workspace.path, { recursive: true }, (_eventType, filename) => {
          schedulePaths(workspace, filename ? String(filename) : "");
        });
        watcher.on?.("error", (error) => {
          state.lastError = error.message;
          try { watcher.close(); } catch {}
          watchers.delete(workspace.id);
        });
        watchers.set(workspace.id, watcher);
      } catch {
        // Recursive watching is not available on every platform; the periodic refresh remains authoritative.
      }
    }
  }

  async function refreshAll() {
    if (stopping) return [];
    state.running = true;
    state.lastStartedAt = new Date().toISOString();
    state.lastError = "";
    try {
      const workspaces = (await Promise.resolve(getWorkspaces())).map(cleanWorkspace).filter((item) => item.id && item.path);
      const results = [];
      for (const workspace of workspaces) results.push(await refreshWorkspace(workspace));
      store.removeMissingWorkspaces(workspaces.map((workspace) => workspace.id));
      reconcileWatchers(workspaces);
      updateCounts();
      state.ready = true;
      state.lastCompletedAt = new Date().toISOString();
      return results;
    } catch (error) {
      state.lastError = error.message;
      throw error;
    } finally {
      state.running = false;
    }
  }

  async function start() {
    if (started) return status();
    started = true;
    stopping = false;
    await refreshAll();
    refreshTimer = setInterval(() => {
      refreshAll().catch((error) => {
        state.lastError = error.message;
        logger.error?.(`[search-index] periodic refresh failed: ${error.message}`);
      });
    }, Math.max(Number(refreshIntervalMs) || DEFAULT_REFRESH_INTERVAL_MS, 1000));
    refreshTimer.unref?.();
    return status();
  }

  async function stop() {
    stopping = true;
    started = false;
    clearInterval(refreshTimer);
    refreshTimer = null;
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    pendingPaths.clear();
    for (const watcher of watchers.values()) {
      try { watcher.close(); } catch {}
    }
    watchers.clear();
    await Promise.allSettled([...workspaceQueues.values()]);
  }

  function status() {
    return {
      ...state,
      started,
      watchers: watchers.size,
      pendingWorkspaces: workspaceQueues.size,
      refreshIntervalMs: Math.max(Number(refreshIntervalMs) || DEFAULT_REFRESH_INTERVAL_MS, 1000),
      maxContentBytes,
      maxFiles
    };
  }

  return { refreshAll, refreshPaths, refreshWorkspace, start, status, stop };
}
