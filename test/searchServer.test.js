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

async function requestJson(url, { method = "GET", token = "", body } = {}) {
  const response = await fetch(url, {
    method,
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

test("search HTTP routes use the persistent index, saved searches, and history", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-search-server-"));
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
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "server.js")], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      VIBELINK_DATA_DIR: dataDir,
      MOBILE_AGENT_HOST: "127.0.0.1",
      MOBILE_AGENT_PORT: String(port),
      MOBILE_AGENT_TOKEN: "SEARCH-E2E",
      VIBELINK_SEARCH_INDEX_WATCH: "0"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const call = (url, options = {}) => requestJson(url, options).catch((error) => {
    error.message = `${error.message}\n${logs}`;
    throw error;
  });
  let login = null;
  for (let attempt = 0; attempt < 60 && !login; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup.\n${logs}`);
    try {
      login = await call(`${baseUrl}/api/login`, {
        method: "POST",
        body: { pairingToken: "SEARCH-E2E", deviceLabel: "search-e2e" }
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert.ok(login?.token, `Server did not become ready.\n${logs}`);

  const index = await call(`${baseUrl}/api/search/index`, { token: login.token });
  assert.equal(index.ready, true);
  assert.ok(index.indexedFiles >= 1);

  const search = await call(`${baseUrl}/api/search?q=${encodeURIComponent(alphaToken)}&scope=files&sort=title&order=asc`, { token: login.token });
  assert.equal(search.total, 1);
  assert.equal(search.items[0].path, "initial.txt");

  const saved = await call(`${baseUrl}/api/search/saved`, {
    method: "POST",
    token: login.token,
    body: { name: "Alpha files", query: alphaToken, scope: "files", sort: "title", order: "asc" }
  });
  const savedRun = await call(`${baseUrl}/api/search?savedSearchId=${saved.id}`, { token: login.token });
  assert.equal(savedRun.total, 1);
  assert.equal(savedRun.savedSearchId, saved.id);
  const history = await call(`${baseUrl}/api/search/history`, { token: login.token });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].useCount, 2);

  const workspaces = await call(`${baseUrl}/api/workspaces`, { token: login.token });
  const workspace = workspaces.items.find((item) => path.resolve(item.path) === path.resolve(workspaceDir));
  assert.ok(workspace);
  await call(`${baseUrl}/api/workspaces/${workspace.id}/file`, {
    method: "POST",
    token: login.token,
    body: { action: "write", path: "changed.txt", text: `${betaToken} incremental marker` }
  });
  const incremental = await call(`${baseUrl}/api/search?q=${encodeURIComponent(betaToken)}&scope=files`, { token: login.token });
  assert.equal(incremental.total, 1);
  assert.equal(incremental.items[0].path, "changed.txt");
});
