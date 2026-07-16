#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

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

function defaultRustCommand() {
  if (process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND) {
    return process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND;
  }
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  const release = path.join(rootDir, "apps", "windows", "target", "release", binary);
  if (fs.existsSync(release)) return release;
  return path.join(rootDir, "apps", "windows", "target", "debug", binary);
}

function createTempRoot() {
  const requested = stringArg("--tmp-dir", "");
  if (requested) {
    fs.mkdirSync(requested, { recursive: true });
    return fs.mkdtempSync(path.join(path.resolve(requested), "vibelink-mcp-session-canary-"));
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-mcp-session-canary-"));
}

function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

async function measure(callback) {
  const startedAt = performance.now();
  const value = await callback();
  return { value, durationMs: performance.now() - startedAt };
}

function delta(after, before, key) {
  return Number(after?.[key] || 0) - Number(before?.[key] || 0);
}

function serverSettings(id, spawnLog, methodLog) {
  const server = {
    id,
    name: id,
    type: "stdio",
    command: process.execPath,
    args: [path.join(rootDir, "test", "fixtures", "fake-mcp-server.js")],
    env: {
      FAKE_MCP_SPAWN_LOG: spawnLog,
      FAKE_MCP_METHOD_LOG: methodLog
    }
  };
  return {
    server,
    settings: {
      codebaseMemory: { autoMcp: false },
      mcp: { servers: [server], probeTimeoutMs: 10000, callTimeoutMs: 10000 }
    }
  };
}

async function runWorkload({ runtime, settings, server, calls }) {
  const durations = [];
  const probe = await measure(() => runtime.probeMcpServer(server, { timeoutMs: 10000 }));
  durations.push(probe.durationMs);
  if (!probe.value.ok) throw new Error(`MCP probe failed: ${probe.value.error || probe.value.status}`);
  if (probe.value.tools?.map((tool) => tool.name).join(",") !== "echo") {
    throw new Error("MCP probe did not return the expected echo tool.");
  }

  for (let index = 0; index < calls; index += 1) {
    const call = await measure(() => runtime.callMcpTool(
      settings,
      { serverId: server.id, toolName: "echo", arguments: { index } },
      { timeoutMs: 10000 }
    ));
    durations.push(call.durationMs);
    if (!call.value.ok) throw new Error(`MCP tool call ${index} failed: ${call.value.error || call.value.status}`);
    const echoed = JSON.parse(call.value.content?.[0]?.text || "null");
    if (echoed?.arguments?.index !== index) throw new Error(`MCP tool call ${index} returned the wrong payload.`);
  }

  return {
    requests: calls + 1,
    averageMs: roundMs(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    maxMs: roundMs(Math.max(...durations))
  };
}

function printSummary(result) {
  console.log("MCP Rust persistent-session runtime canary");
  console.log(`- workload: 1 probe + ${result.workload.calls} tool calls`);
  console.log(`- server spawns: Node ${result.baseline.serverSpawns}, Rust ${result.rust.serverSpawns}`);
  console.log(`- spawn reduction: ${result.rust.spawnReductionPercent}%`);
  console.log("\nChecks:");
  for (const check of result.evaluation.checks) {
    console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`\nResult: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

async function main() {
  const calls = numberArg("--calls", 8);
  const command = path.resolve(stringArg("--command", defaultRustCommand()));
  if (!fs.existsSync(command)) throw new Error(`Rust MCP sidecar command is missing: ${command}`);

  const tempRoot = createTempRoot();
  process.env.VIBELINK_DATA_DIR = path.join(tempRoot, "data");
  let runtime = null;

  try {
    runtime = await import("../../src/mcpRuntime.js");
    const baselineSpawnLog = path.join(tempRoot, "baseline-spawns.log");
    const baselineMethodLog = path.join(tempRoot, "baseline-methods.log");
    const rustSpawnLog = path.join(tempRoot, "rust-spawns.log");
    const rustMethodLog = path.join(tempRoot, "rust-methods.log");

    delete process.env.VIBELINK_MCP_RUST_SIDECAR;
    delete process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND;
    delete process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON;
    delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
    const baselineConfig = serverSettings("mcp-canary-baseline", baselineSpawnLog, baselineMethodLog);
    const baselineWorkload = await runWorkload({ runtime, ...baselineConfig, calls });
    await runtime.closePersistentMcpSessions();

    process.env.VIBELINK_MCP_RUST_SIDECAR = "auto";
    process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND = command;
    process.env.VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON = JSON.stringify(["mcp-session-sidecar"]);
    delete process.env.VIBELINK_MCP_PERSISTENT_SESSIONS;
    const rustConfig = serverSettings("mcp-canary-rust", rustSpawnLog, rustMethodLog);
    const beforeRust = runtime.getMcpRustSidecarStats();
    const rustWorkload = await runWorkload({ runtime, ...rustConfig, calls });
    const afterRust = runtime.getMcpRustSidecarStats();

    const baselineSpawns = readLines(baselineSpawnLog).length;
    const rustSpawns = readLines(rustSpawnLog).length;
    const rustMethods = readLines(rustMethodLog);
    const pendingBeforeDrain = Number(afterRust.client?.pending || 0);
    const drain = await runtime.closeIdlePersistentMcpSessions({ maxIdleMs: 0 });
    const afterDrain = runtime.getMcpRustSidecarStats();
    const rustResult = {
      ...rustWorkload,
      serverSpawns: rustSpawns,
      spawnReductionPercent: baselineSpawns
        ? Math.round((1 - rustSpawns / baselineSpawns) * 1000) / 10
        : 0,
      toolsListCalls: rustMethods.filter((method) => method === "tools/list").length,
      toolCalls: rustMethods.filter((method) => method === "tools/call").length,
      sidecarStarts: delta(afterRust, beforeRust, "starts"),
      failures: delta(afterRust, beforeRust, "failures"),
      fallbacks: delta(afterRust, beforeRust, "fallbacks"),
      backpressureRejects: Number(afterRust.client?.backpressureRejects || 0),
      pendingBeforeDrain,
      readyBeforeDrain: afterRust.ready,
      failedBeforeDrain: afterRust.failed,
      lastError: afterRust.lastError,
      drain,
      activeAfterDrain: afterDrain.active,
      readyAfterDrain: afterDrain.ready,
      pendingAfterDrain: Number(afterDrain.client?.pending || 0),
      terminatedAfterDrain: afterDrain.client?.terminated === true
    };
    const baseline = {
      ...baselineWorkload,
      serverSpawns: baselineSpawns,
      toolsListCalls: readLines(baselineMethodLog).filter((method) => method === "tools/list").length
    };
    const checks = [
      { name: "baseline spawn accounting", pass: baseline.serverSpawns === calls + 1, detail: `${baseline.serverSpawns} spawns for ${calls + 1} requests` },
      { name: "Rust session reuse", pass: rustResult.serverSpawns === 1 && rustResult.sidecarStarts === 1, detail: `${rustResult.serverSpawns} MCP server spawn, ${rustResult.sidecarStarts} sidecar start` },
      { name: "spawn reduction", pass: rustResult.serverSpawns < baseline.serverSpawns, detail: `${rustResult.spawnReductionPercent}% fewer MCP server spawns` },
      { name: "tools/list cache", pass: rustResult.toolsListCalls === 1 && rustResult.toolCalls === calls, detail: `${rustResult.toolsListCalls} tools/list, ${rustResult.toolCalls} tools/call` },
      { name: "runtime readiness", pass: rustResult.readyBeforeDrain && !rustResult.failedBeforeDrain && !rustResult.lastError, detail: `ready=${rustResult.readyBeforeDrain}, failed=${rustResult.failedBeforeDrain}` },
      { name: "fallback rate", pass: rustResult.failures === 0 && rustResult.fallbacks === 0, detail: `${rustResult.failures} failures, ${rustResult.fallbacks} fallbacks` },
      { name: "normal-load backpressure", pass: rustResult.backpressureRejects === 0, detail: `${rustResult.backpressureRejects} client backpressure rejects` },
      { name: "pending drain", pass: rustResult.pendingBeforeDrain === 0 && rustResult.pendingAfterDrain === 0, detail: `${rustResult.pendingBeforeDrain} pending before drain, ${rustResult.pendingAfterDrain} after` },
      { name: "clean close", pass: rustResult.drain.remaining === 0 && !rustResult.activeAfterDrain && rustResult.terminatedAfterDrain, detail: `${rustResult.drain.closed} sessions closed, active=${rustResult.activeAfterDrain}` }
    ];
    const result = {
      generatedAt: new Date().toISOString(),
      tempRoot,
      workload: { calls, requests: calls + 1 },
      baseline,
      rust: { command, args: ["mcp-session-sidecar"], ...rustResult },
      evaluation: { passed: checks.every((check) => check.pass), checks }
    };

    const output = stringArg("--output", "");
    if (output) {
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    if (flag("--json")) console.log(JSON.stringify(result, null, 2));
    else printSummary(result);
    process.exitCode = result.evaluation.passed ? 0 : 1;
  } finally {
    if (runtime) await runtime.closePersistentMcpSessions().catch(() => {});
    if (flag("--delete-temp")) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[mcp-session-canary] temp cleanup skipped: ${error.message}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
