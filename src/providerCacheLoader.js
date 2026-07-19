function isUnexpired(value, now) {
  const expiresAt = Date.parse(value || "");
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function cachedCatalog(value, now) {
  return {
    models: value.models.map((model) => ({ ...model })),
    catalog: {
      ...value.catalog,
      status: isUnexpired(value.catalog.expiresAt, now) && !value.catalog.error ? "cached" : "stale"
    }
  };
}

function cachedHealth(value, now) {
  return {
    ...value,
    cacheStatus: isUnexpired(value.expiresAt, now) ? "cached" : "stale"
  };
}

export function createPersistentProviderCacheLoader({
  store,
  catalogResolver,
  healthResolver,
  now = Date.now
} = {}) {
  if (!store || typeof store.get !== "function") throw new TypeError("Persistent provider cache loader requires a store.");
  const catalogPending = new Map();
  const healthPending = new Map();
  const catalogHydrated = new Set();
  const healthHydrated = new Set();

  function refreshCatalog(provider) {
    if (catalogPending.has(provider.id)) return catalogPending.get(provider.id);
    const refresh = Promise.resolve()
      .then(() => catalogResolver.resolve(provider, { fresh: true, background: false }))
      .then((result) => {
        const previous = store.get(provider.id).catalog;
        const persisted = result.catalog?.status === "fallback" && previous
          ? {
              models: previous.models,
              catalog: { ...previous.catalog, status: "stale", error: result.catalog.error || previous.catalog.error }
            }
          : result;
        store.putCatalog(provider.id, persisted);
        return persisted;
      })
      .finally(() => catalogPending.delete(provider.id));
    catalogPending.set(provider.id, refresh);
    return refresh;
  }

  function refreshHealth(provider) {
    if (healthPending.has(provider.id)) return healthPending.get(provider.id);
    const refresh = Promise.resolve()
      .then(() => healthResolver.resolve(provider, { fresh: true, background: false }))
      .then((result) => {
        store.putHealth(provider.id, result);
        return result;
      })
      .finally(() => healthPending.delete(provider.id));
    healthPending.set(provider.id, refresh);
    return refresh;
  }

  function startBackground(refresh) {
    refresh.catch((error) => console.error(`[provider-cache] background refresh failed: ${error.message}`));
  }

  return {
    catalogResolver: {
      async resolve(provider, options = {}) {
        const stored = store.get(provider.id).catalog;
        if (!catalogHydrated.has(provider.id) && stored && !options.fresh) {
          catalogHydrated.add(provider.id);
          startBackground(refreshCatalog(provider));
          return cachedCatalog(stored, Number(now()));
        }
        catalogHydrated.add(provider.id);
        if (options.fresh) return refreshCatalog(provider);
        if (catalogPending.has(provider.id) && options.background && stored) {
          return cachedCatalog(stored, Number(now()));
        }
        if (catalogPending.has(provider.id)) return catalogPending.get(provider.id);
        if (options.background) {
          const immediate = await catalogResolver.resolve(provider, { background: true });
          startBackground(refreshCatalog(provider));
          return immediate;
        }
        return refreshCatalog(provider);
      }
    },
    healthResolver: {
      async resolve(provider, options = {}) {
        const stored = store.get(provider.id).health;
        if (!healthHydrated.has(provider.id) && stored && !options.fresh) {
          healthHydrated.add(provider.id);
          startBackground(refreshHealth(provider));
          return cachedHealth(stored, Number(now()));
        }
        healthHydrated.add(provider.id);
        if (options.fresh) return refreshHealth(provider);
        if (healthPending.has(provider.id) && options.background && stored) {
          return cachedHealth(stored, Number(now()));
        }
        if (healthPending.has(provider.id)) return healthPending.get(provider.id);
        if (options.background) {
          const immediate = await healthResolver.resolve(provider, { background: true });
          startBackground(refreshHealth(provider));
          return immediate;
        }
        return refreshHealth(provider);
      }
    },
    async drain() {
      await Promise.all([...catalogPending.values(), ...healthPending.values()]);
    }
  };
}
