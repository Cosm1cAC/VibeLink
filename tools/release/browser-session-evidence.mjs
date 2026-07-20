#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1]] : null).filter(Boolean));
const baseUrl = String(args.url || process.env.VIBELINK_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = String(args.token || process.env.VIBELINK_TOKEN || "");
const outputDir = path.resolve(args.output || ".tmp/release-evidence/browser");
if (!token) throw new Error("Pass --token or set VIBELINK_TOKEN.");
fs.mkdirSync(outputDir, { recursive: true });

async function api(route, init = {}, expected = 200) {
  const response = await fetch(`${baseUrl}${route}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${init.method || "GET"} ${route}: ${JSON.stringify(data)}`);
  return data;
}

const secret = "release-evidence-secret-723";
const fixture = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<title>VibeLink evidence</title><main><h1>Bridge browser evidence</h1><p>${request.url}</p></main><script>console.log('token=${secret}')</script>`);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixturePort = fixture.address().port;

let sessionId = "";
try {
  const created = await api("/api/browser-sessions", { method: "POST", body: JSON.stringify({ maxTraceEvents: 100 }) }, 201);
  sessionId = created.session.id;
  const pageId = created.session.pages[0].id;
  for (let index = 0; index < 4; index += 1) await api(`/api/browser-sessions/${sessionId}/navigate`, { method: "POST", body: JSON.stringify({ pageId, url: `http://127.0.0.1:${fixturePort}/page-${index}?token=${secret}` }) });
  const shot = await api(`/api/browser-sessions/${sessionId}/screenshot`, { method: "POST", body: JSON.stringify({ pageId, type: "png" }) });
  fs.writeFileSync(path.join(outputDir, "bridge-page.png"), Buffer.from(shot.screenshot.dataBase64, "base64"));

  let after = 0;
  const trace = [];
  let pages = 0;
  do {
    const batch = await api(`/api/browser-sessions/${sessionId}/trace?after=${after}&limit=2`);
    trace.push(...batch.items);
    after = batch.nextCursor;
    pages += 1;
    if (!batch.hasMore) break;
  } while (pages < 100);
  assert.ok(pages > 1, "trace evidence must exercise pagination");
  assert.ok(trace.length > 2, "trace must contain browser events");
  assert.equal(JSON.stringify(trace).includes(secret), false, "trace leaked a secret");
  assert.ok((await api("/api/browser-sessions")).items.some((item) => item.id === sessionId), "session did not survive a new HTTP request");

  const browser = await chromium.launch({ headless: true });
  for (const [name, viewport] of [["desktop", { width: 1440, height: 960 }], ["phone", { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(baseUrl);
    await page.evaluate((value) => localStorage.setItem("mat.token", value), token);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Capability center").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `${name} layout overflows`);
    assert.deepEqual(errors, [], `${name} console errors: ${errors.join("; ")}`);
    await page.screenshot({ path: path.join(outputDir, `web-${name}.png`), fullPage: true });
    await page.close();
  }
  await browser.close();

  await api(`/api/browser-sessions/${sessionId}`, { method: "DELETE" });
  await api(`/api/browser-sessions/${sessionId}`, {}, 404);
  fs.writeFileSync(path.join(outputDir, "report.json"), JSON.stringify({ ok: true, bridge: baseUrl, traceEvents: trace.length, tracePages: pages, redactionVerified: true, reconnectVerified: true, cleanupVerified: true, viewports: ["desktop", "phone"], generatedAt: new Date().toISOString() }, null, 2));
} finally {
  if (sessionId) await fetch(`${baseUrl}/api/browser-sessions/${sessionId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  await new Promise((resolve) => fixture.close(resolve));
}
