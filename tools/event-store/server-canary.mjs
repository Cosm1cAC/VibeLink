#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveEventStoreRustCommand } from "./rustCommand.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

function numberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return String(process.argv[index + 1] || fallback);
}

function flag(name) {
  return process.argv.includes(name);
}

function nowIso() {
  return new Date().toISOString();
}

function createTempRoot() {
  const requested = stringArg("--tmp-dir", "");
  if (requested) {
    fs.mkdirSync(requested, { recursive: true });
    return fs.mkdtempSync(path.join(path.resolve(requested), "vibelink-event-store-server-canary-"));
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-event-store-server-canary-"));
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

function writeSettings(dataDir, { port, token }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const settings = {
    host: "127.0.0.1",
    port,
    pairingToken: token,
    defaultCwd: rootDir,
    security: {
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: false,
      requireTrustedWorkspace: false,
      requireDangerousCommandApproval: false,
      trustedWorkspaces: [rootDir]
    },
    toolEvents: {
      retentionDays: 30,
      keepLatest: 5000,
      autoPrune: false,
      autoPruneIntervalMinutes: 360
    },
    mcp: {
      probeTimeoutMs: 10000,
      servers: []
    }
  };
  fs.writeFileSync(path.join(dataDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function startServer({ dataDir, port, token, command }) {
  const env = {
    ...process.env,
    VIBELINK_DATA_DIR: dataDir,
    MOBILE_AGENT_HOST: "127.0.0.1",
    MOBILE_AGENT_PORT: String(port),
    MOBILE_AGENT_TOKEN: token,
    VIBELINK_EVENT_STORE_RUST_SIDECAR: "auto",
    VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND: command,
    VIBELINK_EVENT_STORE_BATCH_APPEND: "1",
    VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND: "1",
    VIBELINK_EVENT_STORE_BATCH_TASK_APPEND: "1",
    VIBELINK_EVENT_STORE_BATCH_DELAY_MS: "10",
    VIBELINK_EVENT_STORE_BATCH_MAX_SIZE: "200"
  };
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: rootDir,
    env,
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
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`${method} ${pathName} failed with ${response.status}: ${text}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function login(baseUrl, pairingToken) {
  const result = await requestJson(baseUrl, "/api/login", {
    method: "POST",
    body: {
      pairingToken,
      deviceLabel: "event-store-server-canary"
    }
  });
  if (!result?.token) throw new Error("login did not return a device token");
  return result.token;
}

async function waitForStats(baseUrl, token, predicate, timeoutMs = 30000) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await requestJson(baseUrl, "/api/tool-events/stats", { token });
    if (predicate(latest)) return latest;
    await sleep(250);
  }
  throw new Error(`stats did not reach expected state within ${timeoutMs}ms\n${JSON.stringify(latest?.eventStore || latest, null, 2)}`);
}

function metric(stats, method) {
  return stats?.eventStore?.metrics?.methods?.[method] || {
    count: 0,
    failures: 0,
    fallbacks: 0,
    avgDurationMs: 0,
    modeCounts: {}
  };
}

export function metricDelta(baseline, stats, method) {
  const before = metric(baseline, method);
  const after = metric(stats, method);
  const count = Math.max(0, Number(after.count || 0) - Number(before.count || 0));
  const totalDurationMs = Math.max(
    0,
    Number(after.count || 0) * Number(after.avgDurationMs || 0) -
      Number(before.count || 0) * Number(before.avgDurationMs || 0)
  );
  const modes = new Set([
    ...Object.keys(before.modeCounts || {}),
    ...Object.keys(after.modeCounts || {})
  ]);
  const modeCounts = Object.fromEntries(
    [...modes].map((mode) => [
      mode,
      Math.max(0, Number(after.modeCounts?.[mode] || 0) - Number(before.modeCounts?.[mode] || 0))
    ])
  );
  return {
    count,
    failures: Math.max(0, Number(after.failures || 0) - Number(before.failures || 0)),
    fallbacks: Math.max(0, Number(after.fallbacks || 0) - Number(before.fallbacks || 0)),
    avgDurationMs: count > 0 ? Math.round((totalDurationMs / count) * 10) / 10 : 0,
    modeCounts
  };
}

export function evaluate(stats, baseline, { maxAppendAvgMs, functionalOnly = false }) {
  const eventStore = stats.eventStore || {};
  const rust = eventStore.rustSidecar || {};
  const checks = [];
  checks.push({
    name: "rust readiness",
    pass: rust.enabled === true && rust.available === true && rust.ready === true && rust.failed === false,
    detail: `enabled=${Boolean(rust.enabled)} available=${Boolean(rust.available)} ready=${Boolean(rust.ready)} failed=${Boolean(rust.failed)}`
  });
  checks.push({
    name: "store mode",
    pass: stats.storeMode === "rust-sidecar" && eventStore.mode === "rust-sidecar",
    detail: `storeMode=${stats.storeMode}, runtime=${eventStore.mode}`
  });
  checks.push({
    name: "fallbacks",
    pass: Number(eventStore.metrics?.fallbacks || 0) === 0 && Number(rust.fallbacks || 0) === 0,
    detail: `metrics=${eventStore.metrics?.fallbacks || 0}, rust=${rust.fallbacks || 0}`
  });
  checks.push({
    name: "failures",
    pass: Number(eventStore.metrics?.failures || 0) === 0 && Number(rust.failures || 0) === 0,
    detail: `metrics=${eventStore.metrics?.failures || 0}, rust=${rust.failures || 0}`
  });

  for (const method of ["insertToolEvents", "insertLiveCallEvents"]) {
    const item = metricDelta(baseline, stats, method);
    checks.push({
      name: `${method} rust routing`,
      pass: Number(item.modeCounts?.["rust-sidecar"] || 0) > 0,
      detail: `${item.modeCounts?.["rust-sidecar"] || 0} rust-sidecar calls`
    });
    if (!functionalOnly) {
      checks.push({
        name: `${method} average latency`,
        pass: Number(item.avgDurationMs || 0) <= maxAppendAvgMs,
        detail: `${item.avgDurationMs || 0}ms average; limit ${maxAppendAvgMs}ms`
      });
    }
    checks.push({
      name: `${method} method health`,
      pass: Number(item.failures || 0) === 0 && Number(item.fallbacks || 0) === 0,
      detail: `${item.failures || 0} failures, ${item.fallbacks || 0} fallbacks`
    });
  }

  checks.push({
    name: "sync stalls",
    pass: Number(eventStore.metrics?.stalls?.count || 0) - Number(baseline?.eventStore?.metrics?.stalls?.count || 0) === 0,
    detail: `${Math.max(0, Number(eventStore.metrics?.stalls?.count || 0) - Number(baseline?.eventStore?.metrics?.stalls?.count || 0))} sync stalls`
  });
  checks.push({
    name: "pending drain",
    pass: Number(rust.client?.pending || 0) === 0,
    detail: `${rust.client?.pending || 0} pending requests`
  });
  checks.push({
    name: "backpressure",
    pass: Number(rust.client?.backpressureRejects || 0) === 0,
    detail: `${rust.client?.backpressureRejects || 0} backpressure rejects`
  });
  if (functionalOnly) {
    checks.push({ name: "functional-only mode", pass: true, detail: "release performance average-latency checks skipped for debug functional contract" });
  }
  return {
    passed: checks.every((check) => check.pass),
    checks
  };
}

function printSummary(result) {
  console.log("Event-store Rust sidecar server canary");
  console.log(`- url: ${result.baseUrl}`);
  console.log(`- data dir: ${result.dataDir}`);
  console.log(`- workspace: ${result.workspaceId}`);
  console.log(`- live call: ${result.liveCallId}`);
  console.log(`- tool run: ${result.commandResult.toolRunId || ""}`);
  console.log(`- mode: ${result.stats.storeMode}`);
  console.log("\nRuntime append metrics:");
  for (const method of ["insertToolEvents", "insertLiveCallEvents"]) {
    const item = metricDelta(result.baselineStats, result.stats, method);
    console.log(`- ${method}: count ${item.count || 0}, avg ${item.avgDurationMs || 0}ms, modes ${JSON.stringify(item.modeCounts || {})}`);
  }
  console.log("\nChecks:");
  for (const check of result.evaluation.checks) {
    console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`\nResult: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

async function startTerminalSession(baseUrl, token, workspaceId) {
  const terminal = await requestJson(baseUrl, `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal-session`, {
    method: "POST",
    token,
    body: { mode: "spawn", cols: 100, rows: 30 }
  });
  if (!terminal.ok || !terminal.toolRunId) {
    throw new Error(`terminal session failed: ${JSON.stringify(terminal)}`);
  }
  return terminal.toolRunId;
}

async function stopTerminalSession(baseUrl, token, toolRunId, reason) {
  await requestJson(baseUrl, `/api/tool-runs/${encodeURIComponent(toolRunId)}/stop`, {
    method: "POST",
    token,
    body: { reason }
  });
}

async function main() {
  const port = process.argv.includes("--port") ? numberArg("--port", 0) : await reserveAvailablePort();
  if (!port) throw new Error("--port must be a positive integer");
  const liveEvents = numberArg("--live-events", 40);
  const commandLines = numberArg("--command-lines", 80);
  const maxAppendAvgMs = numberArg("--max-append-avg-ms", 500);
  const functionalOnly = flag("--functional-only");
  const resolvedCommand = resolveEventStoreRustCommand({
    rootDir,
    explicitCommand: stringArg("--command", ""),
    envCommand: process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND || "",
    performanceGate: !functionalOnly
  });
  const command = resolvedCommand.command;
  const pairingToken = stringArg("--token", "event-store-canary-token");

  const dataDir = createTempRoot();
  writeSettings(dataDir, { port, token: pairingToken });
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer({ dataDir, port, token: pairingToken, command });

  try {
    await waitForServer(baseUrl, () => server.logs.join(""));
    const token = await login(baseUrl, pairingToken);
    const status = await requestJson(baseUrl, "/api/status", { token });
    const workspace = (status.workspaces || []).find((item) => path.resolve(item.path) === rootDir) || status.workspaces?.[0];
    if (!workspace?.id) throw new Error("server canary could not find a workspace");

    await requestJson(baseUrl, "/api/tool-events/stats", { token });
    const warmupToolRunId = await startTerminalSession(baseUrl, token, workspace.id);
    await waitForStats(
      baseUrl,
      token,
      (item) => Number(metric(item, "insertToolEvents").modeCounts?.["rust-sidecar"] || 0) > 0 &&
        Number(item.eventStore?.rustSidecar?.client?.pending || 0) === 0,
      30000
    );
    await stopTerminalSession(baseUrl, token, warmupToolRunId, "Event-store server canary warm-up completed.");
    const baselineStats = await waitForStats(
      baseUrl,
      token,
      (item) => Number(item.eventStore?.rustSidecar?.client?.pending || 0) === 0,
      30000
    );

    const commandScript = `for ($i = 0; $i -lt ${commandLines}; $i++) { Write-Output \"event-store-server-canary $i\" }`;
    const commandResult = await requestJson(baseUrl, `/api/workspaces/${encodeURIComponent(workspace.id)}/command`, {
      method: "POST",
      token,
      body: {
        command: commandScript,
        timeoutMs: 60000
      }
    });
    if (!commandResult.ok) throw new Error(`workspace command failed: ${commandResult.stderr || commandResult.stdout || "unknown"}`);

    const terminalToolRunId = await startTerminalSession(baseUrl, token, workspace.id);

    const live = await requestJson(baseUrl, "/api/live-calls", {
      method: "POST",
      token,
      body: {
        title: "Event store server canary",
        source: "event-store-server-canary"
      }
    });
    const liveCallId = live.session?.id;
    if (!liveCallId) throw new Error("live-call creation did not return an id");

    for (let index = 0; index < liveEvents; index += 1) {
      await requestJson(baseUrl, `/api/live-calls/${encodeURIComponent(liveCallId)}/transcript`, {
        method: "POST",
        token,
        body: {
          text: `server canary transcript ${index}`,
          final: index % 5 === 0,
          speaker: index % 2 === 0 ? "remote" : "local"
        }
      });
      if (index % 4 === 0) {
        await requestJson(baseUrl, `/api/live-calls/${encodeURIComponent(liveCallId)}/level`, {
          method: "POST",
          token,
          body: {
            channel: "remote",
            bytes: index * 1600,
            peak: 0.4,
            rms: 0.2,
            deviceName: "server-canary"
          }
        });
      }
    }

    await stopTerminalSession(baseUrl, token, terminalToolRunId, "Event-store server canary completed.");

    const stats = await waitForStats(
      baseUrl,
      token,
      (item) => {
        const tool = metricDelta(baselineStats, item, "insertToolEvents");
        const liveStats = metricDelta(baselineStats, item, "insertLiveCallEvents");
        return Number(tool.modeCounts?.["rust-sidecar"] || 0) > 0 &&
          Number(liveStats.modeCounts?.["rust-sidecar"] || 0) > 0 &&
          Number(item.eventStore?.rustSidecar?.client?.pending || 0) === 0;
      },
      30000
    );
    const evaluation = evaluate(stats, baselineStats, { maxAppendAvgMs, functionalOnly });
    const result = {
      generatedAt: nowIso(),
      baseUrl,
      dataDir,
      workspaceId: workspace.id,
      liveCallId,
      commandResult: {
        ok: commandResult.ok,
        toolRunId: commandResult.toolRunId,
        exitCode: commandResult.exitCode,
        stdoutBytes: Buffer.byteLength(commandResult.stdout || "", "utf8"),
        stderrBytes: Buffer.byteLength(commandResult.stderr || "", "utf8")
      },
      terminalToolRunId,
      baselineStats,
      stats,
      rustCommand: command,
      commandProfile: resolvedCommand.profile,
      explicitCommand: resolvedCommand.explicit,
      workload: { liveEvents, commandLines, maxAppendAvgMs, functionalOnly },
      evaluation
    };

    const output = stringArg("--output", "");
    if (output) {
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    if (flag("--json")) console.log(JSON.stringify(result, null, 2));
    else printSummary(result);
    process.exitCode = evaluation.passed ? 0 : 1;
  } finally {
    server.child.kill();
    await sleep(500);
    if (flag("--delete-temp")) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[server-canary] temp cleanup skipped: ${error.message}`);
      }
    }
  }
}

if (pathToFileURL(process.argv[1] || "").href === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
