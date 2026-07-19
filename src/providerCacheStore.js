const EMPTY_ROW = {
  catalog_models_json: null,
  catalog_status: "",
  catalog_source: "",
  catalog_fetched_at: "",
  catalog_expires_at: "",
  catalog_error: "",
  health_ok: null,
  health_status: "",
  health_cache_status: "",
  health_source: "",
  health_checked_at: "",
  health_expires_at: "",
  health_latency_ms: null,
  health_version: "",
  health_error: ""
};

function parseModels(value) {
  try {
    const models = JSON.parse(value);
    return Array.isArray(models) ? models : null;
  } catch {
    return null;
  }
}

export function ensureProviderCacheSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_cache (
      provider_id TEXT PRIMARY KEY,
      catalog_models_json TEXT,
      catalog_status TEXT NOT NULL DEFAULT '',
      catalog_source TEXT NOT NULL DEFAULT '',
      catalog_fetched_at TEXT NOT NULL DEFAULT '',
      catalog_expires_at TEXT NOT NULL DEFAULT '',
      catalog_error TEXT NOT NULL DEFAULT '',
      health_ok INTEGER,
      health_status TEXT NOT NULL DEFAULT '',
      health_cache_status TEXT NOT NULL DEFAULT '',
      health_source TEXT NOT NULL DEFAULT '',
      health_checked_at TEXT NOT NULL DEFAULT '',
      health_expires_at TEXT NOT NULL DEFAULT '',
      health_latency_ms INTEGER,
      health_version TEXT NOT NULL DEFAULT '',
      health_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
}

function mapRow(row) {
  if (!row) return { catalog: null, health: null };
  const models = row.catalog_models_json ? parseModels(row.catalog_models_json) : null;
  return {
    catalog: models
      ? {
          models,
          catalog: {
            status: row.catalog_status,
            source: row.catalog_source,
            fetchedAt: row.catalog_fetched_at,
            expiresAt: row.catalog_expires_at,
            error: row.catalog_error
          }
        }
      : null,
    health: row.health_ok === null
      ? null
      : {
          ok: Boolean(row.health_ok),
          status: row.health_status,
          cacheStatus: row.health_cache_status,
          source: row.health_source,
          checkedAt: row.health_checked_at,
          expiresAt: row.health_expires_at,
          latencyMs: row.health_latency_ms,
          version: row.health_version,
          error: row.health_error
        }
  };
}

export function createProviderCacheStore({ database, now = () => new Date().toISOString() } = {}) {
  if (typeof database !== "function") throw new TypeError("Provider cache store requires a database function.");
  let initialized = false;

  function db() {
    const value = database();
    if (!initialized) {
      ensureProviderCacheSchema(value);
      initialized = true;
    }
    return value;
  }

  function ensureRow(providerId) {
    db().prepare(`
      INSERT INTO provider_cache (
        provider_id, catalog_models_json, catalog_status, catalog_source, catalog_fetched_at,
        catalog_expires_at, catalog_error, health_ok, health_status, health_cache_status,
        health_source, health_checked_at, health_expires_at, health_latency_ms, health_version,
        health_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO NOTHING
    `).run(providerId, ...Object.values(EMPTY_ROW), now());
  }

  return {
    get(providerId) {
      const row = db().prepare("SELECT * FROM provider_cache WHERE provider_id = ?").get(String(providerId));
      return mapRow(row);
    },

    putCatalog(providerId, value) {
      ensureRow(String(providerId));
      db().prepare(`
        UPDATE provider_cache SET
          catalog_models_json = ?, catalog_status = ?, catalog_source = ?, catalog_fetched_at = ?,
          catalog_expires_at = ?, catalog_error = ?, updated_at = ?
        WHERE provider_id = ?
      `).run(
        JSON.stringify(value.models),
        String(value.catalog?.status || ""),
        String(value.catalog?.source || ""),
        String(value.catalog?.fetchedAt || ""),
        String(value.catalog?.expiresAt || ""),
        String(value.catalog?.error || ""),
        now(),
        String(providerId)
      );
    },

    putHealth(providerId, value) {
      ensureRow(String(providerId));
      db().prepare(`
        UPDATE provider_cache SET
          health_ok = ?, health_status = ?, health_cache_status = ?, health_source = ?,
          health_checked_at = ?, health_expires_at = ?, health_latency_ms = ?, health_version = ?,
          health_error = ?, updated_at = ?
        WHERE provider_id = ?
      `).run(
        value.ok ? 1 : 0,
        String(value.status || ""),
        String(value.cacheStatus || ""),
        String(value.source || ""),
        String(value.checkedAt || ""),
        String(value.expiresAt || ""),
        Number.isFinite(value.latencyMs) ? value.latencyMs : null,
        String(value.version || ""),
        String(value.error || ""),
        now(),
        String(providerId)
      );
    }
  };
}
