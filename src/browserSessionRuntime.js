import crypto from "node:crypto";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TRACE_EVENTS = 1_000;
const DEFAULT_TRACE_PAGE_SIZE = 100;
const MAX_TRACE_PAGE_SIZE = 1_000;
const DEFAULT_MAX_TEXT_LENGTH = 4_000;
const REDACTED = "[REDACTED]";

const DEFAULT_SENSITIVE_NAMES = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "password",
  "passwd",
  "secret",
  "client_secret"
];

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function timeoutError(operation, timeoutMs) {
  const error = new Error(`Browser runtime operation timed out: ${operation} after ${timeoutMs}ms.`);
  error.code = "ETIMEDOUT";
  error.operation = operation;
  error.timeoutMs = timeoutMs;
  return error;
}

async function withTimeout(operation, timeoutMs, action) {
  const duration = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 1, 300_000);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(operation, duration)), duration);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeNavigationUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    const error = new Error("Browser navigation URL is invalid.");
    error.code = "EINVAL";
    throw error;
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    const error = new Error("Browser navigation only supports http and https URLs.");
    error.code = "EINVAL";
    throw error;
  }
  if (url.username || url.password) {
    const error = new Error("Browser navigation URLs must not include embedded credentials.");
    error.code = "EINVAL";
    throw error;
  }
  return url.toString();
}

function createRedactor(options = {}) {
  const names = new Set([
    ...DEFAULT_SENSITIVE_NAMES,
    ...(Array.isArray(options.sensitiveNames) ? options.sensitiveNames : [])
  ].map((value) => String(value).toLowerCase()));
  const replacement = String(options.replacement || REDACTED);
  const maxTextLength = boundedInteger(options.maxTextLength, DEFAULT_MAX_TEXT_LENGTH, 64, 100_000);
  const extraPatterns = Array.isArray(options.patterns)
    ? options.patterns.filter((pattern) => pattern instanceof RegExp)
    : [];

  function sensitive(name) {
    const normalized = String(name || "").toLowerCase();
    return names.has(normalized) || /(?:token|secret|password|passwd|authorization|cookie|api[-_]?key)/i.test(normalized);
  }

  function text(value) {
    let result = String(value ?? "");
    result = result
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${replacement}`)
      .replace(
        /((?:access|refresh|id)[_-]?token|token|password|passwd|secret|client_secret|api[-_]?key)(["']?\s*[=:]\s*)(["']?)[^\s,"'&}]+\3/gi,
        (_, key, separator, quote) => `${key}${separator}${quote}${replacement}${quote}`
      );
    for (const pattern of extraPatterns) {
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      result = result.replace(new RegExp(pattern.source, flags), replacement);
    }
    return result.length > maxTextLength ? `${result.slice(0, maxTextLength)}…` : result;
  }

  function url(value) {
    try {
      const parsed = new URL(String(value || ""));
      if (parsed.username) parsed.username = replacement;
      if (parsed.password) parsed.password = replacement;
      for (const key of [...parsed.searchParams.keys()]) {
        if (sensitive(key)) parsed.searchParams.set(key, replacement);
      }
      return text(parsed.toString());
    } catch {
      return text(value);
    }
  }

  function value(input, key = "", depth = 0, seen = new WeakSet()) {
    if (sensitive(key)) return replacement;
    if (input === null || input === undefined || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "string") return key.toLowerCase().includes("url") ? url(input) : text(input);
    if (typeof input !== "object") return text(input);
    if (depth >= 8) return "[TRUNCATED]";
    if (seen.has(input)) return "[CIRCULAR]";
    seen.add(input);
    if (Array.isArray(input)) return input.slice(0, 100).map((item) => value(item, "", depth + 1, seen));
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(input).slice(0, 100)) {
      output[entryKey] = value(entryValue, entryKey, depth + 1, seen);
    }
    return output;
  }

  return { sensitive, text, url, value, replacement };
}

function responseStatus(response) {
  try { return response?.status?.() ?? null; } catch { return null; }
}

function pageUrl(page, redactor) {
  try { return redactor.url(page.url()); } catch { return ""; }
}

export function createBrowserSessionRuntime({
  playwright = null,
  loadPlaywright = () => import("playwright"),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTraceEvents = DEFAULT_MAX_TRACE_EVENTS,
  redaction = {},
  now = () => new Date().toISOString(),
  idFactory = () => crypto.randomUUID()
} = {}) {
  const sessions = new Map();
  const redactor = createRedactor(redaction);
  const defaultTimeoutMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 1, 300_000);
  const defaultMaxTraceEvents = boundedInteger(maxTraceEvents, DEFAULT_MAX_TRACE_EVENTS, 1, 100_000);
  let playwrightPromise = playwright ? Promise.resolve(playwright) : null;

  function browserLibrary() {
    if (!playwrightPromise) playwrightPromise = Promise.resolve().then(loadPlaywright);
    return playwrightPromise;
  }

  function requireSession(id) {
    const session = sessions.get(String(id || ""));
    if (!session || session.status === "closed") {
      const error = new Error("Browser session not found.");
      error.code = "ENOENT";
      throw error;
    }
    return session;
  }

  function trace(session, type, data = {}, pageId = "") {
    const event = {
      seq: session.nextTraceSeq++,
      type,
      at: now(),
      ...(pageId ? { pageId } : {}),
      data: redactor.value(data)
    };
    session.trace.push(event);
    if (session.trace.length > session.maxTraceEvents) {
      const remove = session.trace.length - session.maxTraceEvents;
      session.trace.splice(0, remove);
      session.droppedTraceEvents += remove;
    }
    session.updatedAt = event.at;
    try { session.onTrace?.(event); } catch {}
    return event;
  }

  function publicPage(record) {
    return {
      id: record.id,
      url: pageUrl(record.page, redactor),
      title: record.title,
      status: record.closed ? "closed" : "open",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  }

  function publicSession(session) {
    return {
      id: session.id,
      browserType: session.browserType,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      closedAt: session.closedAt,
      timeoutMs: session.timeoutMs,
      maxTraceEvents: session.maxTraceEvents,
      traceEvents: session.trace.length,
      droppedTraceEvents: session.droppedTraceEvents,
      pages: [...session.pages.values()].map(publicPage)
    };
  }

  async function updatePageTitle(record) {
    try {
      record.title = redactor.text(await record.page.title());
    } catch {}
    record.updatedAt = now();
  }

  async function requestHeaders(request) {
    try {
      if (typeof request.allHeaders === "function") return await request.allHeaders();
      return request.headers?.() || {};
    } catch {
      return {};
    }
  }

  async function responseHeaders(response) {
    try {
      if (typeof response.allHeaders === "function") return await response.allHeaders();
      return response.headers?.() || {};
    } catch {
      return {};
    }
  }

  function attachPage(session, page) {
    const existing = [...session.pages.values()].find((record) => record.page === page);
    if (existing) return existing;
    const createdAt = now();
    const record = { id: idFactory(), page, title: "", closed: false, createdAt, updatedAt: createdAt };
    session.pages.set(record.id, record);
    trace(session, "page.created", { url: pageUrl(page, redactor) }, record.id);

    page.on?.("console", (message) => {
      trace(session, "console", {
        level: message.type?.() || "log",
        text: message.text?.() || "",
        location: message.location?.() || null
      }, record.id);
    });
    page.on?.("request", (request) => {
      void (async () => trace(session, "network.request", {
        method: request.method?.() || "GET",
        url: request.url?.() || "",
        resourceType: request.resourceType?.() || "",
        headers: await requestHeaders(request),
        postData: request.postData?.() || ""
      }, record.id))();
    });
    page.on?.("response", (response) => {
      void (async () => trace(session, "network.response", {
        url: response.url?.() || "",
        status: response.status?.() ?? null,
        statusText: response.statusText?.() || "",
        headers: await responseHeaders(response)
      }, record.id))();
    });
    page.on?.("requestfailed", (request) => {
      trace(session, "network.failed", {
        method: request.method?.() || "GET",
        url: request.url?.() || "",
        error: request.failure?.()?.errorText || "Request failed"
      }, record.id);
    });
    page.on?.("framenavigated", (frame) => {
      if (frame === page.mainFrame?.()) {
        record.updatedAt = now();
        void updatePageTitle(record);
      }
    });
    page.on?.("close", () => {
      if (record.closed) return;
      record.closed = true;
      record.updatedAt = now();
      trace(session, "page.closed", { url: pageUrl(page, redactor) }, record.id);
    });
    return record;
  }

  function requirePage(session, pageId = "") {
    const openPages = [...session.pages.values()].filter((record) => !record.closed);
    const record = pageId ? session.pages.get(String(pageId)) : openPages[0];
    if (!record || record.closed) {
      const error = new Error("Browser page not found.");
      error.code = "ENOENT";
      throw error;
    }
    return record;
  }

  async function closeResources(session) {
    const duration = session.timeoutMs;
    try { await withTimeout("context.close", duration, () => session.context?.close()); } catch {}
    try { await withTimeout("browser.close", duration, () => session.browser?.close()); } catch {}
  }

  async function closeSession(id, reason = "closed") {
    const session = requireSession(id);
    if (session.status === "closing") return publicSession(session);
    trace(session, "session.closing", { reason });
    session.status = "closing";
    await closeResources(session);
    session.status = "closed";
    session.closedAt = now();
    session.updatedAt = session.closedAt;
    sessions.delete(session.id);
    return publicSession(session);
  }

  return {
    async createSession(input = {}) {
      const id = String(input.id || idFactory());
      if (sessions.has(id)) {
        const error = new Error("Browser session already exists.");
        error.code = "EEXIST";
        throw error;
      }
      const browserType = String(input.browserType || "chromium");
      const sessionTimeoutMs = boundedInteger(input.timeoutMs, defaultTimeoutMs, 1, 300_000);
      const createdAt = now();
      const session = {
        id,
        browserType,
        status: "starting",
        browser: null,
        context: null,
        pages: new Map(),
        trace: [],
        nextTraceSeq: 1,
        droppedTraceEvents: 0,
        maxTraceEvents: boundedInteger(input.maxTraceEvents, defaultMaxTraceEvents, 1, 100_000),
        timeoutMs: sessionTimeoutMs,
        onTrace: typeof input.onTrace === "function" ? input.onTrace : null,
        createdAt,
        updatedAt: createdAt,
        closedAt: ""
      };
      sessions.set(id, session);
      try {
        const library = await withTimeout("playwright.load", sessionTimeoutMs, browserLibrary);
        const launcher = library?.[browserType];
        if (!launcher?.launch) throw new Error(`Unsupported Playwright browser type: ${browserType}.`);
        const launchOptions = input.launchOptions || {};
        const launchTimeout = boundedInteger(launchOptions.timeout, sessionTimeoutMs, 1, sessionTimeoutMs);
        session.browser = await withTimeout("browser.launch", sessionTimeoutMs, () => launcher.launch({
          ...launchOptions,
          timeout: launchTimeout
        }));
        session.context = await withTimeout("browser.newContext", sessionTimeoutMs, () => session.browser.newContext(input.contextOptions || {}));
        session.context.setDefaultTimeout?.(sessionTimeoutMs);
        session.context.setDefaultNavigationTimeout?.(sessionTimeoutMs);
        session.context.on?.("page", (page) => attachPage(session, page));
        const page = await withTimeout("context.newPage", sessionTimeoutMs, () => session.context.newPage());
        attachPage(session, page);
        session.status = "open";
        trace(session, "session.created", { browserType });
        return publicSession(session);
      } catch (error) {
        session.status = "closed";
        session.closedAt = now();
        await closeResources(session);
        sessions.delete(id);
        error.message = redactor.text(error.message);
        throw error;
      }
    },

    listSessions() {
      return [...sessions.values()].map(publicSession);
    },

    getSession(id) {
      return publicSession(requireSession(id));
    },

    async createPage(id) {
      const session = requireSession(id);
      const page = await withTimeout("context.newPage", session.timeoutMs, () => session.context.newPage());
      return publicPage(attachPage(session, page));
    },

    async closePage(id, pageId) {
      const session = requireSession(id);
      const record = requirePage(session, pageId);
      await withTimeout("page.close", session.timeoutMs, () => record.page.close());
      if (!record.closed) {
        record.closed = true;
        record.updatedAt = now();
        trace(session, "page.closed", { url: pageUrl(record.page, redactor) }, record.id);
      }
      return publicPage(record);
    },

    async navigate(id, input = {}) {
      const session = requireSession(id);
      const record = requirePage(session, input.pageId);
      const url = normalizeNavigationUrl(input.url);
      const operationTimeout = boundedInteger(input.timeoutMs, session.timeoutMs, 1, 300_000);
      const startedAt = now();
      trace(session, "navigation.started", { url, waitUntil: input.waitUntil || "load" }, record.id);
      try {
        const response = await withTimeout("page.goto", operationTimeout, () => record.page.goto(url, {
          waitUntil: input.waitUntil || "load",
          timeout: operationTimeout
        }));
        await updatePageTitle(record);
        const result = {
          ok: response ? responseStatus(response) < 400 : true,
          pageId: record.id,
          url: pageUrl(record.page, redactor),
          title: record.title,
          status: responseStatus(response),
          startedAt,
          completedAt: now()
        };
        trace(session, "navigation.completed", result, record.id);
        return result;
      } catch (error) {
        const safeError = redactor.text(error.message);
        trace(session, "navigation.failed", { url, error: safeError, code: error.code || "" }, record.id);
        error.message = safeError;
        throw error;
      }
    },

    async screenshot(id, input = {}) {
      const session = requireSession(id);
      const record = requirePage(session, input.pageId);
      const operationTimeout = boundedInteger(input.timeoutMs, session.timeoutMs, 1, 300_000);
      const type = input.type === "jpeg" ? "jpeg" : "png";
      const options = {
        type,
        fullPage: input.fullPage !== false,
        timeout: operationTimeout,
        ...(type === "jpeg" && Number.isFinite(Number(input.quality))
          ? { quality: boundedInteger(input.quality, 80, 0, 100) }
          : {})
      };
      const data = Buffer.from(await withTimeout("page.screenshot", operationTimeout, () => record.page.screenshot(options)));
      const result = {
        pageId: record.id,
        mimeType: type === "jpeg" ? "image/jpeg" : "image/png",
        bytes: data.length,
        data,
        capturedAt: now()
      };
      trace(session, "screenshot", { pageId: record.id, mimeType: result.mimeType, bytes: result.bytes }, record.id);
      return result;
    },

    getTrace(id, { after = 0, limit = DEFAULT_TRACE_PAGE_SIZE, types = [] } = {}) {
      const session = requireSession(id);
      const cursor = Math.max(0, Number(after) || 0);
      const pageSize = boundedInteger(limit, DEFAULT_TRACE_PAGE_SIZE, 1, MAX_TRACE_PAGE_SIZE);
      const selectedTypes = new Set(Array.isArray(types) ? types.map(String) : []);
      const available = session.trace.filter((event) => event.seq > cursor && (selectedTypes.size === 0 || selectedTypes.has(event.type)));
      const items = available.slice(0, pageSize);
      return {
        items,
        nextCursor: items.at(-1)?.seq ?? cursor,
        hasMore: available.length > items.length,
        droppedBefore: session.trace[0]?.seq ? session.trace[0].seq - 1 : session.droppedTraceEvents
      };
    },

    closeSession,

    async closeIdleSessions({ maxIdleMs = 10 * 60 * 1000 } = {}) {
      const threshold = Math.max(0, Number(maxIdleMs) || 0);
      const idle = [...sessions.values()].filter((session) => Date.now() - Date.parse(session.updatedAt) >= threshold);
      await Promise.all(idle.map((session) => closeSession(session.id, "idle timeout").catch(() => {})));
      return { closed: idle.length, remaining: sessions.size };
    },

    async closeAll(reason = "runtime cleanup") {
      const active = [...sessions.values()];
      await Promise.all(active.map((session) => closeSession(session.id, reason).catch(() => {})));
      return { closed: active.length, remaining: sessions.size };
    },

    stats() {
      return {
        sessions: sessions.size,
        pages: [...sessions.values()].reduce(
          (total, session) => total + [...session.pages.values()].filter((page) => !page.closed).length,
          0
        ),
        traceEvents: [...sessions.values()].reduce((total, session) => total + session.trace.length, 0)
      };
    }
  };
}

export { createRedactor as createBrowserTraceRedactor };
