import crypto from "node:crypto";
import { resolveSessionOriginFilter } from "./sessionOrigins.js";

const SEARCH_SCOPES = new Set(["all", "sessions", "tasks", "messages", "files"]);
const SEARCH_SORTS = new Set(["relevance", "updatedAt", "title", "kind"]);
const SEARCH_ORDERS = new Set(["asc", "desc"]);

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeScope(value) {
  const aliases = { session: "sessions", history: "sessions", task: "tasks", message: "messages", workspace: "files", file: "files" };
  const normalized = cleanString(value, 40).toLowerCase();
  const resolved = aliases[normalized] || normalized || "all";
  return SEARCH_SCOPES.has(resolved) ? resolved : "all";
}

function normalizeSort(value) {
  const normalized = cleanString(value, 40);
  return SEARCH_SORTS.has(normalized) ? normalized : "relevance";
}

function normalizeOrder(value, sort = "relevance") {
  const normalized = cleanString(value, 10).toLowerCase();
  if (SEARCH_ORDERS.has(normalized)) return normalized;
  return sort === "relevance" || sort === "updatedAt" ? "desc" : "asc";
}

function escapeLike(value) {
  return String(value || "").replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function ftsExpression(query) {
  const tokens = String(query || "")
    .normalize("NFKC")
    .split(/\s+/u)
    .map((token) => token.replaceAll('"', "").trim())
    .filter((token) => [...token].length >= 3);
  if (!tokens.length) return "";
  return tokens.map((token) => `"${token}"`).join(" AND ");
}

function historySignature(input) {
  return crypto.createHash("sha256").update(JSON.stringify([
    input.query,
    input.scope,
    input.sessionOrigin,
    input.tag,
    input.favorite,
    input.sort,
    input.order
  ])).digest("hex");
}

function publicSavedSearch(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    scope: row.scope,
    sessionOrigin: row.session_origin || "all",
    tag: row.tag || "",
    favorite: Boolean(row.favorite),
    sort: row.sort,
    order: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at || ""
  };
}

function publicSearchHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    query: row.query,
    scope: row.scope,
    sessionOrigin: row.session_origin || "all",
    tag: row.tag || "",
    favorite: Boolean(row.favorite),
    sort: row.sort,
    order: row.sort_order,
    resultCount: Number(row.result_count || 0),
    useCount: Number(row.use_count || 0),
    searchedAt: row.searched_at,
    deviceId: row.device_id || ""
  };
}

export function ensureSearchSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_search_files (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      indexable INTEGER NOT NULL DEFAULT 1,
      indexed_at TEXT NOT NULL,
      UNIQUE(workspace_id, path)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_search_files_workspace
      ON workspace_search_files(workspace_id, path);

    CREATE VIRTUAL TABLE IF NOT EXISTS workspace_search_fts USING fts5(
      path,
      content,
      workspace_id UNINDEXED,
      tokenize = 'trigram'
    );

    CREATE TABLE IF NOT EXISTS content_search_documents (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL,
      event_cursor INTEGER NOT NULL,
      kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      provider TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      turn_id TEXT,
      updated_at TEXT,
      UNIQUE(source_key, event_cursor)
    );

    CREATE INDEX IF NOT EXISTS idx_content_search_documents_source
      ON content_search_documents(source_key, event_cursor);

    CREATE VIRTUAL TABLE IF NOT EXISTS content_search_fts USING fts5(
      title,
      content,
      tokenize = 'trigram'
    );

    CREATE TABLE IF NOT EXISTS content_search_sources (
      source_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_origin TEXT NOT NULL DEFAULT 'unknown',
      source_kind TEXT NOT NULL,
      file_path TEXT,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      event_cursor INTEGER NOT NULL DEFAULT 0,
      source_size INTEGER NOT NULL DEFAULT 0,
      source_mtime_ms INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_searches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      scope TEXT NOT NULL,
      session_origin TEXT NOT NULL DEFAULT 'all',
      tag TEXT,
      favorite INTEGER NOT NULL DEFAULT 0,
      sort TEXT NOT NULL DEFAULT 'relevance',
      sort_order TEXT NOT NULL DEFAULT 'desc',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_saved_searches_updated ON saved_searches(updated_at DESC);

    CREATE TABLE IF NOT EXISTS search_history (
      id TEXT PRIMARY KEY,
      signature TEXT NOT NULL UNIQUE,
      query TEXT NOT NULL,
      scope TEXT NOT NULL,
      session_origin TEXT NOT NULL DEFAULT 'all',
      tag TEXT,
      favorite INTEGER NOT NULL DEFAULT 0,
      sort TEXT NOT NULL DEFAULT 'relevance',
      sort_order TEXT NOT NULL DEFAULT 'desc',
      result_count INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 1,
      searched_at TEXT NOT NULL,
      device_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_search_history_searched ON search_history(searched_at DESC);
  `);

  for (const [table, fallback] of [
    ["content_search_sources", "unknown"],
    ["saved_searches", "all"],
    ["search_history", "all"]
  ]) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    if (!columns.has("session_origin")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN session_origin TEXT NOT NULL DEFAULT '${fallback}'`);
    }
  }
}

export function createSearchStore({ database, now = nowIso, uuid = crypto.randomUUID } = {}) {
  if (typeof database !== "function") throw new Error("Search store requires a database function.");
  let initialized = false;

  function db() {
    const connection = database();
    if (!initialized) {
      ensureSearchSchema(connection);
      initialized = true;
    }
    return connection;
  }

  function listWorkspaceMetadata(workspaceId) {
    return db()
      .prepare(`
        SELECT path, size_bytes, mtime_ms, indexable, indexed_at
        FROM workspace_search_files
        WHERE workspace_id = ?
      `)
      .all(cleanString(workspaceId, 320))
      .map((row) => ({
        path: row.path,
        size: Number(row.size_bytes),
        mtimeMs: Number(row.mtime_ms),
        indexable: Boolean(row.indexable),
        indexedAt: row.indexed_at
      }));
  }

  function applyWorkspaceChanges(workspaceId, { upserts = [], deletedPaths = [] } = {}) {
    const cleanWorkspaceId = cleanString(workspaceId, 320);
    if (!cleanWorkspaceId) throw new Error("Workspace id is required for indexing.");
    const connection = db();
    const selectRow = connection.prepare("SELECT rowid FROM workspace_search_files WHERE workspace_id = ? AND path = ?");
    const insertMeta = connection.prepare(`
      INSERT INTO workspace_search_files (workspace_id, path, size_bytes, mtime_ms, indexable, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateMeta = connection.prepare(`
      UPDATE workspace_search_files
      SET size_bytes = ?, mtime_ms = ?, indexable = ?, indexed_at = ?
      WHERE rowid = ?
    `);
    const deleteMeta = connection.prepare("DELETE FROM workspace_search_files WHERE rowid = ?");
    const deleteFts = connection.prepare("DELETE FROM workspace_search_fts WHERE rowid = ?");
    const insertFts = connection.prepare("INSERT INTO workspace_search_fts(rowid, path, content, workspace_id) VALUES (?, ?, ?, ?)");

    connection.exec("BEGIN");
    try {
      for (const relativePath of deletedPaths) {
        const row = selectRow.get(cleanWorkspaceId, cleanString(relativePath, 2000));
        if (!row) continue;
        deleteFts.run(row.rowid);
        deleteMeta.run(row.rowid);
      }

      for (const item of upserts) {
        const relativePath = cleanString(item.path, 2000);
        if (!relativePath) continue;
        const existing = selectRow.get(cleanWorkspaceId, relativePath);
        const indexedAt = item.indexedAt || now();
        let rowid = existing?.rowid;
        if (rowid) {
          deleteFts.run(rowid);
          updateMeta.run(Number(item.size || 0), Number(item.mtimeMs || 0), item.indexable === false ? 0 : 1, indexedAt, rowid);
        } else {
          const inserted = insertMeta.run(cleanWorkspaceId, relativePath, Number(item.size || 0), Number(item.mtimeMs || 0), item.indexable === false ? 0 : 1, indexedAt);
          rowid = Number(inserted.lastInsertRowid);
        }
        if (item.indexable !== false) insertFts.run(rowid, relativePath, String(item.content || ""), cleanWorkspaceId);
      }
      connection.exec("COMMIT");
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return { upserted: upserts.length, deleted: deletedPaths.length };
  }

  function removeWorkspace(workspaceId) {
    const cleanWorkspaceId = cleanString(workspaceId, 320);
    const connection = db();
    const rows = connection.prepare("SELECT rowid FROM workspace_search_files WHERE workspace_id = ?").all(cleanWorkspaceId);
    connection.exec("BEGIN");
    try {
      const deleteFts = connection.prepare("DELETE FROM workspace_search_fts WHERE rowid = ?");
      for (const row of rows) deleteFts.run(row.rowid);
      connection.prepare("DELETE FROM workspace_search_files WHERE workspace_id = ?").run(cleanWorkspaceId);
      connection.exec("COMMIT");
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return rows.length;
  }

  function removeMissingWorkspaces(workspaceIds = []) {
    const keep = new Set(workspaceIds.map((value) => cleanString(value, 320)).filter(Boolean));
    const indexedIds = db().prepare("SELECT DISTINCT workspace_id FROM workspace_search_files").all().map((row) => row.workspace_id);
    let removed = 0;
    for (const workspaceId of indexedIds) {
      if (!keep.has(workspaceId)) removed += removeWorkspace(workspaceId);
    }
    return removed;
  }

  function queryWorkspaceFiles(query, { workspaceIds = [], limit = 5000 } = {}) {
    const normalizedQuery = cleanString(query, 500).normalize("NFKC");
    if (!normalizedQuery) return [];
    const boundedLimit = Math.min(Math.max(Number(limit) || 5000, 1), 10000);
    const ids = workspaceIds.map((value) => cleanString(value, 320)).filter(Boolean);
    const workspaceClause = ids.length ? ` AND f.workspace_id IN (${ids.map(() => "?").join(",")})` : "";
    const expression = ftsExpression(normalizedQuery);
    let rows;
    if (expression) {
      rows = db().prepare(`
        SELECT f.rowid, f.path, f.workspace_id, m.mtime_ms,
               snippet(workspace_search_fts, 1, '', '', ' ... ', 32) AS snippet,
               bm25(workspace_search_fts, 4.0, 1.0, 0.0) AS rank
        FROM workspace_search_fts AS f
        JOIN workspace_search_files AS m ON m.rowid = f.rowid
        WHERE workspace_search_fts MATCH ?${workspaceClause}
        ORDER BY rank ASC, m.mtime_ms DESC, f.path ASC
        LIMIT ?
      `).all(expression, ...ids, boundedLimit);
    } else {
      const like = `%${escapeLike(normalizedQuery)}%`;
      rows = db().prepare(`
        SELECT f.rowid, f.path, f.workspace_id, m.mtime_ms,
               CASE
                 WHEN instr(lower(f.content), lower(?)) > 0
                 THEN substr(f.content, max(1, instr(lower(f.content), lower(?)) - 80), 240)
                 ELSE substr(f.content, 1, 240)
               END AS snippet,
               0.0 AS rank
        FROM workspace_search_fts AS f
        JOIN workspace_search_files AS m ON m.rowid = f.rowid
        WHERE (f.path LIKE ? ESCAPE '\\' OR f.content LIKE ? ESCAPE '\\')${workspaceClause}
        ORDER BY m.mtime_ms DESC, f.path ASC
        LIMIT ?
      `).all(normalizedQuery, normalizedQuery, like, like, ...ids, boundedLimit);
    }
    const lowerQuery = normalizedQuery.toLowerCase();
    return rows.map((row) => ({
      kind: "file",
      id: `${row.workspace_id}:${row.path}`,
      workspaceId: row.workspace_id,
      title: row.path,
      path: row.path,
      provider: "workspace",
      snippet: cleanString(row.snippet, 400).replace(/\s+/g, " "),
      updatedAt: new Date(Number(row.mtime_ms || 0)).toISOString(),
      relevance: -Number(row.rank || 0) + (String(row.path).toLowerCase().includes(lowerQuery) ? 10 : 0)
    }));
  }

  function rebuildContentFts() {
    const connection = db();
    connection.exec("BEGIN");
    try {
      connection.exec("DROP TABLE IF EXISTS content_search_fts");
      connection.exec("CREATE VIRTUAL TABLE content_search_fts USING fts5(title, content, tokenize = 'trigram')");
      connection.exec(`
        INSERT INTO content_search_fts(rowid, title, content)
        SELECT rowid, title, content FROM content_search_documents
      `);
      connection.exec("COMMIT");
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function checkContentIndex() {
    try {
      db().prepare("INSERT INTO content_search_fts(content_search_fts) VALUES ('integrity-check')").run();
      return true;
    } catch {
      rebuildContentFts();
      return false;
    }
  }

  function getContentSource(sourceKey) {
    const row = db().prepare("SELECT * FROM content_search_sources WHERE source_key = ?").get(cleanString(sourceKey, 700));
    if (!row) return null;
    return {
      sourceKey: row.source_key,
      provider: row.provider,
      sessionId: row.session_id,
      sessionOrigin: row.session_origin || "unknown",
      sourceKind: row.source_kind,
      filePath: row.file_path || "",
      byteOffset: Number(row.byte_offset || 0),
      eventCursor: Number(row.event_cursor || 0),
      sourceSize: Number(row.source_size || 0),
      sourceMtimeMs: Number(row.source_mtime_ms || 0),
      indexedAt: row.indexed_at
    };
  }

  function getContentDocument(sourceKey, eventCursor = 0) {
    const row = db().prepare(`
      SELECT kind, item_id, provider, title, content, turn_id, updated_at
      FROM content_search_documents
      WHERE source_key = ? AND event_cursor = ?
    `).get(cleanString(sourceKey, 700), Number(eventCursor || 0));
    if (!row) return null;
    return {
      kind: row.kind,
      id: row.item_id,
      provider: row.provider || "",
      title: row.title,
      content: row.content,
      turnId: row.turn_id || "",
      updatedAt: row.updated_at || ""
    };
  }

  function applyContentChanges(source, { upserts = [], reset = false } = {}) {
    const sourceKey = cleanString(source?.sourceKey, 700);
    if (!sourceKey) throw new Error("Content source key is required for indexing.");
    const connection = db();
    const rowsForSource = connection.prepare("SELECT rowid FROM content_search_documents WHERE source_key = ?");
    const selectDocument = connection.prepare("SELECT rowid FROM content_search_documents WHERE source_key = ? AND event_cursor = ?");
    const deleteDocument = connection.prepare("DELETE FROM content_search_documents WHERE rowid = ?");
    const deleteFts = connection.prepare("DELETE FROM content_search_fts WHERE rowid = ?");
    const insertDocument = connection.prepare(`
      INSERT INTO content_search_documents
        (source_key, event_cursor, kind, item_id, provider, title, content, turn_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = connection.prepare("INSERT INTO content_search_fts(rowid, title, content) VALUES (?, ?, ?)");
    connection.exec("BEGIN");
    try {
      if (reset) {
        for (const row of rowsForSource.all(sourceKey)) deleteFts.run(row.rowid);
        connection.prepare("DELETE FROM content_search_documents WHERE source_key = ?").run(sourceKey);
      }
      for (const item of upserts) {
        const cursor = Number(item.eventCursor || 0);
        const existing = selectDocument.get(sourceKey, cursor);
        if (existing) {
          deleteFts.run(existing.rowid);
          deleteDocument.run(existing.rowid);
        }
        const title = cleanString(item.title, 1000);
        const content = String(item.content || "").slice(0, 1024 * 1024);
        const inserted = insertDocument.run(
          sourceKey, cursor, cleanString(item.kind, 40), cleanString(item.id, 500),
          cleanString(item.provider, 80), title, content, cleanString(item.turnId, 500),
          cleanString(item.updatedAt, 80)
        );
        insertFts.run(Number(inserted.lastInsertRowid), title, content);
      }
      connection.prepare(`
        INSERT INTO content_search_sources
          (source_key, provider, session_id, session_origin, source_kind, file_path, byte_offset, event_cursor, source_size, source_mtime_ms, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          provider = excluded.provider, session_id = excluded.session_id, session_origin = excluded.session_origin,
          source_kind = excluded.source_kind,
          file_path = excluded.file_path, byte_offset = excluded.byte_offset, event_cursor = excluded.event_cursor,
          source_size = excluded.source_size, source_mtime_ms = excluded.source_mtime_ms, indexed_at = excluded.indexed_at
      `).run(
        sourceKey, cleanString(source.provider, 80), cleanString(source.sessionId, 500),
        cleanString(source.sessionOrigin, 40) || "unknown", cleanString(source.sourceKind, 40),
        cleanString(source.filePath, 2000),
        Number(source.byteOffset || 0), Number(source.eventCursor || 0), Number(source.sourceSize || 0),
        Number(source.sourceMtimeMs || 0), source.indexedAt || now()
      );
      connection.exec("COMMIT");
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return { upserted: upserts.length, reset };
  }

  function removeMissingContentSources(sourceKeys = []) {
    const keep = new Set(sourceKeys.map((value) => cleanString(value, 700)).filter(Boolean));
    const connection = db();
    const indexed = connection.prepare("SELECT source_key FROM content_search_sources").all();
    let removed = 0;
    for (const { source_key: sourceKey } of indexed) {
      if (keep.has(sourceKey)) continue;
      const rows = connection.prepare("SELECT rowid FROM content_search_documents WHERE source_key = ?").all(sourceKey);
      connection.exec("BEGIN");
      try {
        const deleteFts = connection.prepare("DELETE FROM content_search_fts WHERE rowid = ?");
        for (const row of rows) deleteFts.run(row.rowid);
        connection.prepare("DELETE FROM content_search_documents WHERE source_key = ?").run(sourceKey);
        connection.prepare("DELETE FROM content_search_sources WHERE source_key = ?").run(sourceKey);
        connection.exec("COMMIT");
        removed += rows.length;
      } catch (error) {
        try { connection.exec("ROLLBACK"); } catch {}
        throw error;
      }
    }
    return removed;
  }

  function queryContent(query, { kinds = [], sessionOrigin = "all", limit = 10000 } = {}) {
    const normalizedQuery = cleanString(query, 500).normalize("NFKC");
    if (!normalizedQuery) return [];
    const boundedLimit = Math.min(Math.max(Number(limit) || 5000, 1), 10000);
    const cleanKinds = kinds.map((value) => cleanString(value, 40)).filter(Boolean);
    const cleanSessionOrigin = cleanString(sessionOrigin, 40);
    const filters = [];
    const filterParams = [];
    if (cleanKinds.length) {
      filters.push(`d.kind IN (${cleanKinds.map(() => "?").join(",")})`);
      filterParams.push(...cleanKinds);
    }
    if (cleanSessionOrigin && cleanSessionOrigin !== "all") {
      filters.push("s.session_origin = ?");
      filterParams.push(cleanSessionOrigin);
    }
    const filterClause = filters.length ? ` AND ${filters.join(" AND ")}` : "";
    const expression = ftsExpression(normalizedQuery);
    let rows;
    const run = () => {
      if (expression) {
        return db().prepare(`
          SELECT d.*, s.session_origin, snippet(content_search_fts, 1, '', '', ' ... ', 32) AS match_snippet,
                 bm25(content_search_fts, 4.0, 1.0) AS rank
          FROM content_search_fts AS f
          JOIN content_search_documents AS d ON d.rowid = f.rowid
          JOIN content_search_sources AS s ON s.source_key = d.source_key
          WHERE content_search_fts MATCH ?${filterClause}
          ORDER BY rank ASC, d.updated_at DESC
          LIMIT ?
        `).all(expression, ...filterParams, boundedLimit);
      }
      const like = `%${escapeLike(normalizedQuery)}%`;
      return db().prepare(`
        SELECT d.*, s.session_origin, substr(d.content, max(1, instr(lower(d.content), lower(?)) - 80), 240) AS match_snippet,
               0.0 AS rank
        FROM content_search_documents AS d
        JOIN content_search_sources AS s ON s.source_key = d.source_key
        WHERE (d.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')${filterClause}
        ORDER BY d.updated_at DESC
        LIMIT ?
      `).all(normalizedQuery, like, like, ...filterParams, boundedLimit);
    };
    try { rows = run(); } catch { rebuildContentFts(); rows = run(); }
    const lowerQuery = normalizedQuery.toLowerCase();
    return rows.map((row) => ({
      kind: row.kind,
      id: row.item_id,
      provider: row.provider || "",
      sessionOrigin: row.session_origin || "unknown",
      title: row.title,
      snippet: cleanString(row.match_snippet || row.content, 400).replace(/\s+/g, " "),
      turnId: row.turn_id || "",
      updatedAt: row.updated_at || "",
      relevance: -Number(row.rank || 0) + (String(row.title).toLowerCase().includes(lowerQuery) ? 10 : 0)
    }));
  }

  function listSavedSearches() {
    return db().prepare("SELECT * FROM saved_searches ORDER BY updated_at DESC, name COLLATE NOCASE ASC").all().map(publicSavedSearch);
  }

  function getSavedSearch(id) {
    return publicSavedSearch(db().prepare("SELECT * FROM saved_searches WHERE id = ?").get(cleanString(id, 160)));
  }

  function saveSearch(input = {}) {
    const query = cleanString(input.query, 500);
    if (!query) throw new Error("Saved search query is required.");
    const name = cleanString(input.name, 160) || query;
    const scope = normalizeScope(input.scope);
    const sessionOrigin = resolveSessionOriginFilter(input.sessionOrigin);
    const sort = normalizeSort(input.sort);
    const order = normalizeOrder(input.order, sort);
    const current = now();
    const id = cleanString(input.id, 160) || uuid();
    db().prepare(`
      INSERT INTO saved_searches (id, name, query, scope, session_origin, tag, favorite, sort, sort_order, created_at, updated_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(id, name, query, scope, sessionOrigin, cleanString(input.tag, 160), input.favorite ? 1 : 0, sort, order, current, current);
    return getSavedSearch(id);
  }

  function updateSavedSearch(id, patch = {}) {
    const existing = getSavedSearch(id);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    const query = cleanString(next.query, 500);
    if (!query) throw new Error("Saved search query is required.");
    const sort = normalizeSort(next.sort);
    db().prepare(`
      UPDATE saved_searches
      SET name = ?, query = ?, scope = ?, session_origin = ?, tag = ?, favorite = ?, sort = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `).run(
      cleanString(next.name, 160) || query,
      query,
      normalizeScope(next.scope),
      resolveSessionOriginFilter(next.sessionOrigin),
      cleanString(next.tag, 160),
      next.favorite ? 1 : 0,
      sort,
      normalizeOrder(next.order, sort),
      now(),
      existing.id
    );
    return getSavedSearch(existing.id);
  }

  function deleteSavedSearch(id) {
    return db().prepare("DELETE FROM saved_searches WHERE id = ?").run(cleanString(id, 160)).changes > 0;
  }

  function markSavedSearchUsed(id) {
    db().prepare("UPDATE saved_searches SET last_used_at = ? WHERE id = ?").run(now(), cleanString(id, 160));
    return getSavedSearch(id);
  }

  function recordSearch(input = {}) {
    const query = cleanString(input.query, 500);
    if (!query) return null;
    const scope = normalizeScope(input.scope);
    const sort = normalizeSort(input.sort);
    const order = normalizeOrder(input.order, sort);
    const normalized = {
      query,
      scope,
      sessionOrigin: resolveSessionOriginFilter(input.sessionOrigin),
      tag: cleanString(input.tag, 160),
      favorite: Boolean(input.favorite),
      sort,
      order
    };
    const signature = historySignature(normalized);
    const id = signature.slice(0, 32);
    db().prepare(`
      INSERT INTO search_history (
        id, signature, query, scope, session_origin, tag, favorite, sort, sort_order,
        result_count, use_count, searched_at, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(signature) DO UPDATE SET
        result_count = excluded.result_count,
        use_count = search_history.use_count + 1,
        searched_at = excluded.searched_at,
        device_id = excluded.device_id
    `).run(
      id,
      signature,
      normalized.query,
      normalized.scope,
      normalized.sessionOrigin,
      normalized.tag,
      normalized.favorite ? 1 : 0,
      normalized.sort,
      normalized.order,
      Math.max(Number(input.resultCount) || 0, 0),
      now(),
      cleanString(input.deviceId, 160)
    );
    return publicSearchHistory(db().prepare("SELECT * FROM search_history WHERE signature = ?").get(signature));
  }

  function listSearchHistory({ limit = 50 } = {}) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return db().prepare("SELECT * FROM search_history ORDER BY searched_at DESC LIMIT ?").all(boundedLimit).map(publicSearchHistory);
  }

  function deleteSearchHistory(id) {
    return db().prepare("DELETE FROM search_history WHERE id = ?").run(cleanString(id, 160)).changes > 0;
  }

  function clearSearchHistory() {
    return db().prepare("DELETE FROM search_history").run().changes;
  }

  function stats() {
    const connection = db();
    const files = connection.prepare("SELECT COUNT(*) AS count FROM workspace_search_files WHERE indexable = 1").get().count;
    const workspaces = connection.prepare("SELECT COUNT(DISTINCT workspace_id) AS count FROM workspace_search_files").get().count;
    return { files: Number(files), workspaces: Number(workspaces) };
  }

  function contentStats() {
    const connection = db();
    const content = connection.prepare("SELECT kind, COUNT(*) AS count FROM content_search_documents GROUP BY kind").all();
    const counts = Object.fromEntries(content.map((row) => [row.kind, Number(row.count)]));
    return { sessions: counts.history || 0, tasks: counts.task || 0, messages: counts.message || 0 };
  }

  return {
    applyWorkspaceChanges,
    applyContentChanges,
    checkContentIndex,
    contentStats,
    clearSearchHistory,
    deleteSavedSearch,
    deleteSearchHistory,
    getSavedSearch,
    listSavedSearches,
    listSearchHistory,
    listWorkspaceMetadata,
    getContentSource,
    getContentDocument,
    markSavedSearchUsed,
    queryWorkspaceFiles,
    queryContent,
    recordSearch,
    removeMissingWorkspaces,
    removeWorkspace,
    removeMissingContentSources,
    rebuildContentFts,
    saveSearch,
    stats,
    updateSavedSearch
  };
}

export const searchValues = {
  normalizeOrder,
  normalizeScope,
  normalizeSort
};
