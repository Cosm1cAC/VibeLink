import fs from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_PER_WORKSPACE = 1200;
const SKIP_DIRS = new Set([".git", "node_modules", "build", "dist", ".gradle", "target"]);

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

function walkTextFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < MAX_FILES_PER_WORKSPACE) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(fullPath);
        continue;
      }
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size <= MAX_FILE_BYTES) files.push({ fullPath, stat });
      } catch { /* file may disappear during a search */ }
      if (files.length >= MAX_FILES_PER_WORKSPACE) break;
    }
  }
  return files;
}

function fileMatch(file, workspace, query) {
  const relativePath = path.relative(workspace.path, file.fullPath).replaceAll("\\", "/");
  let text = "";
  try {
    text = fs.readFileSync(file.fullPath, "utf8");
  } catch {
    return null;
  }
  if (text.includes("\u0000")) return null;
  const haystack = `${relativePath}\n${text}`.toLowerCase();
  if (!haystack.includes(query)) return null;
  return {
    kind: "file",
    id: `${workspace.id}:${relativePath}`,
    workspaceId: workspace.id || "",
    title: relativePath,
    path: relativePath,
    provider: "workspace",
    snippet: snippet(text, query),
    updatedAt: file.stat.mtime.toISOString()
  };
}

export function searchContent({ query, scope = "all", limit = 50, cursor = "0", histories = [], tasks = [], workspaces = [], historyDetails = new Map() }) {
  const normalizedQuery = normalize(query);
  const scopeAliases = { session: "sessions", history: "sessions", message: "messages", workspace: "files", file: "files", task: "tasks" };
  const normalizedScope = scopeAliases[normalize(scope)] || normalize(scope) || "all";
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(cursor, 10) || 0, 0);
  if (!normalizedQuery) return { items: [], query: "", scope: normalizedScope, limit: pageSize, cursor: String(offset), nextCursor: "" };

  const matches = [];
  const allow = (name) => normalizedScope === "all" || normalizedScope === name;
  if (allow("sessions")) {
    for (const item of histories) {
      const haystack = JSON.stringify(item).toLowerCase();
      if (haystack.includes(normalizedQuery)) matches.push({ kind: "history", id: item.id || "", provider: item.provider || "", title: item.title || item.id || "History", snippet: snippet(item.preview || item.lastMessage, normalizedQuery), updatedAt: item.updatedAt || "" });
    }
  }
  if (allow("tasks")) {
    for (const item of tasks) {
      const haystack = JSON.stringify(item).toLowerCase();
      if (haystack.includes(normalizedQuery)) matches.push({ kind: "task", id: item.id || "", provider: item.agent || "", title: item.title || item.id || "Task", snippet: snippet(item.preview || item.status, normalizedQuery), updatedAt: item.updatedAt || "" });
    }
  }
  if (allow("messages")) {
    for (const item of histories) {
      const detail = historyDetails.get(`${item.provider}:${item.id}`);
      for (const message of detail?.transcript || []) {
        if (!JSON.stringify(message).toLowerCase().includes(normalizedQuery)) continue;
        matches.push({ kind: "message", id: item.id || "", provider: item.provider || "", title: item.title || item.id || "History", snippet: snippet(message.text, normalizedQuery), turnId: message.turnId || "", updatedAt: item.updatedAt || "" });
      }
    }
  }
  if (allow("files") || normalizedScope === "workspace") {
    for (const workspace of workspaces) {
      for (const file of walkTextFiles(workspace.path || "")) {
        const result = fileMatch(file, workspace, normalizedQuery);
        if (result) matches.push(result);
      }
    }
  }

  const items = matches.slice(offset, offset + pageSize);
  const nextOffset = offset + items.length;
  return {
    items,
    query: normalizedQuery,
    scope: normalizedScope,
    limit: pageSize,
    cursor: String(offset),
    nextCursor: nextOffset < matches.length ? String(nextOffset) : ""
  };
}

export async function searchAll({ query, scope, limit, cursor, histories, tasks, workspaces }) {
  const historyDetails = new Map();
  if (normalize(scope) === "messages" || !scope || normalize(scope) === "all") {
    const { getHistory } = await import("./history.js");
    for (const item of histories) {
      const detail = getHistory(item.provider, item.id, { fresh: false });
      if (detail) historyDetails.set(`${item.provider}:${item.id}`, detail);
    }
  }
  return searchContent({ query, scope, limit, cursor, histories, tasks, workspaces, historyDetails });
}
