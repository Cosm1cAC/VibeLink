import assert from "node:assert/strict";
import test from "node:test";

import { routeBrowserSessionRequest } from "../src/browserSessionHttp.js";

function createHarness({ body = {}, runtimeOverrides = {} } = {}) {
  const calls = [];
  const runtime = {
    listSessions: () => [{ id: "session-1", status: "open", pages: [] }],
    createSession: async (input) => ({ id: "created", status: "open", pages: [{ id: "page-1" }], input }),
    getSession: (id) => ({ id, status: "open", pages: [{ id: "page-1" }] }),
    closeSession: async (id, reason) => ({ id, reason, status: "closed" }),
    createPage: async () => ({ id: "page-2", status: "open" }),
    closePage: async (_id, pageId) => ({ id: pageId, status: "closed" }),
    navigate: async (_id, input) => ({ ok: true, pageId: input.pageId, url: input.url, status: 200 }),
    screenshot: async () => ({ pageId: "page-1", mimeType: "image/png", bytes: 4, data: Buffer.from("shot"), capturedAt: "now" }),
    getTrace: (_id, input) => ({ items: [], nextCursor: input.after || 0, hasMore: false, droppedBefore: 0 }),
    ...runtimeOverrides
  };
  return {
    runtime,
    calls,
    dependencies: {
      runtime,
      readBody: async () => body,
      sendJson: (_response, status, payload) => calls.push({ status, payload }),
      sendError: (_response, status, message, details) => calls.push({ status, message, details }),
      enforceRateLimit: () => true,
      audit: (_request, _url, _auth, event) => calls.push({ audit: event })
    }
  };
}

async function route(harness, method, path) {
  const url = new URL(path, "http://localhost");
  const handled = await routeBrowserSessionRequest(
    { method, headers: {} },
    {},
    url,
    { device: { id: "device-1" } },
    harness.dependencies
  );
  return { handled, responses: harness.calls.filter((call) => "status" in call) };
}

test("browser session HTTP contract lists and creates bridge-owned Chromium sessions", async () => {
  const listHarness = createHarness();
  const listed = await route(listHarness, "GET", "/api/browser-sessions?fields=id,status");
  assert.equal(listed.handled, true);
  assert.deepEqual(listed.responses[0], {
    status: 200,
    payload: { items: [{ id: "session-1", status: "open", pages: [] }] }
  });

  const createHarnessState = createHarness({ body: { timeoutMs: 9000, maxTraceEvents: 500, browserType: "firefox" } });
  const created = await route(createHarnessState, "POST", "/api/browser-sessions");
  assert.equal(created.responses[0].status, 201);
  assert.deepEqual(created.responses[0].payload.session.input, {
    browserType: "chromium",
    timeoutMs: 9000,
    maxTraceEvents: 500,
    launchOptions: { headless: true }
  });
});

test("browser session HTTP contract navigates, returns bounded screenshots, and paginates trace", async () => {
  const navigationHarness = createHarness({ body: { pageId: "page-1", url: "https://example.test", waitUntil: "domcontentloaded" } });
  const navigated = await route(navigationHarness, "POST", "/api/browser-sessions/session-1/navigate");
  assert.equal(navigated.responses[0].status, 200);
  assert.equal(navigated.responses[0].payload.navigation.url, "https://example.test");

  const screenshotHarness = createHarness({ body: { pageId: "page-1", fullPage: false } });
  const screenshot = await route(screenshotHarness, "POST", "/api/browser-sessions/session-1/screenshot");
  assert.deepEqual(screenshot.responses[0], {
    status: 200,
    payload: { screenshot: { pageId: "page-1", mimeType: "image/png", bytes: 4, dataBase64: "c2hvdA==", capturedAt: "now" } }
  });

  let traceInput;
  const traceHarness = createHarness({ runtimeOverrides: { getTrace: (_id, input) => { traceInput = input; return { items: [], nextCursor: 8, hasMore: false, droppedBefore: 0 }; } } });
  const trace = await route(traceHarness, "GET", "/api/browser-sessions/session-1/trace?after=4&limit=20&types=console,navigation.completed");
  assert.equal(trace.responses[0].status, 200);
  assert.deepEqual(traceInput, { after: 4, limit: 20, types: ["console", "navigation.completed"] });
});

test("browser session HTTP contract maps known failures without leaking internal errors", async () => {
  const missing = createHarness({ runtimeOverrides: { getSession: () => { throw Object.assign(new Error("Browser session not found."), { code: "ENOENT" }); } } });
  const notFound = await route(missing, "GET", "/api/browser-sessions/missing");
  assert.deepEqual(notFound.responses[0], { status: 404, message: "Browser session not found.", details: { code: "BROWSER_SESSION_NOT_FOUND" } });

  const failed = createHarness({ runtimeOverrides: { navigate: async () => { throw new Error("Bearer private-secret failed"); } } });
  const result = await route(failed, "POST", "/api/browser-sessions/session-1/navigate");
  assert.equal(result.responses[0].status, 500);
  assert.equal(result.responses[0].message, "Browser operation failed.");
  assert.equal(JSON.stringify(result.responses).includes("private-secret"), false);
});
