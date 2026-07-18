import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createBrowserSessionRuntime, createBrowserTraceRedactor } from "../src/browserRuntime.js";

class FakePage extends EventEmitter {
  constructor() {
    super();
    this.currentUrl = "about:blank";
    this.currentTitle = "";
    this.closed = false;
  }

  url() { return this.currentUrl; }
  title() { return Promise.resolve(this.currentTitle); }
  mainFrame() { return this.frame || (this.frame = {}); }

  async goto(url) {
    this.currentUrl = url;
    this.currentTitle = "Runtime page";
    this.emit("framenavigated", this.mainFrame());
    return { status: () => 200 };
  }

  async screenshot(options) {
    this.screenshotOptions = options;
    return Buffer.from("fake-image");
  }

  async close() {
    this.closed = true;
    this.emit("close");
  }
}

class FakeContext extends EventEmitter {
  constructor() {
    super();
    this.pages = [];
    this.closed = false;
  }

  setDefaultTimeout(value) { this.defaultTimeout = value; }
  setDefaultNavigationTimeout(value) { this.defaultNavigationTimeout = value; }

  async newPage() {
    const page = new FakePage();
    this.pages.push(page);
    this.emit("page", page);
    return page;
  }

  async close() {
    this.closed = true;
    await Promise.all(this.pages.filter((page) => !page.closed).map((page) => page.close()));
  }
}

function fakePlaywright() {
  const state = { launches: 0, browsers: [], contexts: [] };
  return {
    state,
    chromium: {
      async launch(options) {
        state.launches += 1;
        const browser = {
          options,
          closed: false,
          async newContext(contextOptions) {
            const context = new FakeContext();
            context.options = contextOptions;
            state.contexts.push(context);
            return context;
          },
          async close() { this.closed = true; }
        };
        state.browsers.push(browser);
        return browser;
      }
    }
  };
}

function consoleMessage(text) {
  return {
    type: () => "log",
    text: () => text,
    location: () => ({ url: "https://example.test/app.js?token=console-secret", lineNumber: 4 })
  };
}

function networkRequest() {
  return {
    method: () => "POST",
    url: () => "https://example.test/api?access_token=query-secret&view=full",
    resourceType: () => "fetch",
    allHeaders: async () => ({ authorization: "Bearer header-secret", "content-type": "application/json" }),
    postData: () => JSON.stringify({ password: "body-secret", note: "visible" })
  };
}

test("browser runtime manages isolated session, page, navigation, screenshot, and cleanup", async () => {
  const fake = fakePlaywright();
  let nextId = 1;
  const runtime = createBrowserSessionRuntime({ playwright: fake, idFactory: () => `id-${nextId++}` });

  const session = await runtime.createSession({
    id: "session-1",
    timeoutMs: 500,
    launchOptions: { headless: true },
    contextOptions: { locale: "en-US" }
  });
  assert.equal(session.status, "open");
  assert.equal(session.pages.length, 1);
  assert.equal(fake.state.launches, 1);
  assert.equal(fake.state.contexts[0].defaultTimeout, 500);
  assert.deepEqual(fake.state.contexts[0].options, { locale: "en-US" });

  const pageId = session.pages[0].id;
  const navigation = await runtime.navigate(session.id, { pageId, url: "https://example.test/path", waitUntil: "domcontentloaded" });
  assert.equal(navigation.ok, true);
  assert.equal(navigation.status, 200);
  assert.equal(navigation.title, "Runtime page");

  const screenshot = await runtime.screenshot(session.id, { pageId, type: "jpeg", quality: 72, fullPage: false });
  assert.equal(screenshot.mimeType, "image/jpeg");
  assert.equal(screenshot.data.toString(), "fake-image");
  assert.deepEqual(fake.state.contexts[0].pages[0].screenshotOptions, {
    type: "jpeg",
    fullPage: false,
    timeout: 500,
    quality: 72
  });

  const secondPage = await runtime.createPage(session.id);
  assert.equal(runtime.getSession(session.id).pages.length, 2);
  await runtime.closePage(session.id, secondPage.id);
  assert.equal(runtime.getSession(session.id).pages.find((page) => page.id === secondPage.id).status, "closed");

  const closed = await runtime.closeSession(session.id, "test cleanup");
  assert.equal(closed.status, "closed");
  assert.equal(fake.state.contexts[0].closed, true);
  assert.equal(fake.state.browsers[0].closed, true);
  assert.deepEqual(runtime.stats(), { sessions: 0, pages: 0, traceEvents: 0 });
});

test("browser trace redacts console and network secrets before storage or callbacks", async () => {
  const fake = fakePlaywright();
  const emitted = [];
  const runtime = createBrowserSessionRuntime({ playwright: fake, idFactory: (() => { let id = 0; return () => `trace-${++id}`; })() });
  const session = await runtime.createSession({ id: "redaction", onTrace: (event) => emitted.push(event) });
  const page = fake.state.contexts[0].pages[0];

  page.emit("console", consoleMessage("authorization=Bearer console-secret password=console-password"));
  page.emit("request", networkRequest());
  page.emit("response", {
    url: () => "https://example.test/api?token=response-query-secret",
    status: () => 201,
    statusText: () => "Created",
    allHeaders: async () => ({ "set-cookie": "sid=response-cookie", "x-request-id": "visible-id" })
  });
  await new Promise((resolve) => setImmediate(resolve));

  const trace = runtime.getTrace(session.id, { limit: 100 });
  const serialized = JSON.stringify(trace.items);
  for (const secret of ["console-secret", "console-password", "query-secret", "header-secret", "body-secret", "response-query-secret", "response-cookie"]) {
    assert.equal(serialized.includes(secret), false, `trace leaked ${secret}`);
  }
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /visible-id/);
  assert.equal(JSON.stringify(emitted).includes("header-secret"), false);
  await runtime.closeAll();
});

test("browser trace is bounded and supports cursor pagination and type filters", async () => {
  const fake = fakePlaywright();
  const runtime = createBrowserSessionRuntime({ playwright: fake, maxTraceEvents: 4 });
  const session = await runtime.createSession({ id: "bounded" });
  const page = fake.state.contexts[0].pages[0];
  for (let index = 0; index < 6; index += 1) page.emit("console", consoleMessage(`message ${index}`));

  const first = runtime.getTrace(session.id, { limit: 2 });
  const second = runtime.getTrace(session.id, { after: first.nextCursor, limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.droppedBefore > 0, true);
  assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 2);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map((event) => event.seq)).size, 4);
  assert.equal(runtime.getTrace(session.id, { types: ["console"] }).items.every((event) => event.type === "console"), true);
  const { closeAll } = runtime;
  await closeAll();
});

test("browser runtime rejects unsafe navigation URLs and enforces operation timeouts", async () => {
  const fake = fakePlaywright();
  const runtime = createBrowserSessionRuntime({ playwright: fake, timeoutMs: 20 });
  const session = await runtime.createSession({ id: "timeouts" });
  const page = fake.state.contexts[0].pages[0];

  await assert.rejects(runtime.navigate(session.id, { url: "file:///private.txt" }), (error) => error.code === "EINVAL");
  await assert.rejects(runtime.navigate(session.id, { url: "https://user:pass@example.test/" }), (error) => error.code === "EINVAL");
  page.goto = () => new Promise(() => {});
  await assert.rejects(
    runtime.navigate(session.id, { url: "https://example.test/slow", timeoutMs: 5 }),
    (error) => error.code === "ETIMEDOUT" && error.operation === "page.goto"
  );
  const failures = runtime.getTrace(session.id, { types: ["navigation.failed"] });
  assert.equal(failures.items.length, 1);
  await runtime.closeAll();
});

test("browser runtime cleans partial sessions when Playwright launch fails or times out", async () => {
  const failed = createBrowserSessionRuntime({
    playwright: { chromium: { launch: async () => { throw new Error("Bearer launch-secret failed"); } } },
    timeoutMs: 50
  });
  await assert.rejects(failed.createSession({ id: "failed" }), (error) => {
    assert.equal(error.message.includes("launch-secret"), false);
    return true;
  });
  assert.equal(failed.stats().sessions, 0);

  const timedOut = createBrowserSessionRuntime({
    playwright: { chromium: { launch: () => new Promise(() => {}) } },
    timeoutMs: 5
  });
  await assert.rejects(timedOut.createSession({ id: "timed-out" }), (error) => error.code === "ETIMEDOUT");
  assert.equal(timedOut.stats().sessions, 0);
});

test("standalone trace redactor handles nested values, URLs, custom names, and patterns", () => {
  const redact = createBrowserTraceRedactor({ sensitiveNames: ["tenant-key"], patterns: [/private-\d+/] });
  const result = redact.value({
    url: "https://example.test/?token=url-secret&mode=visible",
    headers: { "tenant-key": "nested-secret", accept: "application/json" },
    message: "Bearer bearer-secret private-123"
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("url-secret"), false);
  assert.equal(serialized.includes("nested-secret"), false);
  assert.equal(serialized.includes("bearer-secret"), false);
  assert.equal(serialized.includes("private-123"), false);
  assert.match(serialized, /application\/json/);
});
