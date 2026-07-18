import { initDb } from "./db.js";
import { createWorkspaceSearchIndexer } from "./searchIndexer.js";
import { createSearchStore, searchValues } from "./searchStore.js";

const store = createSearchStore({ database: initDb });
let indexer = null;

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function snippet(text, query) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  const index = value.toLowerCase().indexOf(query);
  if (index < 0) return value.slice(0, 240);
  const start = Math.max(0, index - 80);
  return `${start > 0 ? "..." : ""}${value.slice(start, index + Math.max(query.length, 160))}${index + 160 < value.length ? "..." : ""}`;
}

function textRelevance(title, text, query) {
  const normalizedTitle = normalize(title);
  const normalizedText = normalize(text);
  let score = normalizedTitle === query ? 100 : normalizedTitle.includes(query) ? 25 : 0;
  let index = normalizedText.indexOf(query);
  while (index >= 0 && score < 100) {
    score += 1;
    index = normalizedText.indexOf(query, index + Math.max(query.length, 1));
  }
  return score;
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base", numeric: true });
}

function resultComparator(sort, order) {
  const direction = order === "asc" ? 1 : -1;
  return (left, right) => {
    let compared = 0;
    if (sort === "title") compared = compareText(left.title, right.title);
    else if (sort === "kind") compared = compareText(left.kind, right.kind);
    else if (sort === "updatedAt") compared = (Date.parse(left.updatedAt || "") || 0) - (Date.parse(right.updatedAt || "") || 0);
    else compared = Number(left.relevance || 0) - Number(right.relevance || 0);
    if (compared) return compared * direction;
    const updated = (Date.parse(right.updatedAt || "") || 0) - (Date.parse(left.updatedAt || "") || 0);
    if (updated) return updated;
    return compareText(`${left.kind}:${left.id}:${left.turnId || ""}:${left.path || ""}`, `${right.kind}:${right.id}:${right.turnId || ""}:${right.path || ""}`);
  };
}

export function searchContent({
  query,
  scope = "all",
  limit = 50,
  cursor = "0",
  tag = "",
  favorite = false,
  sort = "relevance",
  order = "",
  histories = [],
  tasks = [],
  fileResults = [],
  historyDetails = new Map(),
  threadState = { items: {} }
}) {
  const normalizedQuery = normalize(query);
  const normalizedScope = searchValues.normalizeScope(scope);
  const normalizedSort = searchValues.normalizeSort(sort);
  const normalizedOrder = searchValues.normalizeOrder(order, normalizedSort);
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(cursor, 10) || 0, 0);
  if (!normalizedQuery) {
    return {
      items: [], query: "", scope: normalizedScope, sort: normalizedSort, order: normalizedOrder,
      total: 0, limit: pageSize, cursor: String(offset), nextCursor: ""
    };
  }

  const matches = [];
  const allow = (name) => normalizedScope === "all" || normalizedScope === name;
  if (allow("sessions")) {
    for (const item of histories) {
      const haystack = JSON.stringify(item);
      if (!normalize(haystack).includes(normalizedQuery)) continue;
      matches.push({
        kind: "history",
        id: item.id || "",
        provider: item.provider || "",
        title: item.title || item.id || "History",
        snippet: snippet(item.preview || item.lastMessage, normalizedQuery),
        updatedAt: item.updatedAt || "",
        relevance: textRelevance(item.title, haystack, normalizedQuery)
      });
    }
  }
  if (allow("tasks")) {
    for (const item of tasks) {
      const haystack = JSON.stringify(item);
      if (!normalize(haystack).includes(normalizedQuery)) continue;
      matches.push({
        kind: "task",
        id: item.id || "",
        provider: item.agent || "",
        title: item.title || item.id || "Task",
        snippet: snippet(item.preview || item.status, normalizedQuery),
        updatedAt: item.updatedAt || "",
        relevance: textRelevance(item.title, haystack, normalizedQuery)
      });
    }
  }
  if (allow("messages")) {
    for (const item of histories) {
      const detail = historyDetails.get(`${item.provider}:${item.id}`);
      for (const message of detail?.transcript || []) {
        const haystack = JSON.stringify(message);
        if (!normalize(haystack).includes(normalizedQuery)) continue;
        matches.push({
          kind: "message",
          id: item.id || "",
          provider: item.provider || "",
          title: item.title || item.id || "History",
          snippet: snippet(message.text, normalizedQuery),
          turnId: message.turnId || "",
          updatedAt: item.updatedAt || "",
          relevance: textRelevance(item.title, haystack, normalizedQuery)
        });
      }
    }
  }
  if (allow("files")) matches.push(...fileResults);

  const requestedTag = normalize(tag);
  const filteredMatches = matches.filter((item) => {
    if (!requestedTag && !favorite) return true;
    const key = item.kind === "history" || item.kind === "message"
      ? `history:${item.provider}:${item.id}`
      : item.kind === "task" ? `task:${item.id}` : "";
    const meta = threadState.items?.[key] || {};
    return (!favorite || meta.favorite === true) && (!requestedTag || (meta.tags || []).some((value) => normalize(value) === requestedTag));
  });
  filteredMatches.sort(resultComparator(normalizedSort, normalizedOrder));
  const items = filteredMatches.slice(offset, offset + pageSize).map(({ relevance: _relevance, ...item }) => item);
  const nextOffset = offset + items.length;
  return {
    items,
    query: normalizedQuery,
    scope: normalizedScope,
    sort: normalizedSort,
    order: normalizedOrder,
    total: filteredMatches.length,
    limit: pageSize,
    cursor: String(offset),
    nextCursor: nextOffset < filteredMatches.length ? String(nextOffset) : ""
  };
}

export async function searchAll({ query, scope, limit, cursor, tag, favorite, sort, order, histories, tasks, workspaces, threadState }) {
  const normalizedScope = searchValues.normalizeScope(scope);
  const historyDetails = new Map();
  if (normalizedScope === "messages" || normalizedScope === "all") {
    const { getHistory } = await import("./history.js");
    for (const item of histories) {
      const detail = getHistory(item.provider, item.id, { fresh: false });
      if (detail) historyDetails.set(`${item.provider}:${item.id}`, detail);
    }
  }
  const fileResults = (normalizedScope === "files" || normalizedScope === "all") && workspaces.length
    ? store.queryWorkspaceFiles(query, { workspaceIds: workspaces.map((workspace) => workspace.id) })
    : [];
  return searchContent({ query, scope: normalizedScope, limit, cursor, tag, favorite, sort, order, histories, tasks, fileResults, historyDetails, threadState });
}

export async function startSearchIndex({ getWorkspaces, refreshIntervalMs } = {}) {
  if (!indexer) indexer = createWorkspaceSearchIndexer({ store, getWorkspaces, refreshIntervalMs });
  return indexer.start();
}

export async function stopSearchIndex() {
  if (!indexer) return;
  await indexer.stop();
  indexer = null;
}

export function getSearchIndexStatus() {
  return indexer?.status() || { ...store.stats(), ready: false, running: false, started: false, watchers: 0, pendingWorkspaces: 0 };
}

export function refreshSearchIndex() {
  if (!indexer) throw new Error("Search index is not running.");
  return indexer.refreshAll();
}

export function refreshWorkspaceSearchPaths(workspace, paths) {
  if (!indexer) return Promise.resolve(null);
  return indexer.refreshPaths(workspace, paths);
}

export const listSavedSearches = () => store.listSavedSearches();
export const getSavedSearch = (id) => store.getSavedSearch(id);
export const saveSearch = (input) => store.saveSearch(input);
export const updateSavedSearch = (id, patch) => store.updateSavedSearch(id, patch);
export const deleteSavedSearch = (id) => store.deleteSavedSearch(id);
export const markSavedSearchUsed = (id) => store.markSavedSearchUsed(id);
export const recordSearchHistory = (input) => store.recordSearch(input);
export const listSearchHistory = (options) => store.listSearchHistory(options);
export const deleteSearchHistory = (id) => store.deleteSearchHistory(id);
export const clearSearchHistory = () => store.clearSearchHistory();
