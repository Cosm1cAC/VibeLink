#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { rustBinaryIsCurrent } from "../../test/rustTestSupport.js";
import { verifySseReconnect } from "../live-call/qa-stress.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const seconds = Math.max(1, Number(process.env.VIBELINK_EVIDENCE_SECONDS || 600));
const pcmFile = process.env.VIBELINK_EVIDENCE_PCM_FILE
  ? path.resolve(process.env.VIBELINK_EVIDENCE_PCM_FILE)
  : "";
const outputRoot = path.join(root, ".tmp", "release-evidence", "live-call");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(outputRoot, runId);
const dataDir = path.join(runDir, "rust-data");
const sourceRoot = path.join(root, "apps", "windows", "src");
const binary = path.join(
  root,
  "apps",
  "windows",
  "target",
  "debug",
  process.platform === "win32" ? "vibelink.exe" : "vibelink"
);
const cargo = process.env.CARGO
  || path.join(os.homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
const token = "rust-live-call-evidence-token";

fs.mkdirSync(dataDir, { recursive: true });

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(url) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/status`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_000)
      });
      if (response.ok && response.headers.get("x-vibelink-control-plane") === "rust") return;
    } catch {}
    await wait(250);
  }
  throw new Error("Rust-only Live Call evidence server did not start.");
}

function stopProcessTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  } else {
    child.kill("SIGTERM");
  }
}

function descendantNodeProcesses(pid) {
  if (process.platform !== "win32") return [];
  const script = `$items=@(); function Visit([int]$p){$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $p" -ErrorAction SilentlyContinue); foreach($child in $children){if($child.Name -ieq "node.exe"){$items += [pscustomobject]@{pid=$child.ProcessId;path=$child.ExecutablePath}}; Visit $child.ProcessId}}; Visit ${pid}; $items | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const value = JSON.parse(result.stdout);
  return Array.isArray(value) ? value : [value];
}

function fileInventory(directory) {
  if (!fs.existsSync(directory)) return [];
  const pending = [directory];
  const files = [];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const item = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(item);
      else if (entry.isFile()) {
        files.push({
          path: path.relative(dataDir, item).replaceAll("\\", "/"),
          bytes: fs.statSync(item).size
        });
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function initializeDatabase() {
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
    pairingToken: "RUSTEVIDENCE",
    hostAllowlist: ["127.0.0.1"]
  }));
  const database = new DatabaseSync(path.join(dataDir, "mobile-agent.sqlite"));
  database.exec("CREATE TABLE devices (id TEXT, label TEXT, token_hash TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT, expires_at TEXT, rotated_at TEXT, meta_json TEXT)");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  database.prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, '{}')").run(
    "live-call-evidence",
    "Rust Live Call evidence",
    hash,
    new Date().toISOString(),
    new Date().toISOString(),
    "2099-01-01T00:00:00.000Z"
  );
  database.close();
}

if (!fs.existsSync(cargo)) throw new Error(`cargo is not available at ${cargo}`);
if (!rustBinaryIsCurrent(binary, sourceRoot)) {
  const build = spawnSync(cargo, ["build", "--manifest-path", "apps/windows/Cargo.toml"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout || "Rust build failed.");
}

initializeDatabase();
const port = await reservePort();
const url = `http://127.0.0.1:${port}`;
const bridgeOut = fs.openSync(path.join(runDir, "bridge.stdout.log"), "w");
const bridgeErr = fs.openSync(path.join(runDir, "bridge.stderr.log"), "w");
const execdOut = fs.openSync(path.join(runDir, "execd.stdout.log"), "w");
const execdErr = fs.openSync(path.join(runDir, "execd.stderr.log"), "w");
const execd = spawn(binary, ["execd", "--data-dir", dataDir], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", execdOut, execdErr],
  env: { ...process.env, VIBELINK_TASK_SCHEDULER_OWNER: "rust" }
});
const bridge = spawn(
  binary,
  ["--host", "127.0.0.1", "--port", String(port), "rust-only", "--data-dir", dataDir],
  {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", bridgeOut, bridgeErr],
    env: { ...process.env, VIBELINK_DATA_DIR: dataDir }
  }
);
const report = {
  ok: false,
  startedAt: new Date().toISOString(),
  durationSeconds: seconds,
  pcmSource: pcmFile || "synthetic-tone",
  controlPlane: "rust-only",
  runDir,
  dataDir,
  port
};
let failure;

try {
  await waitForReady(url);
  const asrResponse = await fetch(`${url}/api/live-calls/asr-providers`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const asr = await asrResponse.json();
  report.asr = asr.items?.find((item) => item.id === "whisper-cpp") || null;
  report.nodeDescendantsDuringRun = [
    ...descendantNodeProcesses(bridge.pid),
    ...descendantNodeProcesses(execd.pid)
  ];
  if (report.nodeDescendantsDuringRun.length) {
    throw new Error("Rust-only Live Call server spawned a Node descendant.");
  }

  const qualityPath = path.join(runDir, "quality.json");
  const qualityFile = fs.openSync(qualityPath, "w");
  const code = await new Promise((resolve, reject) => {
    const stressArgs = [
      "tools/live-call/qa-stress.mjs",
      "--seconds", String(seconds),
      "--interval-seconds", "30",
      "--asr-provider", "whisper-cpp",
      "--weak-network"
    ];
    if (pcmFile) stressArgs.push("--pcm-file", pcmFile);
    const child = spawn(
      process.execPath,
      stressArgs,
      {
        cwd: root,
        windowsHide: true,
        stdio: ["ignore", qualityFile, "inherit"],
        env: { ...process.env, VIBELINK_URL: url, VIBELINK_TOKEN: token }
      }
    );
    child.once("error", reject);
    child.once("exit", resolve);
  });
  fs.closeSync(qualityFile);
  if (code !== 0) throw new Error(`Live Call weak-network stress exited ${code}`);
  const quality = JSON.parse(fs.readFileSync(qualityPath, "utf8"));
  report.quality = quality;

  const drainDeadline = Date.now() + Math.max(
    1,
    Number(process.env.VIBELINK_EVIDENCE_DRAIN_SECONDS || 180)
  ) * 1000;
  let drainState;
  while (Date.now() < drainDeadline) {
    const drainDatabase = new DatabaseSync(path.join(dataDir, "mobile-agent.sqlite"), { readOnly: true });
    drainState = drainDatabase.prepare(
      "SELECT COUNT(*) AS unfinished FROM live_call_task_projections WHERE session_id=? AND done=0"
    ).get(quality.session.id);
    drainDatabase.close();
    if (Number(drainState.unfinished) === 0) break;
    if (execd.exitCode !== null) throw new Error(`Rust execution daemon exited with code ${execd.exitCode}`);
    await wait(250);
  }
  report.drainWait = {
    deadlineSeconds: Math.max(1, Number(process.env.VIBELINK_EVIDENCE_DRAIN_SECONDS || 180)),
    unfinishedAtDeadline: Number(drainState?.unfinished || 0)
  };
  const finalEventsResponse = await fetch(
    `${url}/api/live-calls/${encodeURIComponent(quality.session.id)}/events/catch-up?limit=5000`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!finalEventsResponse.ok) {
    throw new Error(`Final Live Call catch-up failed: HTTP ${finalEventsResponse.status}`);
  }
  const finalEvents = (await finalEventsResponse.json()).items || [];
  report.finalSseAudit = {
    eventCount: finalEvents.length,
    replayCount: await verifySseReconnect(
      { url, token },
      quality.session.id,
      finalEvents
    )
  };

  const database = new DatabaseSync(path.join(dataDir, "mobile-agent.sqlite"), { readOnly: true });
  const sessionId = quality.session.id;
  const cursors = database
    .prepare("SELECT cursor FROM live_call_events WHERE session_id=? ORDER BY cursor")
    .all(sessionId)
    .map((row) => Number(row.cursor));
  const duplicateEventIds = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM (SELECT event_id FROM live_call_events WHERE session_id=? GROUP BY event_id HAVING COUNT(*)>1)"
  ).get(sessionId).count);
  const unfinishedProjections = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM live_call_task_projections WHERE session_id=? AND done=0"
  ).get(sessionId).count);
  const taskOutcomes = database.prepare(
    "SELECT status,COUNT(*) AS count FROM tasks WHERE session_id=? GROUP BY status ORDER BY status"
  ).all(sessionId).map((row) => ({ status: row.status, count: Number(row.count) }));
  database.close();

  const runtime = JSON.parse(fs.readFileSync(path.join(dataDir, "live-call", "runtime.json"), "utf8"));
  const pendingQuestions = runtime.sessions?.[sessionId]?.pending_questions || [];
  const pcmFiles = fileInventory(path.join(dataDir, "live-call", "pcm"));
  const checkpointFiles = fileInventory(path.join(dataDir, "live-call", "asr-checkpoints"));
  const pcmBytes = pcmFiles.reduce((sum, file) => sum + file.bytes, 0);
  const checkpointBytes = checkpointFiles.reduce((sum, file) => sum + file.bytes, 0);
  const monotonicCursors = cursors.every((cursor, index) => index === 0 || cursor > cursors[index - 1]);
  const contiguousCursors = cursors.every(
    (cursor, index) => index === 0 || cursor === cursors[index - 1] + 1
  );
  Object.assign(report, {
    eventAudit: {
      count: cursors.length,
      monotonic: monotonicCursors,
      contiguous: contiguousCursors,
      duplicateEventIds
    },
    pendingAudit: {
      runtimeQuestions: pendingQuestions.length,
      unfinishedTaskProjections: unfinishedProjections,
      taskOutcomes
    },
    recordingAudit: {
      sentBytes: quality.sentBytes,
      retainedPcmBytes: pcmBytes,
      checkpointBytes,
      checkpointLimitBytes: 64 * 1024 * 1024,
      pcmFiles,
      checkpointFiles
    }
  });
  if (!monotonicCursors || !contiguousCursors || duplicateEventIds !== 0) {
    throw new Error("Live Call event audit failed.");
  }
  if (quality.sseReplayCount !== quality.eventCount) throw new Error("Live Call SSE replay count mismatch.");
  if (report.finalSseAudit.replayCount !== report.finalSseAudit.eventCount) {
    throw new Error("Final Live Call SSE replay count mismatch.");
  }
  if (pendingQuestions.length !== 0 || unfinishedProjections !== 0) {
    throw new Error("Live Call pending work was not drained.");
  }
  if (pcmBytes !== quality.sentBytes) throw new Error("Retained PCM byte count does not match accepted audio.");
  if (checkpointBytes > 64 * 1024 * 1024) throw new Error("ASR checkpoint retention exceeded its bound.");
  if (bridge.exitCode !== null) throw new Error(`Rust-only server crashed with exit code ${bridge.exitCode}`);
} catch (error) {
  failure = error;
  report.error = error.stack || error.message;
} finally {
  stopProcessTree(bridge);
  stopProcessTree(execd);
  for (let attempt = 0; attempt < 50 && (bridge.exitCode === null || execd.exitCode === null); attempt += 1) await wait(100);
  fs.closeSync(bridgeOut);
  fs.closeSync(bridgeErr);
  fs.closeSync(execdOut);
  fs.closeSync(execdErr);
  report.processExitCode = bridge.exitCode;
  report.executionDaemonExitCode = execd.exitCode;
  report.listenerClosed = !(await canConnect(port));
  const liveCallDir = path.join(dataDir, "live-call");
  const handleProbe = path.join(dataDir, "live-call-handle-probe");
  try {
    if (fs.existsSync(liveCallDir)) {
      fs.renameSync(liveCallDir, handleProbe);
      fs.renameSync(handleProbe, liveCallDir);
    }
    report.recordingHandlesReleased = true;
  } catch (error) {
    report.recordingHandlesReleased = false;
    failure ||= error;
    report.error ||= error.stack || error.message;
  }
  if (!report.listenerClosed) {
    failure ||= new Error("Rust-only listener remained open after shutdown.");
    report.error ||= failure.stack || failure.message;
  }
  report.completedAt = new Date().toISOString();
  report.ok = !failure && report.listenerClosed && report.recordingHandlesReleased;
  fs.writeFileSync(path.join(runDir, "evidence.json"), JSON.stringify(report, null, 2));
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failure) throw failure;
