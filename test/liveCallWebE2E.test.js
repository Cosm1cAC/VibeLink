import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const rootDir = path.resolve(import.meta.dirname, "..");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForBridge(baseUrl, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Bridge exited with ${child.exitCode}.`);
    try {
      if ((await fetch(baseUrl)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Bridge did not start.");
}

test("Web Live Call SSE authenticates after real Bridge login", { timeout: 60_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-live-call-web-e2e-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pairingToken = "LIVE-CALL-WEB-E2E";
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
    host: "127.0.0.1",
    port,
    pairingToken,
    allowLegacyPairingTokenLogin: true
  }), "utf8");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      VIBELINK_DATA_DIR: dataDir,
      VIBELINK_ASR: "mock",
      VIBELINK_SEARCH_INDEX_STARTUP: "0",
      VIBELINK_PROVIDER_CACHE_STARTUP: "0",
      MOBILE_AGENT_HOST: "127.0.0.1",
      MOBILE_AGENT_PORT: String(port),
      MOBILE_AGENT_TOKEN: pairingToken
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const browser = await chromium.launch({ headless: true });

  try {
    await waitForBridge(baseUrl, child);
    const loginResponse = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingToken, deviceLabel: "live-call-web-e2e" })
    });
    assert.equal(loginResponse.status, 200);
    const { token } = await loginResponse.json();
    assert.ok(token);

    const unauthorized = await fetch(`${baseUrl}/api/live-calls/missing/events?after=0`);
    assert.equal(unauthorized.status, 401);

    const createResponse = await fetch(`${baseUrl}/api/live-calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Web Live Call E2E", source: "web-ui", asrProvider: "mock" })
    });
    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();

    const page = await browser.newPage();
    await page.goto(baseUrl);
    await page.evaluate(async ({ baseUrl, token, sessionId }) => {
      const response = await fetch(`${baseUrl}/api/live-calls/${sessionId}/events?after=0`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`authenticated preflight failed: ${response.status}`);

      window.__liveCallEvent = new Promise((resolve, reject) => {
        const source = new EventSource(
          `${baseUrl}/api/live-calls/${sessionId}/events?token=${encodeURIComponent(token)}&after=0`
        );
        const timeout = setTimeout(() => {
          source.close();
          reject(new Error("Timed out waiting for live_call.transcript.final"));
        }, 10_000);
        source.addEventListener("live_call.transcript.final", (message) => {
          clearTimeout(timeout);
          source.close();
          resolve(JSON.parse(message.data));
        });
        source.onerror = () => {
          clearTimeout(timeout);
          source.close();
          reject(new Error("Authenticated EventSource failed"));
        };
      });
    }, { baseUrl, token, sessionId: session.id });

    const transcriptResponse = await fetch(`${baseUrl}/api/live-calls/${session.id}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "Web SSE authenticated", final: true, speaker: "remote" })
    });
    assert.equal(transcriptResponse.status, 200);
    const event = await page.evaluate(() => window.__liveCallEvent);
    assert.equal(event.text, "Web SSE authenticated");
  } finally {
    await browser.close();
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
