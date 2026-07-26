#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function expand(archive, destination) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`
  ], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Cannot extract ${archive}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

async function waitForOpenApi(port, child, expectedOwner, token) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${expectedOwner} process exited with ${child.exitCode}`);
    try {
      const route = expectedOwner === "node" ? "/" : "/api/openapi.json";
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const owner = response.headers.get("x-vibelink-control-plane") || "node";
      if (owner !== expectedOwner) throw new Error(`Expected ${expectedOwner}, received ${owner}`);
      if (expectedOwner === "rust") {
        const body = await response.json();
        if (body.openapi !== "3.0.3") throw new Error("OpenAPI version mismatch");
      } else if (!/^text\/html/.test(response.headers.get("content-type") || "")) {
        throw new Error("Hybrid root did not serve the compatibility client");
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error(`${expectedOwner} did not become ready`);
}

async function listenerClosed(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(true));
    socket.once("error", () => finish(true));
    socket.once("connect", () => finish(false));
  });
}

async function runStage(report, name, command, args, options, port, owner, marker, token) {
  const startedAt = Date.now();
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs = (logs + chunk).slice(-4_000); });
  child.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-4_000); });
  try {
    await waitForOpenApi(port, child, owner, token);
    if (fs.readFileSync(marker, "utf8") !== "phase6-state-preserved\n") {
      throw new Error(`${name} did not preserve the shared state marker`);
    }
    report.stages.push({ name, owner, executable: path.basename(command), pid: child.pid, ready: true, durationMs: Date.now() - startedAt });
  } catch (error) {
    throw new Error(`${name}: ${error.message}\n${logs}`);
  } finally {
    stopTree(child);
  }
  for (let attempt = 0; attempt < 50 && !(await listenerClosed(port)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(await listenerClosed(port))) throw new Error(`${name} listener remained open after shutdown`);
}

const hybridArchive = path.resolve(argument("--hybrid"));
const rustOnlyArchive = path.resolve(argument("--rust-only"));
const output = path.resolve(argument("--output") || ".tmp/release-evidence/phase6/upgrade-rollback.json");
for (const archive of [hybridArchive, rustOnlyArchive]) {
  if (!fs.existsSync(archive)) throw new Error(`Archive not found: ${archive}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-phase6-rollback-"));
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), archives: {}, stages: [], passed: false };
try {
  const hybridExtract = path.join(tempRoot, "hybrid");
  const rustExtract = path.join(tempRoot, "rust-only");
  fs.mkdirSync(hybridExtract);
  fs.mkdirSync(rustExtract);
  expand(hybridArchive, hybridExtract);
  expand(rustOnlyArchive, rustExtract);
  const hybridRoot = path.join(hybridExtract, "VibeLink");
  const rustRoot = path.join(rustExtract, "VibeLink");
  const hybridManifest = JSON.parse(fs.readFileSync(path.join(hybridRoot, "release-manifest.json"), "utf8"));
  const rustManifest = JSON.parse(fs.readFileSync(path.join(rustRoot, "release-manifest.json"), "utf8"));
  const hybridNode = path.join(hybridRoot, "runtime", "node.exe");
  const hybridServer = path.join(hybridRoot, "src", "server.js");
  const legacyHybrid = !hybridManifest.runtimeFlavor && Boolean(hybridManifest.node);
  if ((!legacyHybrid && hybridManifest.runtimeFlavor !== "hybrid")
      || !fs.existsSync(hybridNode)
      || !fs.existsSync(hybridServer)
      || rustManifest.runtimeFlavor !== "rust-only") {
    throw new Error("Archive metadata or runtime assets do not match the rehearsal role");
  }
  report.archives = {
    hybrid: { path: hybridArchive, sha256: sha256(hybridArchive), commit: hybridManifest.commit },
    rustOnly: { path: rustOnlyArchive, sha256: sha256(rustOnlyArchive), commit: rustManifest.commit }
  };
  const dataDir = path.join(tempRoot, "shared-data");
  fs.mkdirSync(dataDir);
  const marker = path.join(dataDir, "phase6-state.txt");
  fs.writeFileSync(marker, "phase6-state-preserved\n");
  const token = "phase6-upgrade-rollback-token";
  const port = await freePort();
  const rustExe = path.join(rustRoot, "vibelink.exe");
  const rustOptions = { cwd: rustRoot, env: { ...process.env, VIBELINK_DATA_DIR: dataDir } };
  const hybridOptions = {
    cwd: hybridRoot,
    env: {
      ...process.env,
      VIBELINK_DATA_DIR: dataDir,
      MOBILE_AGENT_HOST: "127.0.0.1",
      MOBILE_AGENT_PORT: String(port),
      MOBILE_AGENT_TOKEN: token,
      VIBELINK_SEARCH_INDEX_STARTUP: "0",
      VIBELINK_PROVIDER_CACHE_STARTUP: "0"
    }
  };
  const rustArgs = ["--host", "127.0.0.1", "--port", String(port), "rust-only", "--data-dir", dataDir];
  await runStage(report, "upgrade-to-rust-only", rustExe, rustArgs, rustOptions, port, "rust", marker, token);
  await runStage(report, "process-rollback-to-hybrid", hybridNode, [hybridServer], hybridOptions, port, "node", marker, token);
  await runStage(report, "re-upgrade-to-rust-only", rustExe, rustArgs, rustOptions, port, "rust", marker, token);
  report.passed = report.stages.length === 3 && report.stages.every((stage) => stage.ready);
} catch (error) {
  report.error = error.stack || error.message;
} finally {
  report.completedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
