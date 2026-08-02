import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";

import { rustBinaryIsCurrent } from "./rustTestSupport.js";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(root, "apps", "windows", "src");
const binary = path.join(root, "apps", "windows", "target", "debug", process.platform === "win32" ? "vibelink.exe" : "vibelink");
const nativeFetch = globalThis.fetch;
const checkpointPath = process.env.VIBELINK_RUST_ONLY_E2E_CHECKPOINT || "";
const STARTUP_CONCURRENT_REQUESTS = 20;

function checkpoint(stage) {
  if (checkpointPath) fs.writeFileSync(checkpointPath, `${new Date().toISOString()} ${stage}\n`);
}

function fetch(input, init = {}) {
  return nativeFetch(input, {
    ...init,
    signal: init.signal || AbortSignal.timeout(15_000)
  });
}

async function waitFor(url, options) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(1_000) });
      if (response.status !== 503) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Rust-only discovery server did not become ready: ${url}`);
}

function descendantNodeProcesses(pid) {
  if (process.platform !== "win32") return [];
  const script = `$bad=@(); function Visit([int]$p){$children=@(Get-CimInstance Win32_Process -Filter \"ParentProcessId = $p\" -ErrorAction SilentlyContinue); foreach($child in $children){if($child.Name -ieq \"node.exe\"){$bad += $child.ExecutablePath}; Visit $child.ProcessId}}; Visit ${pid}; $bad | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const value = JSON.parse(result.stdout);
  return Array.isArray(value) ? value : [value];
}

test("Web and Android consume Rust-owned discovery without a Node backend", { timeout: 300_000 }, async (t) => {
  checkpoint("test-start");
  const cargo = process.env.CARGO || path.join(os.homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  if (!fs.existsSync(cargo)) return t.skip("cargo is not available");
  if (!rustBinaryIsCurrent(binary, sourceRoot)) {
    const build = spawnSync(cargo, ["build", "--manifest-path", "apps/windows/Cargo.toml"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-rust-only-discovery-"));
  const browserFixture = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Rust-only browser fixture");
  });
  await new Promise((resolve, reject) => {
    browserFixture.once("error", reject);
    browserFixture.listen(0, "127.0.0.1", resolve);
  });
  const browserFixturePort = browserFixture.address().port;
  const workspaceDir = path.join(directory, "workspace");
  const artifactId = "11111111-1111-4111-8111-111111111111.txt";
  fs.mkdirSync(path.join(directory, "home", ".vibelink", "skills", "e2e"), { recursive: true });
  fs.mkdirSync(path.join(directory, "attachments"), { recursive: true });
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(directory, "home", ".vibelink", "skills", "e2e", "SKILL.md"), "---\nname: e2e\ndescription: E2E skill\n---\nRun E2E.");
  fs.writeFileSync(path.join(directory, "attachments", artifactId), "hello from rust artifact\n");
  fs.writeFileSync(path.join(workspaceDir, "download.txt"), "hello from rust file\n");
  for (let index = 0; index < 96; index += 1) {
    fs.writeFileSync(
      path.join(workspaceDir, `startup-index-${index}.ts`),
      `export const startupIndex${index} = "rust startup concurrency marker ${index}";\n`
    );
  }
  fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({
    pairingToken: "PAIR",
    hostAllowlist: ["127.0.0.1"],
    defaultCwd: workspaceDir,
    allowedRoots: [workspaceDir],
    security: { trustedWorkspaces: [workspaceDir] },
    webPush: { publicKey: "push-key" }
  }));
  const database = new DatabaseSync(path.join(directory, "mobile-agent.sqlite"));
  database.exec("CREATE TABLE devices (id TEXT, label TEXT, token_hash TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT, expires_at TEXT, rotated_at TEXT, meta_json TEXT); CREATE TABLE mcp_tools (server_name TEXT, tool_name TEXT, full_name TEXT PRIMARY KEY, title TEXT, description TEXT, input_schema TEXT); CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT, title TEXT, allowed_root TEXT, created_at TEXT, updated_at TEXT, last_used_at TEXT); CREATE TABLE audit_log (cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, event_at TEXT, device_id TEXT, ip TEXT, user_agent TEXT, method TEXT, path TEXT, success INTEGER, reason TEXT, target TEXT, meta_json TEXT, created_at TEXT); CREATE TABLE desktop_observations (cursor INTEGER PRIMARY KEY, observed_at TEXT, hash TEXT, event_type TEXT, observation_json TEXT, event_json TEXT); CREATE TABLE tool_runs (id TEXT PRIMARY KEY, task_id TEXT, workspace_id TEXT, tool_name TEXT NOT NULL, status TEXT NOT NULL, title TEXT, input_json TEXT, result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT); CREATE TABLE tool_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, tool_run_id TEXT NOT NULL, task_id TEXT, workspace_id TEXT, event_id TEXT NOT NULL, event_type TEXT NOT NULL, event_at TEXT NOT NULL, text TEXT, payload_json TEXT, event_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tool_run_id,event_id)); CREATE TABLE approval_requests (id TEXT PRIMARY KEY, tool_run_id TEXT, task_id TEXT, workspace_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT, reason TEXT, request_json TEXT, risk_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT, decided_at TEXT, decided_by_device_id TEXT, decision_reason TEXT, decision_json TEXT); CREATE TABLE pairing_sessions (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, label TEXT, ip TEXT, user_agent TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, approved_at TEXT, approved_by_device_id TEXT, claimed_at TEXT, device_id TEXT, meta_json TEXT); CREATE TABLE threads (key TEXT PRIMARY KEY, title TEXT, group_name TEXT, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, meta_json TEXT, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL); CREATE TABLE thread_forks (id TEXT PRIMARY KEY, source_key TEXT NOT NULL, source_id TEXT NOT NULL, provider TEXT NOT NULL, title TEXT NOT NULL, cwd TEXT, group_name TEXT, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE event_acks (device_id TEXT NOT NULL, stream_id TEXT NOT NULL, cursor INTEGER NOT NULL, event_id TEXT, acked_at TEXT NOT NULL, metadata_json TEXT);");
  const hash = crypto.createHash("sha256").update("device-token").digest("hex");
  database.prepare("INSERT INTO devices VALUES (?, ?, ?, '', '', NULL, ?, NULL, '{}')").run("device", "Web E2E", hash, "2099-01-01T00:00:00.000Z");
  database.prepare("INSERT INTO mcp_tools VALUES (?, ?, ?, ?, ?, ?)").run("memory", "search", "mcp__memory__search", "Search", "Search graph", "{\"type\":\"object\"}");
  database.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?, ?)").run("workspace", workspaceDir, "Rust-only Workspace", workspaceDir, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.prepare("INSERT INTO desktop_observations VALUES (?, ?, ?, ?, ?, ?)").run(1, "2026-07-01T00:00:00.000Z", "desktop-hash", "desktop.snapshot", "{\"ready\":true}", "null");
  database.close();

  const child = spawn(binary, ["--host", "127.0.0.1", "--port", "0", "rust-only", "--data-dir", directory], {
    cwd: root,
    env: { ...process.env, HOME: path.join(directory, "home"), USERPROFILE: path.join(directory, "home") },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    checkpoint("cleanup-start");
    if (child.exitCode === null) {
      if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ]);
    }
    checkpoint("cleanup-child-complete");
    browserFixture.closeAllConnections();
    await Promise.race([
      new Promise((resolve) => browserFixture.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
    checkpoint("cleanup-fixture-complete");
    fs.rmSync(directory, { recursive: true, force: true });
    checkpoint("cleanup-complete");
  });

  const startupDeadline = Date.now() + 15_000;
  let port = 0;
  while (Date.now() < startupDeadline && port === 0) {
    if (child.exitCode !== null) throw new Error(`Rust-only discovery server exited during startup.\n${logs}`);
    const match = logs.match(/Rust-only HTTP server listening on 127\.0\.0\.1:(\d+)/);
    port = Number(match?.[1] || 0);
    if (port === 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(port > 0, `Rust-only discovery server did not become ready.\n${logs}`);
  const headers = { Authorization: "Bearer device-token" };
  const startupPaths = ["/api/status", "/api/tasks", "/api/devices", "/api/pairing-sessions"];
  const startupResponses = await Promise.all(
    Array.from({ length: STARTUP_CONCURRENT_REQUESTS }, (_, index) =>
      fetch(`http://127.0.0.1:${port}${startupPaths[index % startupPaths.length]}`, { headers })
    )
  );
  for (const response of startupResponses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-vibelink-control-plane"), "rust");
  }
  checkpoint("server-ready");
  const openApiResponse = await fetch(`http://127.0.0.1:${port}/api/openapi.json`);
  assert.equal(openApiResponse.status, 200);
  assert.equal(openApiResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.match(openApiResponse.headers.get("content-type") || "", /^application\/json/);
  const openApi = await openApiResponse.json();
  assert.equal(openApi.openapi, "3.0.3");
  assert.equal(openApi.info.title, "VibeLink HTTP API");
  assert.ok(openApi.paths["/api/status"]);

  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`, { headers });
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.headers.get("x-vibelink-control-plane"), "rust");
  const status = await statusResponse.json();
  assert.equal(status.ok, true);
  assert.ok(status.security.devices.some((device) => device.id === "device"));

  const providerResponse = await fetch(`http://127.0.0.1:${port}/api/provider-registry`, { headers });
  assert.equal(providerResponse.status, 200);
  assert.equal(providerResponse.headers.get("x-vibelink-control-plane"), "rust");
  const providerRegistry = await providerResponse.json();
  assert.equal(providerRegistry.version, 2);
  assert.equal(providerRegistry.defaultProvider, "codex");
  assert.deepEqual(providerRegistry.providers.map((provider) => provider.id), ["codex", "claude", "doubao", "zhipu"]);

  const doctorResponse = await fetch(`http://127.0.0.1:${port}/api/doctor`, { headers });
  assert.equal(doctorResponse.status, 200);
  assert.equal(doctorResponse.headers.get("x-vibelink-control-plane"), "rust");
  const doctor = await doctorResponse.json();
  assert.ok(Array.isArray(doctor.checks) && doctor.checks.length > 0);
  assert.match(doctor.generatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const devicesResponse = await fetch(`http://127.0.0.1:${port}/api/devices`, { headers });
  assert.equal(devicesResponse.status, 200);
  assert.equal(devicesResponse.headers.get("x-vibelink-control-plane"), "rust");
  const devices = await devicesResponse.json();
  assert.equal(devices.currentDeviceId, "device");
  assert.deepEqual(devices.items.map((device) => device.id), ["device"]);
  checkpoint("core-routes-complete");

  const settingsResponse = await fetch(`http://127.0.0.1:${port}/api/settings/export`, { headers });
  const settingsText = await settingsResponse.text();
  assert.equal(settingsResponse.status, 200, `${settingsText}\n${logs}`);
  assert.equal(settingsResponse.headers.get("x-vibelink-control-plane"), "rust");
  const settingsExport = JSON.parse(settingsText);
  assert.equal(settingsExport.kind, "vibelink.settings.export");
  assert.equal(settingsExport.settings.pairingToken, undefined);
  assert.deepEqual(settingsExport.settings.allowedRoots, [workspaceDir]);
  const auditResponse = await fetch(`http://127.0.0.1:${port}/api/audit-log?limit=20`, { headers });
  assert.equal(auditResponse.status, 200);
  assert.equal(auditResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.ok((await auditResponse.json()).items.some((item) => item.type === "settings.export"));

  const workspacesResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers });
  assert.equal(workspacesResponse.status, 200);
  assert.equal(workspacesResponse.headers.get("x-vibelink-control-plane"), "rust");
  const workspaces = await workspacesResponse.json();
  assert.deepEqual(workspaces.items.map((workspace) => workspace.id), ["workspace"]);

  const reviewCreateResponse = await fetch(`http://127.0.0.1:${port}/api/reviews`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "workspace", branch: "feature/rust-review", title: "Rust-only review" })
  });
  assert.equal(reviewCreateResponse.status, 201);
  assert.equal(reviewCreateResponse.headers.get("x-vibelink-control-plane"), "rust");
  const review = await reviewCreateResponse.json();
  assert.equal(review.source, "local");
  const reviewListResponse = await fetch(`http://127.0.0.1:${port}/api/reviews`, { headers });
  assert.equal(reviewListResponse.status, 200);
  assert.equal(reviewListResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.ok((await reviewListResponse.json()).items.some((item) => item.id === review.id));

  for (const [family, route] of [
    ["histories", "/api/histories"],
    ["search", "/api/search?q=rust-only&record=0"],
    ["tasks", "/api/tasks"]
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers });
    const body = await response.text();
    assert.equal(response.status, 200, `${family}: ${body}\n${logs}`);
    assert.equal(response.headers.get("x-vibelink-control-plane"), "rust", family);
    assert.ok(Array.isArray(JSON.parse(body).items), family);
  }
  for (const [family, route, collection] of [
    ["tool-runs", "/api/tool-runs", "items"],
    ["tool-events", "/api/tool-events", "items"],
    ["approvals", "/api/approvals", "approvals"]
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers });
    const body = await response.text();
    assert.equal(response.status, 200, `${family}: ${body}\n${logs}`);
    assert.equal(response.headers.get("x-vibelink-control-plane"), "rust", family);
    assert.ok(Array.isArray(JSON.parse(body)[collection]), family);
  }
  for (const [family, route, collection, kind] of [
    ["pairing", "/api/pairing-sessions", "items", "array"],
    ["thread-state", "/api/thread-state", "items", "object"]
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers });
    const body = await response.text();
    assert.equal(response.status, 200, `${family}: ${body}\n${logs}`);
    assert.equal(response.headers.get("x-vibelink-control-plane"), "rust", family);
    const value = JSON.parse(body)[collection];
    assert.ok(kind === "array" ? Array.isArray(value) : value && typeof value === "object" && !Array.isArray(value), family);
  }
  const eventsResponse = await fetch(`http://127.0.0.1:${port}/api/events/acks?streamId=task`, { headers });
  const eventsBody = await eventsResponse.text();
  assert.equal(eventsResponse.status, 200, `events: ${eventsBody}\n${logs}`);
  assert.equal(eventsResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.ok(Array.isArray(JSON.parse(eventsBody).items));
  const terminalResponse = await fetch(`http://127.0.0.1:${port}/api/terminal-sessions`, { headers });
  const terminalBody = await terminalResponse.text();
  assert.equal(terminalResponse.status, 200, `terminal-sessions: ${terminalBody}\n${logs}`);
  assert.equal(terminalResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.ok(Array.isArray(JSON.parse(terminalBody).items));
  const cloudflareResponse = await fetch(`http://127.0.0.1:${port}/api/cloudflare/guide`, { headers });
  const cloudflareGuide = await cloudflareResponse.json();
  assert.equal(cloudflareResponse.status, 200);
  assert.equal(cloudflareResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal(cloudflareGuide.host, "127.0.0.1");
  assert.equal(cloudflareGuide.publicHost, false);
  assert.ok(cloudflareGuide.steps.length > 0);
  const pushKeyResponse = await fetch(`http://127.0.0.1:${port}/api/push/public-key`, { headers });
  assert.equal(pushKeyResponse.status, 200);
  assert.equal(pushKeyResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal((await pushKeyResponse.json()).publicKey, "push-key");
  const pushListResponse = await fetch(`http://127.0.0.1:${port}/api/push/subscriptions`, { headers });
  assert.equal(pushListResponse.status, 200);
  assert.equal(pushListResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.deepEqual((await pushListResponse.json()).items, []);
  const pushRegisterResponse = await fetch(`http://127.0.0.1:${port}/api/push/subscriptions`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ subscription: { endpoint: "https://push.example/e2e", keys: { p256dh: "key" } } })
  });
  assert.equal(pushRegisterResponse.status, 201);
  assert.equal(pushRegisterResponse.headers.get("x-vibelink-control-plane"), "rust");
  const pushSubscription = await pushRegisterResponse.json();
  assert.equal(pushSubscription.ok, true);
  assert.equal(pushSubscription.subscription.kind, "web");
  const nativePushResponse = await fetch(`http://127.0.0.1:${port}/api/push/native-token`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ provider: "fcm", token: "native-token-e2e", platform: "android", appId: "app", installationId: "install" })
  });
  assert.equal(nativePushResponse.status, 201);
  assert.equal(nativePushResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal((await nativePushResponse.json()).subscription.kind, "native");
  const nativePushListResponse = await fetch(`http://127.0.0.1:${port}/api/push/subscriptions?kind=native`, { headers });
  assert.equal(nativePushListResponse.status, 200);
  assert.equal(nativePushListResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal((await nativePushListResponse.json()).items.length, 1);
  const pushDeleteResponse = await fetch(`http://127.0.0.1:${port}/api/push/subscriptions/${encodeURIComponent(pushSubscription.subscription.id)}`, {
    method: "DELETE",
    headers
  });
  assert.equal(pushDeleteResponse.status, 200);
  assert.equal(pushDeleteResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal((await pushDeleteResponse.json()).ok, true);

  const toolsResponse = await waitFor(`http://127.0.0.1:${port}/api/tool-registry`, { headers });
  assert.equal(toolsResponse.status, 200);
  assert.equal(toolsResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.ok((await toolsResponse.json()).items.some((item) => item.name === "mcp__memory__search"));

  const commandsResponse = await fetch(`http://127.0.0.1:${port}/api/command-registry?filter=e2e`, { headers });
  assert.equal(commandsResponse.status, 200);
  assert.equal(commandsResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal((await commandsResponse.json()).items[0].id, "skill:e2e");
  const artifactResponse = await fetch(`http://127.0.0.1:${port}/api/artifacts/${artifactId}`, { headers });
  assert.equal(artifactResponse.status, 200);
  assert.equal(artifactResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal((await artifactResponse.json()).artifact.id, artifactId);
  const attachmentResponse = await fetch(`http://127.0.0.1:${port}/api/attachments/${artifactId}`, { headers });
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal(await attachmentResponse.text(), "hello from rust artifact\n");
  const fileResponse = await fetch(`http://127.0.0.1:${port}/api/files?path=${encodeURIComponent(path.join(workspaceDir, "download.txt"))}`, { headers });
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal(await fileResponse.text(), "hello from rust file\n");
  const desktopResponse = await fetch(`http://127.0.0.1:${port}/api/desktop-remote/observations?after=0&limit=1`, { headers });
  assert.equal(desktopResponse.status, 200);
  assert.equal(desktopResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal((await desktopResponse.json()).items[0].desktop.ready, true);

  for (const [family, route, collection] of [
    ["agent-reach", "/api/agent-reach/status", "channels"],
    ["mcp", "/api/mcp/status", "servers"],
    ["live-calls", "/api/live-calls", "items"],
    ["browser-sessions", "/api/browser-sessions", "items"]
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers });
    const body = await response.text();
    assert.equal(response.status, 200, `${family}: ${body}\n${logs}`);
    assert.equal(response.headers.get("x-vibelink-control-plane"), "rust", family);
    assert.ok(Array.isArray(JSON.parse(body)[collection]), family);
  }

  const liveCreateResponse = await fetch(`http://127.0.0.1:${port}/api/live-calls`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ title: "Rust audio E2E", source: "android", asrProvider: "mock" })
  });
  const liveCreateBody = await liveCreateResponse.text();
  assert.equal(liveCreateResponse.status, 201, liveCreateBody);
  assert.equal(liveCreateResponse.headers.get("x-vibelink-control-plane"), "rust");
  const liveSession = JSON.parse(liveCreateBody).session;
  const audioMessages = await new Promise((resolve, reject) => {
    const received = [];
    let settled = false;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live-calls/${encodeURIComponent(liveSession.id)}/audio`, {
      headers: { Authorization: "Bearer device-token" }
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      if (error) reject(error);
      else resolve(received);
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Rust Live Call WebSocket timed out: ${JSON.stringify(received)}\n${logs}`));
    }, 15_000);
    socket.on("open", () => socket.send(JSON.stringify({ sampleRate: 16000, channels: 1, encoding: "pcm16le", device: "remote" })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      if (message.type === "ready") {
        for (let index = 0; index < 20; index += 1) socket.send(Buffer.alloc(320, index));
      } else if (message.type === "ack") {
        socket.send(JSON.stringify({ type: "flush" }));
      } else if (message.type === "flushed") {
        socket.send(JSON.stringify({ type: "stop" }));
      } else if (message.type === "stopped") {
        finish();
      }
    });
    socket.on("error", finish);
    socket.on("close", () => finish());
  });
  assert.ok(audioMessages.some((message) => message.type === "ready"));
  assert.ok(audioMessages.some((message) => message.type === "ack" && message.seq === 20 && message.bytes === 6400));
  assert.ok(audioMessages.some((message) => message.type === "stopped"));
  const liveEventsResponse = await fetch(`http://127.0.0.1:${port}/api/live-calls/${encodeURIComponent(liveSession.id)}/events/catch-up?after=0&limit=100`, { headers });
  assert.equal(liveEventsResponse.status, 200);
  const liveEvents = (await liveEventsResponse.json()).items;
  assert.ok(liveEvents.some((event) => event.type === "live_call.audio_stream.connected"));
  assert.ok(liveEvents.some((event) => event.type === "live_call.audio_stream.disconnected"));
  assert.ok(liveEvents.every((event, index) => index === 0 || event.cursor > liveEvents[index - 1].cursor));
  const pcmFiles = fs.readdirSync(path.join(directory, "live-call", "pcm")).filter((name) => name.endsWith(".pcm"));
  assert.equal(pcmFiles.length, 1);
  assert.equal(fs.statSync(path.join(directory, "live-call", "pcm", pcmFiles[0])).size, 6400);
  checkpoint("live-call-complete");

  for (const [family, route] of [
    ["doubao", "/api/doubao/status"],
    ["codex-desktop", "/api/codex-desktop/status"],
    ["desktop-remote-control", "/api/desktop-remote/status"]
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers });
    const body = await response.text();
    assert.equal(response.status, 200, `${family}: ${body}\n${logs}`);
    assert.equal(response.headers.get("x-vibelink-control-plane"), "rust", family);
    assert.equal(JSON.parse(body).owner, "rust", family);
  }

  const browserCreateResponse = await fetch(`http://127.0.0.1:${port}/api/browser-sessions`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ maxTraceEvents: 10 })
  });
  assert.equal(browserCreateResponse.status, 201);
  assert.equal(browserCreateResponse.headers.get("x-vibelink-control-plane"), "rust");
  const browserSession = await browserCreateResponse.json();
  assert.equal(browserSession.session.owner, "rust");
  const browserTraceResponse = await fetch(`http://127.0.0.1:${port}/api/browser-sessions/${browserSession.session.id}/trace?after=0&limit=10`, { headers });
  assert.equal(browserTraceResponse.status, 200);
  assert.equal(browserTraceResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal((await browserTraceResponse.json()).hasMore, false);
  checkpoint("browser-session-complete");

  for (const [family, route] of [
    ["capabilities", "/api/capabilities/automations"],
    ["automations", "/api/automations"],
    ["subagents", "/api/subagents"],
    ["browser-fetch", "/api/browser/fetch"]
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: family === "capabilities" ? "GET" : "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: family === "capabilities" ? undefined : JSON.stringify({
        url: `http://127.0.0.1:${browserFixturePort}/fixture`,
        prompt: "rust-only"
      })
    });
    const body = await response.text();
    assert.ok(response.status === 200 || response.status === 201, `${family}: ${body}\n${logs}`);
    assert.equal(response.headers.get("x-vibelink-control-plane"), "rust", family);
    checkpoint(`family-${family}-complete`);
  }
  checkpoint("process-tree-check-start");
  assert.deepEqual(descendantNodeProcesses(child.pid), []);
  checkpoint("process-tree-check-complete");

  if (process.env.VIBELINK_RUST_ONLY_E2E_SKIP_ANDROID === "1") {
    checkpoint("test-return-web-only");
    return;
  }

  const gradleCommand = process.platform === "win32" ? "cmd.exe" : "./gradlew";
  const gradleArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "gradlew.bat", "--no-daemon", "--max-workers=1", ":app:testDebugUnitTest", "--tests", "com.vibelink.app.network.ApiClientRustOnlyDiscoveryE2eTest"]
    : ["--no-daemon", "--max-workers=1", ":app:testDebugUnitTest", "--tests", "com.vibelink.app.network.ApiClientRustOnlyDiscoveryE2eTest"];
  const configuredGradleTimeoutMs = Number(process.env.VIBELINK_RUST_ONLY_E2E_GRADLE_TIMEOUT_MS || 600_000);
  const gradleTimeoutMs = Number.isFinite(configuredGradleTimeoutMs) && configuredGradleTimeoutMs >= 180_000
    ? configuredGradleTimeoutMs
    : 600_000;
  const gradle = spawnSync(gradleCommand, gradleArgs, {
    cwd: path.join(root, "apps", "android"),
    env: {
      ...process.env,
      VIBELINK_RUST_ONLY_E2E_URL: `http://127.0.0.1:${port}`,
      VIBELINK_RUST_ONLY_E2E_TOKEN: "device-token",
      VIBELINK_RUST_ONLY_E2E_FILE: path.join(workspaceDir, "download.txt"),
      VIBELINK_RUST_ONLY_E2E_BROWSER_URL: `http://127.0.0.1:${browserFixturePort}/android-fixture`
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: gradleTimeoutMs
  });
  assert.equal(gradle.status, 0, gradle.error?.message || gradle.stderr || gradle.stdout);
});
