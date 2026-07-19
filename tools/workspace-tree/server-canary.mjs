#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function numberArg(name, fallback) {
  const value = Number(stringArg(name, fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function defaultRustCommand() {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["release", "debug"]) {
    const command = path.join(rootDir, "apps", "windows", "target", profile, binary);
    if (fs.existsSync(command)) return command;
  }
  return path.join(rootDir, "apps", "windows", "target", "release", binary);
}

function rustArgs() {
  const raw = stringArg("--args-json", "[]");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("--args-json must be a JSON array of strings");
  }
  return parsed;
}

function createTempRoot() {
  const requested = stringArg("--tmp-dir", "");
  if (requested) {
    fs.mkdirSync(requested, { recursive: true });
    return fs.mkdtempSync(path.join(path.resolve(requested), "vibelink-workspace-server-canary-"));
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-server-canary-"));
}

function reserveAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? Number(address.port) : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error("could not reserve a local canary port"));
      });
    });
  });
}

function writeSettings(dataDir, { port, pairingToken }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const settings = {
    host: "127.0.0.1",
    port,
    pairingToken,
    defaultCwd: rootDir,
    allowedRoots: [rootDir],
    security: {
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: false,
      requireTrustedWorkspace: false,
      requireDangerousCommandApproval: false,
      trustedWorkspaces: [rootDir]
    },
    toolEvents: { retentionDays: 1, keepLatest: 1000, autoPrune: false, autoPruneIntervalMinutes: 360 },
    codebaseMemory: { autoMcp: false },
    mcp: { probeTimeoutMs: 10000, servers: [] }
  };
  fs.writeFileSync(path.join(dataDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function startServer({ dataDir, port, pairingToken, command, args }) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      VIBELINK_DATA_DIR: dataDir,
      VIBELINK_SEARCH_INDEX_STARTUP: "0",
      VIBELINK_PROVIDER_CACHE_STARTUP: "0",
      MOBILE_AGENT_HOST: "127.0.0.1",
      MOBILE_AGENT_PORT: String(port),
      MOBILE_AGENT_TOKEN: pairingToken,
      VIBELINK_RUST_WORKSPACE_TREE: "auto",
      VIBELINK_RUST_WORKSPACE_TREE_SESSION: "auto",
      VIBELINK_RUST_BIN: command,
      VIBELINK_RUST_BIN_ARGS_JSON: JSON.stringify(args)
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl, getLogs, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 401 || response.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms\n${getLogs().slice(-4000)}`);
}

async function requestJson(baseUrl, pathName, { method = "GET", token = "", body = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${pathName} failed with ${response.status}: ${text}`);
  return payload;
}

async function login(baseUrl, pairingToken) {
  const result = await requestJson(baseUrl, "/api/login", {
    method: "POST",
    body: { pairingToken, deviceLabel: "workspace-server-canary" }
  });
  if (!result?.token) throw new Error("login did not return a device token");
  return result.token;
}

async function stopServer(server, timeoutMs = 10000) {
  if (server.child.exitCode !== null) return { code: server.child.exitCode, signal: null };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (server.child.exitCode === null) server.child.kill();
      resolve({ code: server.child.exitCode, signal: "timeout" });
    }, timeoutMs);
    server.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    server.child.kill("SIGTERM");
  });
}

function delta(after, before, key) {
  return Number(after?.[key] || 0) - Number(before?.[key] || 0);
}

function roundMs(value) {
  return Number(Number(value || 0).toFixed(1));
}

function evaluate({ parity, runtime, maxRouteMs, shutdown }) {
  const checks = [
    { name: "tree repeat parity", pass: parity.treeRepeated, detail: parity.treeRepeated ? "exact response match" : "responses differ" },
    { name: "context repeat parity", pass: parity.contextRepeated, detail: parity.contextRepeated ? "exact response match" : "responses differ" },
    { name: "Rust auto routing", pass: runtime.mode === "auto" && runtime.available && runtime.hits === 3 && runtime.cacheMisses === 3, detail: `mode=${runtime.mode}, available=${runtime.available}, hits=${runtime.hits}, misses=${runtime.cacheMisses}` },
    { name: "warm cache reuse", pass: runtime.cacheHits === 3, detail: `${runtime.cacheHits} cache hits` },
    { name: "route fallback rate", pass: runtime.failures === 0 && runtime.fallbacks === 0, detail: `${runtime.failures} failures, ${runtime.fallbacks} fallbacks` },
    { name: "single persistent sidecar", pass: runtime.session.starts === 1 && runtime.session.ready, detail: `${runtime.session.starts} starts, ready=${runtime.session.ready}` },
    { name: "session fallback rate", pass: runtime.session.failures === 0 && runtime.session.fallbacks === 0, detail: `${runtime.session.failures} failures, ${runtime.session.fallbacks} fallbacks` },
    { name: "session pending drain", pass: runtime.session.pending === 0 && runtime.session.backpressureRejects === 0, detail: `${runtime.session.pending} pending, ${runtime.session.backpressureRejects} rejects` },
    { name: "route liveness", pass: runtime.maxRouteMs <= maxRouteMs, detail: `${runtime.maxRouteMs}ms max; limit ${maxRouteMs}ms` },
    { name: "controlled server termination", pass: shutdown.code === 0 || shutdown.signal === "SIGTERM", detail: `code=${shutdown.code}, signal=${shutdown.signal || "none"}` }
  ];
  return { passed: checks.every((check) => check.pass), checks };
}

function printSummary(result) {
  console.log("Workspace-tree Rust server-route canary");
  console.log(`- workspace: ${result.workspace.title}`);
  console.log(`- context paths: ${result.workload.contextPaths.join(", ")}`);
  console.log(`- max route: ${result.runtime.maxRouteMs}ms`);
  for (const check of result.evaluation.checks) console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  console.log(`Result: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

async function timed(callback) {
  const startedAt = performance.now();
  const value = await callback();
  return { value, durationMs: performance.now() - startedAt };
}

async function main() {
  const command = path.resolve(stringArg("--command", defaultRustCommand()));
  const args = rustArgs();
  const maxRouteMs = numberArg("--max-route-ms", 2000);
  if (!fs.existsSync(command)) throw new Error(`Rust workspace-tree command is missing: ${command}`);
  const port = process.argv.includes("--port") ? numberArg("--port", 0) : await reserveAvailablePort();
  if (!port) throw new Error("--port must be a positive integer");

  const tempRoot = createTempRoot();
  const dataDir = path.join(tempRoot, "data");
  const pairingToken = crypto.randomBytes(24).toString("hex");
  writeSettings(dataDir, { port, pairingToken });
  const server = startServer({ dataDir, port, pairingToken, command, args });
  const baseUrl = `http://127.0.0.1:${port}`;
  let shutdown = null;

  try {
    await waitForServer(baseUrl, () => server.logs.join(""));
    const token = await login(baseUrl, pairingToken);
    const beforeStatus = await requestJson(baseUrl, "/api/status", { token });
    const workspace = (beforeStatus.workspaces || []).find((item) => path.resolve(item.path) === rootDir) || beforeStatus.workspaces?.[0];
    if (!workspace?.id) throw new Error("workspace server canary could not find the checkout workspace");
    const workspaceId = encodeURIComponent(workspace.id);
    const contextPaths = ["src", "docs"];
    const routes = [];
    const firstTree = await timed(() => requestJson(baseUrl, `/api/workspaces/${workspaceId}/tree`, { token }));
    routes.push(firstTree.durationMs);
    const firstContext = await timed(() => requestJson(baseUrl, `/api/workspaces/${workspaceId}/context`, { method: "POST", token, body: { paths: contextPaths } }));
    routes.push(firstContext.durationMs);
    const secondTree = await timed(() => requestJson(baseUrl, `/api/workspaces/${workspaceId}/tree`, { token }));
    routes.push(secondTree.durationMs);
    const secondContext = await timed(() => requestJson(baseUrl, `/api/workspaces/${workspaceId}/context`, { method: "POST", token, body: { paths: contextPaths } }));
    routes.push(secondContext.durationMs);
    const afterStatus = await requestJson(baseUrl, "/api/status", { token });
    const before = beforeStatus.workspaceRuntime?.rustWorkspaceTree || {};
    const after = afterStatus.workspaceRuntime?.rustWorkspaceTree || {};
    const client = after.session?.client || {};
    const runtime = {
      mode: after.mode || "",
      available: after.available === true,
      hits: delta(after, before, "hits"),
      cacheMisses: delta(after, before, "cacheMisses"),
      cacheHits: delta(after, before, "cacheHits"),
      failures: delta(after, before, "failures"),
      fallbacks: delta(after, before, "fallbacks"),
      maxRouteMs: roundMs(Math.max(...routes)),
      session: {
        starts: delta(after.session, before.session, "starts"),
        ready: after.session?.ready === true,
        failures: delta(after.session, before.session, "failures"),
        fallbacks: delta(after.session, before.session, "fallbacks"),
        pending: Number(client.pending || 0),
        backpressureRejects: Number(client.backpressureRejects || 0)
      }
    };
    const treeResult = (value) => ({ ok: value.ok, dir: value.dir, items: value.items });
    const contextResult = (value) => ({ ok: value.ok, items: value.items, errors: value.errors, prompt: value.prompt });
    const parity = {
      treeRepeated: isDeepStrictEqual(treeResult(firstTree.value), treeResult(secondTree.value)),
      contextRepeated: isDeepStrictEqual(contextResult(firstContext.value), contextResult(secondContext.value))
    };
    shutdown = await stopServer(server);
    const evaluation = evaluate({ parity, runtime, maxRouteMs, shutdown });
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: { route: "authenticated-http-api", server: "src/server.js", sidecarMode: "auto" },
      workspace: { id: workspace.id, title: workspace.title || "" },
      workload: { treeRoutes: 2, contextRoutes: 2, contextPaths, maxRouteMs },
      parity,
      runtime,
      evaluation
    };

    const output = stringArg("--output", "");
    if (output) {
      const outputPath = path.resolve(output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    if (flag("--json")) console.log(JSON.stringify(result, null, 2));
    else printSummary(result);
    process.exitCode = evaluation.passed ? 0 : 1;
  } finally {
    if (!shutdown) await stopServer(server).catch(() => {});
    if (flag("--delete-temp")) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
