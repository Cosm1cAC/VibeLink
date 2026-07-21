#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function numberArg(name, fallback) {
  const value = Number(stringArg(name, fallback));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function jsonArg(name, fallback) {
  const raw = stringArg(name, "");
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

function repeatedArgs(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1] !== undefined) values.push(String(process.argv[index + 1]));
  }
  return values;
}

function defaultRustCommand() {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["release", "debug"]) {
    const command = path.join(rootDir, "apps", "windows", "target", profile, binary);
    if (fs.existsSync(command)) return command;
  }
  return path.join(rootDir, "apps", "windows", "target", "release", binary);
}

function createTempRoot() {
  const requested = stringArg("--tmp-dir", "");
  if (requested) {
    fs.mkdirSync(requested, { recursive: true });
    return fs.mkdtempSync(path.join(path.resolve(requested), "vibelink-mcp-server-canary-"));
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-mcp-server-canary-"));
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

function writeSettings(dataDir, { port, pairingToken, server }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const settings = {
    host: "127.0.0.1",
    port,
    pairingToken,
    defaultCwd: rootDir,
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
    mcp: {
      probeTimeoutMs: server.timeoutMs,
      callTimeoutMs: server.timeoutMs,
      servers: [server.settings]
    }
  };
  fs.writeFileSync(path.join(dataDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function startServer({ dataDir, port, pairingToken, rustCommand }) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      VIBELINK_DATA_DIR: dataDir,
      MOBILE_AGENT_HOST: "127.0.0.1",
      MOBILE_AGENT_PORT: String(port),
      MOBILE_AGENT_TOKEN: pairingToken,
      VIBELINK_SEARCH_INDEX_STARTUP: "0",
      VIBELINK_PROVIDER_CACHE_STARTUP: "0",
      VIBELINK_MCP_RUST_SIDECAR: "auto",
      VIBELINK_MCP_RUST_SIDECAR_COMMAND: rustCommand
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

async function requestJson(baseUrl, pathName, { method = "GET", token = "", body = null, timeoutMs = 60000 } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${pathName} failed with ${response.status}: ${text}`);
  return payload;
}

async function login(baseUrl, pairingToken, timeoutMs) {
  const result = await requestJson(baseUrl, "/api/login", {
    method: "POST",
    body: { pairingToken, deviceLabel: "mcp-server-canary" },
    timeoutMs
  });
  if (!result?.token) throw new Error("login did not return a device token");
  return result.token;
}

function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function methodCounts(lines) {
  return Object.fromEntries([...new Set(lines)].sort().map((method) => [method, lines.filter((item) => item === method).length]));
}

function artifactRustStats(stats = {}) {
  const client = stats.client || {};
  return {
    enabled: Boolean(stats.enabled),
    mode: stats.mode || "",
    auto: Boolean(stats.auto),
    available: Boolean(stats.available),
    active: Boolean(stats.active),
    ready: Boolean(stats.ready),
    failed: Boolean(stats.failed),
    starts: Number(stats.starts || 0),
    failures: Number(stats.failures || 0),
    fallbacks: Number(stats.fallbacks || 0),
    hasLastError: Boolean(stats.lastError),
    client: {
      pending: Number(client.pending || 0),
      maxPendingRequests: Number(client.maxPendingRequests || 0),
      maxPendingObserved: Number(client.maxPendingObserved || 0),
      requests: Number(client.requests || 0),
      responses: Number(client.responses || 0),
      failures: Number(client.failures || 0),
      timeouts: Number(client.timeouts || 0),
      backpressureRejects: Number(client.backpressureRejects || 0),
      terminated: Boolean(client.terminated)
    }
  };
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

function evaluate({ probe, calls, status, serverSpawns, methods, shutdown, instrumented, toolName }, expectedCalls) {
  const rust = status.rustSidecar || {};
  const client = rust.client || {};
  const probeResult = probe.results?.[0] || {};
  const checks = [
    { name: "HTTP probe", pass: probe.ok === true && probeResult.status === "connected" && Number(probeResult.toolCount || 0) > 0, detail: `ok=${probe.ok}, status=${probeResult.status || "missing"}, tools=${probeResult.toolCount || 0}` },
    { name: "selected tool advertised", pass: (probeResult.tools || []).some((tool) => tool.name === toolName), detail: `${toolName} ${(probeResult.tools || []).some((tool) => tool.name === toolName) ? "available" : "missing"}` },
    { name: "HTTP tool calls", pass: calls.length === expectedCalls && calls.every((call) => call.ok && call.contentBlocks > 0 && call.toolRunId), detail: `${calls.filter((call) => call.ok).length}/${expectedCalls} completed` },
    { name: "Rust auto readiness", pass: rust.mode === "auto" && rust.available && rust.ready && !rust.failed && !rust.lastError, detail: `mode=${rust.mode}, available=${rust.available}, ready=${rust.ready}, failed=${rust.failed}` },
    { name: "single Rust sidecar", pass: Number(rust.starts || 0) === 1, detail: `${rust.starts || 0} starts` },
    { name: "fallback rate", pass: Number(rust.failures || 0) === 0 && Number(rust.fallbacks || 0) === 0, detail: `${rust.failures || 0} failures, ${rust.fallbacks || 0} fallbacks` },
    ...(instrumented ? [
      { name: "single MCP server", pass: serverSpawns === 1, detail: `${serverSpawns} server spawns` },
      { name: "session reuse", pass: methods.initialize === 1 && methods["tools/list"] === 1 && methods["tools/call"] === expectedCalls, detail: JSON.stringify(methods) },
      { name: "fixture response parity", pass: calls.every((call) => call.echoedIndex === call.index), detail: `${calls.filter((call) => call.echoedIndex === call.index).length}/${expectedCalls} echoed indexes` }
    ] : []),
    { name: "pending drain", pass: Number(client.pending || 0) === 0, detail: `${client.pending || 0} pending` },
    { name: "normal-load backpressure", pass: Number(client.backpressureRejects || 0) === 0, detail: `${client.backpressureRejects || 0} rejects` },
    { name: "controlled server termination", pass: shutdown.code === 0 || shutdown.signal === "SIGTERM", detail: `code=${shutdown.code}, signal=${shutdown.signal || "none"}` }
  ];
  return { passed: checks.every((check) => check.pass), checks };
}

function printSummary(result) {
  console.log("MCP Rust server-route canary");
  console.log(`- workload: ${result.workload.probes} probe + ${result.workload.calls} calls`);
  console.log(`- MCP server spawns: ${result.runtime.instrumented ? result.runtime.serverSpawns : "external implementation"}`);
  console.log(`- Rust sidecar starts: ${result.runtime.rustSidecar.starts || 0}`);
  for (const check of result.evaluation.checks) {
    console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`Result: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

async function main() {
  const calls = numberArg("--calls", 6);
  const timeoutMs = numberArg("--timeout-ms", 120000);
  const serverId = stringArg("--server", "server-canary");
  const serverCommand = stringArg("--server-command", "");
  const toolName = stringArg("--tool", "echo");
  const repeatedServerArgs = repeatedArgs("--server-arg");
  const serverArgs = repeatedServerArgs.length ? repeatedServerArgs : jsonArg("--server-args-json", []);
  const hasExplicitArguments = process.argv.includes("--arguments-json");
  const toolArguments = hasExplicitArguments ? jsonArg("--arguments-json", {}) : null;
  if (!Array.isArray(serverArgs) || serverArgs.some((item) => typeof item !== "string")) throw new Error("--server-args-json must be a JSON array of strings.");
  if (toolArguments !== null && (!toolArguments || typeof toolArguments !== "object" || Array.isArray(toolArguments))) throw new Error("--arguments-json must be a JSON object.");
  const rustCommand = path.resolve(stringArg("--command", defaultRustCommand()));
  if (!fs.existsSync(rustCommand)) throw new Error(`Rust MCP sidecar command is missing: ${rustCommand}`);
  const port = process.argv.includes("--port") ? numberArg("--port", 0) : await reserveAvailablePort();
  if (!port) throw new Error("--port must be a positive integer");

  const tempRoot = createTempRoot();
  const dataDir = path.join(tempRoot, "data");
  const spawnLog = path.join(tempRoot, "server-spawns.log");
  const methodLog = path.join(tempRoot, "server-methods.log");
  const instrumented = !serverCommand;
  const settings = {
    id: serverId,
    name: serverId,
    type: "stdio",
    enabled: true,
    command: serverCommand || process.execPath,
    args: serverCommand ? serverArgs : [path.join(rootDir, "test", "fixtures", "fake-mcp-server.js")]
  };
  if (instrumented) settings.env = { FAKE_MCP_SPAWN_LOG: spawnLog, FAKE_MCP_METHOD_LOG: methodLog };
  const pairingToken = crypto.randomBytes(24).toString("hex");
  writeSettings(dataDir, { port, pairingToken, server: { settings, timeoutMs } });
  const server = startServer({ dataDir, port, pairingToken, rustCommand });
  const baseUrl = `http://127.0.0.1:${port}`;
  let shutdown = null;

  try {
    await waitForServer(baseUrl, () => server.logs.join(""));
    const token = await login(baseUrl, pairingToken, timeoutMs);
    const probe = await requestJson(baseUrl, "/api/mcp/probe", {
      method: "POST",
      token,
      body: { serverId, timeoutMs },
      timeoutMs
    });
    const callResults = [];
    for (let index = 0; index < calls; index += 1) {
      const startedAt = performance.now();
      const argumentsValue = toolArguments === null ? { index } : toolArguments;
      const response = await requestJson(baseUrl, "/api/mcp/call", {
        method: "POST",
        token,
        body: { serverId, toolName, arguments: argumentsValue, timeoutMs },
        timeoutMs
      });
      let echoed = null;
      if (instrumented) echoed = JSON.parse(response.content?.[0]?.text || "null");
      callResults.push({ index, ok: response.ok === true, contentBlocks: response.content?.length || 0, echoedIndex: echoed?.arguments?.index, toolRunId: response.toolRunId || "", durationMs: Number((performance.now() - startedAt).toFixed(1)) });
    }
    const status = await requestJson(baseUrl, "/api/mcp/status", { token });
    shutdown = await stopServer(server);
    const methods = instrumented ? methodCounts(readLines(methodLog)) : {};
    const serverSpawns = instrumented ? readLines(spawnLog).length : null;
    const evaluation = evaluate({ probe, calls: callResults, status, serverSpawns, methods, shutdown, instrumented, toolName }, calls);
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: { route: "authenticated-http-api", server: "src/server.js", sidecarMode: "auto" },
      workload: { server: serverId, tool: toolName, probes: 1, calls, argumentKeys: Object.keys(toolArguments || { index: 0 }).sort() },
      probe: { ok: probe.ok === true, status: probe.results?.[0]?.status || "", toolCount: probe.results?.[0]?.toolCount || 0 },
      calls: callResults.map(({ index, ok, contentBlocks, toolRunId, durationMs }) => ({ index, ok, contentBlocks, toolRunId, durationMs })),
      runtime: { instrumented, serverSpawns, methods, rustSidecar: artifactRustStats(status.rustSidecar), shutdown },
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
