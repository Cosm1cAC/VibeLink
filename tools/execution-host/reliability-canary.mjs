import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { createExecutionHostClient } from "../../src/executionHostClient.js";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function integerArgument(name, fallback, minimum = 0) {
  const value = Number(argument(name, fallback));
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

const binaryArgument = argument("--bin", process.env.VIBELINK_EXECUTION_HOST_TEST_BIN || process.env.VIBELINK_RUST_BIN || "");
const binary = binaryArgument ? path.resolve(binaryArgument) : "";
const outputPath = argument("--output");
const durationMs = integerArgument("--duration-ms", 30_000, 0);
const timeoutMs = integerArgument("--timeout-ms", 15_000, 1_000);
const intervalMs = integerArgument("--interval-ms", 250, 25);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launch(dataDir, pipeName, logs) {
  const child = spawn(binary, ["execd", "--data-dir", dataDir, "--pipe", pipeName], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (data) => logs.push(data.toString()));
  child.stderr.on("data", (data) => logs.push(data.toString()));
  return child;
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3_000)
  ]);
}

async function waitForHost(client, child) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`execd exited during startup with ${child.exitCode}`);
    try {
      return await client.health();
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError || new Error("execd did not become ready");
}

function eventText(events) {
  return Buffer.concat(events
    .filter((event) => event.type === "stream.stdout" || event.type === "stream.pty")
    .map((event) => event.payload?.encoding === "base64"
      ? Buffer.from(String(event.payload.data || ""), "base64")
      : Buffer.from(String(event.payload?.text ?? event.payload?.data ?? ""), "utf8")))
    .toString("utf8");
}

async function waitForEvents(client, executionId, predicate, { after = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const events = [];
  let cursor = after;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const page = await client.events(executionId, cursor, 500);
      for (const event of page.events || []) {
        events.push(event);
        cursor = Math.max(cursor, Number(event.hostSeq || 0));
      }
      if (predicate(events)) return { events, cursor };
    } catch (error) {
      lastError = error;
      if (!error.retryable && error.code !== "EXECUTION_NOT_ATTACHED") throw error;
    }
    await delay(25);
  }
  if (lastError) throw lastError;
  const error = new Error(`event condition timed out after hostSeq ${cursor}`);
  error.canaryDiagnostics = {
    afterHostSeq: after,
    lastObservedHostSeq: cursor,
    observedEventCount: events.length,
    observedEventTypes: events.slice(-32).map((event) => event.type),
    observedTextTail: eventText(events).slice(-2_000)
  };
  throw error;
}

function dataDirInventory(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else files.push({ path: path.relative(root, absolute), bytes: fs.statSync(absolute).size });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function check(report, name, pass, detail, startedAt = Date.now()) {
  report.checks.push({ name, pass: Boolean(pass), detail, durationMs: Date.now() - startedAt });
  if (!pass) throw new Error(`${name}: ${detail}`);
}

async function main() {
  if (process.platform !== "win32") throw new Error("execution-host reliability canary requires Windows");
  if (!binary || !fs.existsSync(binary)) throw new Error("pass --bin or set VIBELINK_EXECUTION_HOST_TEST_BIN to an execd-capable binary");

  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    binary,
    configuration: { durationMs, timeoutMs, intervalMs },
    checks: [],
    alerts: [],
    metrics: { execdRestarts: 0, bridgeReconnects: 0, soakRounds: 0, ackedHostSeq: 0 },
    passed: false
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-execution-host-canary-"));
  const pipeName = `\\\\.\\pipe\\vibelink-execution-host-canary-${process.pid}-${crypto.randomUUID()}`;
  const executionId = crypto.randomUUID();
  const logs = [];
  let daemon;
  let client;
  let workerPid = 0;
  let processPid = 0;

  try {
    daemon = launch(dataDir, pipeName, logs);
    client = createExecutionHostClient({ pipeName, command: "", requestTimeoutMs: 3_000 });
    const healthStarted = Date.now();
    await waitForHost(client, daemon);
    check(report, "execd startup", true, "host.health responded", healthStarted);

    const started = await client.start({
      executionId,
      kind: "terminal",
      backend: "conpty",
      command: "cmd.exe",
      args: ["/D", "/Q", "/K"],
      cwd: dataDir,
      env: { TERM: "xterm-256color" },
      cols: 100,
      rows: 30,
      spoolQuotaBytes: 16 * 1024 * 1024,
      segmentBytes: 4 * 1024,
      operationId: `canary-start:${executionId}`
    });
    workerPid = Number(started.workerPid || 0);
    processPid = Number(started.processPid || 0);

    const bridgeMarker = `bridge-${crypto.randomUUID()}`;
    await client.input(executionId, `echo ${bridgeMarker}\r\n`, "utf8", `bridge-input:${executionId}`);
    client = createExecutionHostClient({ pipeName, command: "", requestTimeoutMs: 3_000 });
    report.metrics.bridgeReconnects += 1;
    const bridgeReplay = await waitForEvents(client, executionId, (events) => eventText(events).includes(bridgeMarker));
    check(report, "Bridge crash/reconnect", eventText(bridgeReplay.events).includes(bridgeMarker), "a new stateless client replayed the unacked output");

    const restartMarker = `execd-${crypto.randomUUID()}`;
    await client.input(
      executionId,
      `(ping -n 2 127.0.0.1 >nul) & echo ${restartMarker}\r\n`,
      "utf8",
      `restart-input:${executionId}`
    );
    await terminate(daemon);
    daemon = launch(dataDir, pipeName, logs);
    report.metrics.execdRestarts += 1;
    client = createExecutionHostClient({ pipeName, command: "", requestTimeoutMs: 3_000 });
    await waitForHost(client, daemon);
    const reattached = await client.get(executionId);
    check(
      report,
      "execd crash recovery",
      reattached.workerInstanceId === started.workerInstanceId && reattached.workerPid === started.workerPid,
      `worker=${reattached.workerPid}, instance=${reattached.workerInstanceId}`
    );
    const downtimeReplay = await waitForEvents(client, executionId, (events) => eventText(events).includes(restartMarker));
    check(report, "downtime spool replay", eventText(downtimeReplay.events).includes(restartMarker), `replayed through hostSeq ${downtimeReplay.cursor}`);

    await client.ack(executionId, downtimeReplay.cursor, `canary-ack:${executionId}:${downtimeReplay.cursor}`);
    report.metrics.ackedHostSeq = downtimeReplay.cursor;
    const acked = await client.get(executionId);
    const pruned = await client.events(executionId, 0, 500);
    check(
      report,
      "durable ack and pruning",
      Number(acked.lastAckedHostSeq || 0) >= downtimeReplay.cursor && (pruned.events || []).length === 0,
      `acked=${acked.lastAckedHostSeq}, retained=${(pruned.events || []).length}`
    );

    let cursor = downtimeReplay.cursor;
    const soakDeadline = Date.now() + durationMs;
    while (Date.now() < soakDeadline) {
      const marker = `soak-${report.metrics.soakRounds}-${crypto.randomUUID()}`;
      await client.input(executionId, `echo ${marker}\r\n`, "utf8", `soak:${executionId}:${report.metrics.soakRounds}`);
      const round = await waitForEvents(client, executionId, (events) => eventText(events).includes(marker), { after: cursor });
      cursor = round.cursor;
      await client.ack(executionId, cursor, `soak-ack:${executionId}:${cursor}`);
      report.metrics.soakRounds += 1;
      report.metrics.ackedHostSeq = cursor;
      await delay(intervalMs);
    }
    report.metrics.ackedHostSeq = cursor;
    check(report, "spool/ack soak", report.metrics.soakRounds > 0 || durationMs === 0, `${report.metrics.soakRounds} acknowledged rounds over ${durationMs}ms`);

    const killedAt = Date.now();
    process.kill(workerPid);
    await delay(100);
    await terminate(daemon);
    daemon = launch(dataDir, pipeName, logs);
    report.metrics.execdRestarts += 1;
    client = createExecutionHostClient({ pipeName, command: "", requestTimeoutMs: 3_000 });
    await waitForHost(client, daemon);
    const lost = await waitForEvents(client, executionId, (events) => events.some((event) => event.type === "execution.lost"), { after: cursor });
    const lostEvent = lost.events.find((event) => event.type === "execution.lost");
    const lostSnapshot = await client.get(executionId);
    const detectionLatencyMs = Date.now() - killedAt;
    report.alerts.push({
      severity: "critical",
      signal: "execution.lost",
      observed: Boolean(lostEvent),
      durable: Boolean(lostEvent?.eventId),
      detectionLatencyMs,
      reason: lostEvent?.payload?.reason || ""
    });
    check(
      report,
      "worker crash signal",
      lostSnapshot.status === "lost" && lostSnapshot.attachState === "lost" && Boolean(lostEvent?.eventId),
      `status=${lostSnapshot.status}, attach=${lostSnapshot.attachState}, latency=${detectionLatencyMs}ms`
    );
    check(report, "fault alert evidence", report.alerts.every((alert) => alert.observed && alert.durable), "critical worker loss has a durable alert signal");
    report.passed = report.checks.every((item) => item.pass);
  } catch (error) {
    report.error = error.stack || error.message || String(error);
    report.diagnostics = { ...(error.canaryDiagnostics || {}) };
    try { report.diagnostics.snapshot = await client?.get(executionId); } catch (snapshotError) {
      report.diagnostics.snapshotError = snapshotError.message || String(snapshotError);
    }
    try { report.diagnostics.dataDirFiles = dataDirInventory(dataDir); } catch (inventoryError) {
      report.diagnostics.inventoryError = inventoryError.message || String(inventoryError);
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.logs = logs.join("").slice(-16_000);
    await terminate(daemon);
    for (const pid of [workerPid, processPid]) {
      if (!pid) continue;
      try { process.kill(pid); } catch {}
    }
    await delay(250);
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) {
      const resolved = path.resolve(outputPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, serialized);
    }
    process.stdout.write(serialized);
    if (!report.passed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
