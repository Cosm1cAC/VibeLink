const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

function decode(value) {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function knownError(error) {
  if (error?.code === "ENOENT") return { status: 404, message: error.message, code: "BROWSER_SESSION_NOT_FOUND" };
  if (error?.code === "EEXIST") return { status: 409, message: error.message, code: "BROWSER_SESSION_CONFLICT" };
  if (error?.code === "EINVAL") return { status: 400, message: error.message, code: "BROWSER_SESSION_INVALID" };
  if (error?.code === "ETIMEDOUT") return { status: 504, message: "Browser operation timed out.", code: "BROWSER_SESSION_TIMEOUT" };
  if (error?.code === "SCREENSHOT_TOO_LARGE") return { status: 413, message: "Browser screenshot is too large.", code: error.code };
  return { status: 500, message: "Browser operation failed.", code: "BROWSER_SESSION_ERROR" };
}

export async function routeBrowserSessionRequest(request, response, url, auth, dependencies) {
  if (!url.pathname.startsWith("/api/browser-sessions")) return false;
  const { runtime, readBody, sendJson, sendError, enforceRateLimit, audit } = dependencies;
  const rateLimited = (scope, options = { limit: 60, windowMs: 60_000 }) =>
    !enforceRateLimit(request, response, url, scope, options, auth);
  const record = (event) => audit(request, url, auth, event);

  try {
    if (url.pathname === "/api/browser-sessions" && request.method === "GET") {
      sendJson(response, 200, { items: runtime.listSessions() });
      return true;
    }

    if (url.pathname === "/api/browser-sessions" && request.method === "POST") {
      if (rateLimited("browser.session.create", { limit: 12, windowMs: 60_000 })) return true;
      const body = await readBody(request);
      const executablePath = String(process.env.VIBELINK_CHROMIUM_EXECUTABLE || "").trim();
      const session = await runtime.createSession({
        browserType: "chromium",
        timeoutMs: number(body.timeoutMs, undefined),
        maxTraceEvents: number(body.maxTraceEvents, undefined),
        launchOptions: { headless: true, ...(executablePath ? { executablePath } : {}) }
      });
      record({ type: "browser.session.create", success: true, target: session.id });
      sendJson(response, 201, { session });
      return true;
    }

    const match = url.pathname.match(/^\/api\/browser-sessions\/([^/]+)(?:\/(pages|navigate|screenshot|trace)(?:\/([^/]+))?)?$/);
    if (!match) return false;
    const id = decode(match[1]);
    const action = match[2] || "detail";
    const childId = decode(match[3] || "");

    if (action === "detail" && request.method === "GET") {
      sendJson(response, 200, { session: runtime.getSession(id) });
      return true;
    }
    if (action === "detail" && request.method === "DELETE") {
      if (rateLimited("browser.session.close")) return true;
      const session = await runtime.closeSession(id, "remote close");
      record({ type: "browser.session.close", success: true, target: id });
      sendJson(response, 200, { session });
      return true;
    }
    if (action === "pages" && !childId && request.method === "POST") {
      if (rateLimited("browser.page.create")) return true;
      sendJson(response, 201, { page: await runtime.createPage(id) });
      return true;
    }
    if (action === "pages" && childId && request.method === "DELETE") {
      if (rateLimited("browser.page.close")) return true;
      sendJson(response, 200, { page: await runtime.closePage(id, childId) });
      return true;
    }
    if (action === "navigate" && request.method === "POST") {
      if (rateLimited("browser.navigation", { limit: 120, windowMs: 60_000 })) return true;
      const body = await readBody(request);
      const navigation = await runtime.navigate(id, {
        pageId: String(body.pageId || ""),
        url: String(body.url || ""),
        waitUntil: ["load", "domcontentloaded", "networkidle", "commit"].includes(body.waitUntil) ? body.waitUntil : "load",
        timeoutMs: number(body.timeoutMs, undefined)
      });
      record({ type: "browser.navigation", success: true, target: id, meta: { pageId: navigation.pageId, status: navigation.status } });
      sendJson(response, 200, { navigation });
      return true;
    }
    if (action === "screenshot" && request.method === "POST") {
      if (rateLimited("browser.screenshot", { limit: 30, windowMs: 60_000 })) return true;
      const body = await readBody(request);
      const result = await runtime.screenshot(id, {
        pageId: String(body.pageId || ""),
        type: body.type === "jpeg" ? "jpeg" : "png",
        quality: number(body.quality, undefined),
        fullPage: body.fullPage === true,
        timeoutMs: number(body.timeoutMs, undefined)
      });
      if (result.bytes > MAX_SCREENSHOT_BYTES) throw Object.assign(new Error("Screenshot too large."), { code: "SCREENSHOT_TOO_LARGE" });
      const { data, ...metadata } = result;
      sendJson(response, 200, { screenshot: { ...metadata, dataBase64: Buffer.from(data).toString("base64") } });
      return true;
    }
    if (action === "trace" && request.method === "GET") {
      const trace = runtime.getTrace(id, {
        after: number(url.searchParams.get("after"), 0),
        limit: number(url.searchParams.get("limit"), 100),
        types: String(url.searchParams.get("types") || "").split(",").map((item) => item.trim()).filter(Boolean)
      });
      sendJson(response, 200, trace);
      return true;
    }
    return false;
  } catch (error) {
    const safe = knownError(error);
    record({ type: "browser.session.error", success: false, target: url.pathname, reason: safe.message });
    sendError(response, safe.status, safe.message, { code: safe.code });
    return true;
  }
}
