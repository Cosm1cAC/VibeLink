import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForBridge(baseUrl, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Bridge exited with ${child.exitCode}.`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Bridge did not start.");
}

async function pairDevice(baseUrl, pairingToken, label) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingToken, label })
  });
  if (response.status !== 200) assert.fail(await response.text());
  return (await response.json()).token;
}

function auth(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

test("settings ETags reject a stale second-device mutation with the current snapshot", { timeout: 60_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-revision-http-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pairingToken = "REVISION-TEST";
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
      MOBILE_AGENT_HOST: "127.0.0.1",
      MOBILE_AGENT_PORT: String(port),
      MOBILE_AGENT_TOKEN: pairingToken,
      VIBELINK_SEARCH_INDEX_STARTUP: "0",
      VIBELINK_PROVIDER_CACHE_STARTUP: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForBridge(baseUrl, child);
    const deviceA = await pairDevice(baseUrl, pairingToken, "Device A");
    const deviceB = await pairDevice(baseUrl, pairingToken, "Device B");
    const initial = await fetch(`${baseUrl}/api/settings`, { headers: auth(deviceA) });
    assert.equal(initial.status, 200);
    assert.match(initial.headers.get("etag") || "", /^"vibelink:settings:/);
    const initialBody = await initial.json();
    const revision = initialBody.settings.revision;

    const first = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: auth(deviceA, { "Content-Type": "application/json", "If-Match": initial.headers.get("etag") }),
      body: JSON.stringify({ defaultCwd: "C:/device-a", expectedRevision: revision })
    });
    if (first.status !== 200) assert.fail(await first.text());

    const stale = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: auth(deviceB, { "Content-Type": "application/json", "If-Match": initial.headers.get("etag") }),
      body: JSON.stringify({ defaultCwd: "C:/device-b", expectedRevision: revision })
    });
    assert.equal(stale.status, 409);
    assert.match(stale.headers.get("etag") || "", /^"vibelink:settings:/);
    const conflict = await stale.json();
    assert.equal(conflict.code, "SETTINGS_CONFLICT");
    assert.equal(conflict.expectedRevision, revision);
    assert.equal(conflict.actualRevision, revision + 1);
    assert.equal(conflict.current.settings.defaultCwd, "C:/device-a");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("thread and batch mutations return ETags and roll back stale multi-device writes", { timeout: 60_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-thread-revision-http-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pairingToken = "THREAD-REVISION-TEST";
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
    host: "127.0.0.1",
    port,
    pairingToken,
    allowLegacyPairingTokenLogin: true
  }), "utf8");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: rootDir,
    env: { ...process.env, VIBELINK_DATA_DIR: dataDir, MOBILE_AGENT_HOST: "127.0.0.1", MOBILE_AGENT_PORT: String(port), VIBELINK_SEARCH_INDEX_STARTUP: "0", VIBELINK_PROVIDER_CACHE_STARTUP: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForBridge(baseUrl, child);
    const deviceA = await pairDevice(baseUrl, pairingToken, "Device A");
    const deviceB = await pairDevice(baseUrl, pairingToken, "Device B");
    const initial = await fetch(`${baseUrl}/api/thread-state`, { headers: auth(deviceA) });
    assert.equal(initial.status, 200);
    assert.match(initial.headers.get("etag") || "", /^"vibelink:thread-state:/);

    const first = await fetch(`${baseUrl}/api/thread-state`, {
      method: "POST",
      headers: auth(deviceA, { "Content-Type": "application/json" }),
      body: JSON.stringify({ key: "history:codex:a", patch: { favorite: true }, expectedRevision: 0 })
    });
    assert.equal(first.status, 200);
    assert.match(first.headers.get("etag") || "", /^"vibelink:thread-state:/);

    const stale = await fetch(`${baseUrl}/api/thread-state`, {
      method: "POST",
      headers: auth(deviceB, { "Content-Type": "application/json" }),
      body: JSON.stringify({ key: "history:codex:a", patch: { favorite: false }, expectedRevision: 0 })
    });
    assert.equal(stale.status, 409);
    assert.match(stale.headers.get("etag") || "", /^"vibelink:thread-state:/);
    assert.equal((await stale.json()).state.items["history:codex:a"].favorite, true);

    const createdB = await fetch(`${baseUrl}/api/thread-state`, {
      method: "POST",
      headers: auth(deviceA, { "Content-Type": "application/json" }),
      body: JSON.stringify({ key: "history:codex:b", patch: { favorite: false }, expectedRevision: 0 })
    });
    const base = await createdB.json();
    const baseA = base.items["history:codex:a"].revision;
    const baseB = base.items["history:codex:b"].revision;

    await fetch(`${baseUrl}/api/thread-state`, {
      method: "POST",
      headers: auth(deviceA, { "Content-Type": "application/json" }),
      body: JSON.stringify({ key: "history:codex:b", patch: { favorite: true }, expectedRevision: baseB })
    });
    const batch = await fetch(`${baseUrl}/api/thread-state/batch`, {
      method: "POST",
      headers: auth(deviceB, { "Content-Type": "application/json" }),
      body: JSON.stringify({ updates: [
        { key: "history:codex:a", patch: { pinned: true }, expectedRevision: baseA },
        { key: "history:codex:b", patch: { favorite: false }, expectedRevision: baseB }
      ] })
    });
    assert.equal(batch.status, 409);
    assert.match(batch.headers.get("etag") || "", /^"vibelink:thread-state:/);
    const conflict = await batch.json();
    assert.equal(conflict.state.items["history:codex:a"].pinned, false);
    assert.equal(conflict.state.items["history:codex:b"].favorite, true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("workspace file ETags reject a stale second-device write with refresh content", { timeout: 60_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-revision-http-"));
  const workspaceRoot = path.join(dataDir, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pairingToken = "WORKSPACE-REVISION-TEST";
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
    host: "127.0.0.1",
    port,
    pairingToken,
    allowLegacyPairingTokenLogin: true,
    allowedRoots: [workspaceRoot]
  }), "utf8");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: rootDir,
    env: { ...process.env, VIBELINK_DATA_DIR: dataDir, MOBILE_AGENT_HOST: "127.0.0.1", MOBILE_AGENT_PORT: String(port), VIBELINK_SEARCH_INDEX_STARTUP: "0", VIBELINK_PROVIDER_CACHE_STARTUP: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForBridge(baseUrl, child);
    const deviceA = await pairDevice(baseUrl, pairingToken, "Device A");
    const deviceB = await pairDevice(baseUrl, pairingToken, "Device B");
    const createdWorkspace = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: auth(deviceA, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "Revision", path: workspaceRoot, allowedRoot: workspaceRoot })
    });
    const workspaceId = (await createdWorkspace.json()).workspace.id;
    const fileUrl = `${baseUrl}/api/workspaces/${workspaceId}/file`;
    const createdFile = await fetch(fileUrl, {
      method: "POST",
      headers: auth(deviceA, { "Content-Type": "application/json" }),
      body: JSON.stringify({ action: "write", path: "notes.md", text: "base\n" })
    });
    assert.equal(createdFile.status, 200);
    assert.match(createdFile.headers.get("etag") || "", /^"vibelink:workspace-file:/);

    const fileA = await fetch(`${fileUrl}?path=notes.md`, { headers: auth(deviceA) });
    const fileB = await fetch(`${fileUrl}?path=notes.md`, { headers: auth(deviceB) });
    assert.equal(fileA.headers.get("etag"), fileB.headers.get("etag"));
    const baseA = await fileA.json();
    const baseB = await fileB.json();

    const first = await fetch(fileUrl, {
      method: "POST",
      headers: auth(deviceA, { "Content-Type": "application/json", "If-Match": baseA.etag }),
      body: JSON.stringify({ action: "write", path: "notes.md", text: "from device A\n", expectedRevision: baseA.revision })
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();

    const stale = await fetch(fileUrl, {
      method: "POST",
      headers: auth(deviceB, { "Content-Type": "application/json", "If-Match": baseB.etag }),
      body: JSON.stringify({ action: "write", path: "notes.md", text: "from device B\n", expectedRevision: baseB.revision })
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.headers.get("etag"), firstBody.etag);
    const conflict = await stale.json();
    assert.equal(conflict.code, "WORKSPACE_FILE_CONFLICT");
    assert.equal(conflict.current.text, "from device A\n");
    assert.equal(conflict.actualRevision, firstBody.revision);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
