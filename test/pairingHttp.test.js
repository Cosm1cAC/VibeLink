import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(child, port, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup.\n${logs()}`);
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const finish = (value) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready.\n${logs()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function requestJson(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(10_000),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const value = await response.json();
  assert.equal(response.ok, true, `${response.status}: ${value.error || JSON.stringify(value)}`);
  return value;
}

test("pairing claim is retryable and never exposes the token through status", { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "vibelink-pairing-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "server.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      VIBELINK_DATA_DIR: dataDir,
      VIBELINK_SEARCH_INDEX_STARTUP: "0",
      VIBELINK_PROVIDER_CACHE_STARTUP: "0",
      MOBILE_AGENT_HOST: "127.0.0.1",
      MOBILE_AGENT_PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    await stopChild(child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await waitForServer(child, port, () => output);
  const baseUrl = `http://127.0.0.1:${port}`;
  const created = await requestJson(`${baseUrl}/api/pairing-sessions`, {
    method: "POST",
    body: { deviceLabel: "Pairing retry test", trustLocalLauncher: true }
  });
  assert.equal(created.session.status, "approved");

  const claimBody = { code: created.session.code, deviceLabel: "Android" };
  const first = await requestJson(`${baseUrl}/api/pairing-sessions/${created.session.id}/claim`, {
    method: "POST",
    body: claimBody
  });
  const retry = await requestJson(`${baseUrl}/api/pairing-sessions/${created.session.id}/claim`, {
    method: "POST",
    body: claimBody
  });
  const status = await requestJson(`${baseUrl}/api/pairing-sessions/${created.session.id}`);

  assert.ok(first.token);
  assert.deepEqual(Object.keys(first).sort(), ["device", "ok", "session", "settings", "token"]);
  assert.deepEqual(Object.keys(retry).sort(), ["device", "ok", "session", "settings", "token"]);
  assert.equal(retry.token, first.token);
  assert.equal(retry.device.id, first.device.id);
  assert.ok(first.settings);
  assert.equal(Object.hasOwn(status.session, "token"), false);
});
