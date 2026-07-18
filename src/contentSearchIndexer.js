import fs from "node:fs";
import { historySearchEntry } from "./history.js";

const DEFAULT_REFRESH_INTERVAL_MS = 15_000;
const PAGE_SIZE = 1000;

function sourceKey(kind, provider, id) {
  return `${kind}:${provider}:${id}`;
}

function readAppendedJsonl(filePath, offset) {
  const buffer = fs.readFileSync(filePath);
  const start = Math.min(Math.max(Number(offset) || 0, 0), buffer.length);
  const tail = buffer.subarray(start);
  const lastNewline = Math.max(tail.lastIndexOf(10), tail.lastIndexOf(13));
  if (lastNewline < 0) return { entries: [], byteOffset: start };
  const consumed = tail.subarray(0, lastNewline + 1).toString("utf8");
  return {
    entries: consumed.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }),
    byteOffset: start + Buffer.byteLength(consumed)
  };
}

export function createContentSearchIndexer({ store, getHistories, getTasks, listTaskEvents, refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS, logger = console } = {}) {
  if (!store || typeof getHistories !== "function" || typeof getTasks !== "function" || typeof listTaskEvents !== "function") {
    throw new Error("Content search indexer requires store and source readers.");
  }
  let timer = null;
  let running = false;
  let refreshPromise = null;

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = Promise.resolve().then(() => {
      running = true;
      store.checkContentIndex();
      const histories = getHistories() || [];
      const tasks = getTasks() || [];
      const activeKeys = [];
      let changed = 0;

      for (const history of histories) {
        const key = sourceKey("agent", history.provider, history.id);
        activeKeys.push(key);
        const previous = store.getContentSource(key);
        let stat = null;
        try { stat = history.filePath ? fs.statSync(history.filePath) : null; } catch {}
        const reset = Boolean(previous && (!stat || stat.size < previous.byteOffset || previous.filePath !== (history.filePath || "")));
        const offset = reset ? 0 : previous?.byteOffset || 0;
        const read = stat ? readAppendedJsonl(history.filePath, offset) : { entries: [], byteOffset: 0 };
        let cursor = reset ? 0 : previous?.eventCursor || 0;
        const sessionDocument = {
          eventCursor: 0, kind: "history", id: history.id, provider: history.provider,
          title: history.title || history.id, content: history.preview || history.title || "", updatedAt: history.updatedAt || ""
        };
        const previousSessionDocument = store.getContentDocument(key, 0);
        const upserts = reset || !previousSessionDocument ||
          previousSessionDocument.title !== sessionDocument.title ||
          previousSessionDocument.content !== sessionDocument.content ||
          previousSessionDocument.updatedAt !== sessionDocument.updatedAt
          ? [sessionDocument] : [];
        for (const raw of read.entries) {
          cursor += 1;
          const entry = historySearchEntry(raw);
          if (!entry) continue;
          upserts.push({
            eventCursor: cursor, kind: "message", id: history.id, provider: history.provider,
            title: history.title || history.id, content: entry.text, turnId: entry.turnId,
            updatedAt: entry.timestamp || history.updatedAt || ""
          });
        }
        store.applyContentChanges({
          sourceKey: key, provider: history.provider, sessionId: history.id, sourceKind: "agent",
          filePath: history.filePath || "", byteOffset: read.byteOffset, eventCursor: cursor,
          sourceSize: stat?.size || 0, sourceMtimeMs: Math.trunc(stat?.mtimeMs || 0)
        }, { upserts, reset });
        changed += upserts.length;
      }

      for (const task of tasks) {
        const key = sourceKey("task", task.agent, task.id);
        activeKeys.push(key);
        const previous = store.getContentSource(key);
        let cursor = previous?.eventCursor || 0;
        const previousTaskDocument = store.getContentDocument(key, 0);
        const taskMetadata = [task.title, task.commandLabel, task.status, task.cwd].filter(Boolean).join("\n");
        const newTaskText = [];
        const upserts = [];
        while (true) {
          const events = listTaskEvents(task.id, { after: cursor, limit: PAGE_SIZE });
          if (!events.length) break;
          for (const event of events) {
            cursor = Math.max(cursor, Number(event.cursor || 0));
            const content = typeof event.text === "string" && event.text ? event.text : JSON.stringify(event.payload || "");
            if (!content) continue;
            newTaskText.push(content);
            upserts.push({
              eventCursor: Number(event.cursor), kind: "message", id: task.sessionId || task.id, provider: task.agent,
              title: task.title || task.id, content, turnId: event.turnId || "", updatedAt: event.at || task.updatedAt || ""
            });
          }
          if (events.length < PAGE_SIZE) break;
        }
        const previousContent = previousTaskDocument?.content || "";
        const taskContent = [previousContent || taskMetadata, ...newTaskText]
          .filter(Boolean).join("\n").slice(-1024 * 1024);
        const taskDocument = {
          eventCursor: 0, kind: "task", id: task.id, provider: task.agent,
          title: task.title || task.id, content: taskContent, updatedAt: task.updatedAt || ""
        };
        if (!previousTaskDocument || previousTaskDocument.title !== taskDocument.title ||
          previousTaskDocument.content !== taskDocument.content || previousTaskDocument.updatedAt !== taskDocument.updatedAt) {
          upserts.unshift(taskDocument);
        }
        store.applyContentChanges({
          sourceKey: key, provider: task.agent, sessionId: task.sessionId || task.id, sourceKind: "task",
          eventCursor: cursor
        }, { upserts });
        changed += upserts.length;
      }
      const removed = store.removeMissingContentSources(activeKeys);
      return { changed, removed, sources: activeKeys.length };
    }).finally(() => { running = false; refreshPromise = null; });
    return refreshPromise;
  }

  async function start() {
    await refresh();
    timer = setInterval(() => void refresh().catch((error) => logger.error(`[content-search-index] ${error.message}`)), refreshIntervalMs);
    timer.unref?.();
    setImmediate(() => {
      if (timer) void refresh().catch((error) => logger.error(`[content-search-index] ${error.message}`));
    });
    return status();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await refreshPromise;
  }

  function status() {
    return { running, started: Boolean(timer), ...store.contentStats() };
  }

  return { refresh, start, status, stop };
}
