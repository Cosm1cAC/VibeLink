import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    return;
  }
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}

async function requestJson(url, { method = "GET", token = "", body, timeoutMs = 5000 } = {}) {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${value.error || JSON.stringify(value)}`);
  return value;
}

test("search HTTP routes use the persistent index, saved searches, and history", { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "vibelink-search-server-"));
  const dataDir = path.join(root, "data");
  const workspaceDir = path.join(root, "workspace");
  const alphaToken = ["fixturealpha", "7f3d"].join("");
  const betaToken = ["fixturebeta", "9c2e"].join("");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, "initial.txt"), `${alphaToken} marker`, "utf8");
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
    pairingToken: "SEARCH-E2E",
    defaultCwd: workspaceDir,
    allowedRoots: [workspaceDir],
    security: { trustedWorkspaces: [workspaceDir] }
  }), "utf8");
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "server.js")], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      VIBELINK_DATA_DIR: dataDir,
      VIBELINK_SEARCH_INDEX_STARTUP: "1",
      VIBELINK_PROVIDER_CACHE_STARTUP: "0",
      MOBILE_AGENT_HOST: "127.0.0.1",
      MOBILE_AGENT_PORT: "0",
      MOBILE_AGENT_TOKEN: "SEARCH-E2E",
      VIBELINK_SEARCH_INDEX_WATCH: "0",
      VIBELINK_SEARCH_INDEX_ONLY_DEFAULT_CWD: "1",
      VIBELINK_EXECUTION_HOST: "off"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    await stopChild(child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const startupDeadline = Date.now() + 30_000;
  let port = 0;
  while (Date.now() < startupDeadline && port === 0) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup.\n${logs}`);
    const match = logs.match(/VibeLink listening on http:\/\/localhost:(\d+)/);
    port = Number(match?.[1] || 0);
    if (port === 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(port > 0, `Server did not become ready.\n${logs}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  const call = (url, options = {}) => requestJson(url, options).catch((error) => {
    throw new Error(`${error.message}\n${logs}`, { cause: error });
  });
  const login = await call(`${baseUrl}/api/login`, {
    method: "POST",
    body: { pairingToken: "SEARCH-E2E", deviceLabel: "search-e2e" },
    timeoutMs: 10_000
  });
  assert.ok(login?.token, `Server login failed after startup.\n${logs}`);

  const indexDeadline = Date.now() + 45_000;
  let index = null;
  let indexError = null;
  while (Date.now() < indexDeadline && !index?.ready) {
    if (child.exitCode !== null) throw new Error(`Server exited while building the search index.\n${logs}`);
    try {
      index = await call(`${baseUrl}/api/search/index`, { token: login.token, timeoutMs: 2000 });
      indexError = null;
    } catch (error) {
      index = null;
      indexError = error;
    }
    if (!index?.ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(index?.ready, true, `Search index did not become ready.${indexError ? `\n${indexError.message}` : ""}\n${logs}`);
  assert.ok(index.indexedFiles >= 1);

  const search = await call(`${baseUrl}/api/search?q=${encodeURIComponent(alphaToken)}&scope=files&sessionOrigin=vibelink-cli&sort=title&order=asc`, { token: login.token });
  assert.equal(search.total, 1);
  assert.equal(search.items[0].path, "initial.txt");

  const saved = await call(`${baseUrl}/api/search/saved`, {
    method: "POST",
    token: login.token,
    body: { name: "Alpha files", query: alphaToken, scope: "files", sessionOrigin: "vibelink-cli", sort: "title", order: "asc" }
  });
  assert.equal(saved.sessionOrigin, "vibelink-cli");
  const savedRun = await call(`${baseUrl}/api/search?savedSearchId=${saved.id}`, { token: login.token });
  assert.equal(savedRun.total, 1);
  assert.equal(savedRun.savedSearchId, saved.id);
  const history = await call(`${baseUrl}/api/search/history`, { token: login.token });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].sessionOrigin, "vibelink-cli");
  assert.equal(history.items[0].useCount, 2);

  const workspaces = await call(`${baseUrl}/api/workspaces`, { token: login.token });
  const workspace = workspaces.items.find((item) => path.resolve(item.path) === path.resolve(workspaceDir));
  assert.ok(workspace);
  await call(`${baseUrl}/api/workspaces/${workspace.id}/file`, {
    method: "POST",
    token: login.token,
    body: { action: "write", path: "changed.txt", text: `${betaToken} incremental marker` }
  });
  const incrementalDeadline = Date.now() + 30_000;
  let incremental = null;
  while (Date.now() < incrementalDeadline && incremental?.total !== 1) {
    incremental = await call(`${baseUrl}/api/search?q=${encodeURIComponent(betaToken)}&scope=files`, { token: login.token });
    if (incremental.total !== 1) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(incremental.total, 1);
  assert.equal(incremental.items[0].path, "changed.txt");
});
