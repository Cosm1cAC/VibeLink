#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function integerArg(name, fallback, minimum = 1) {
  const value = Number(stringArg(name, fallback));
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function numberArg(name, fallback) {
  const value = Number(stringArg(name, fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function defaultRustCommand() {
  if (process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND) return process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND;
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["release", "debug"]) {
    const command = path.join(rootDir, "apps", "windows", "target", profile, binary);
    if (fs.existsSync(command)) return command;
  }
  return path.join(rootDir, "apps", "windows", "target", "release", binary);
}

function createTempRoot() {
  const requested = stringArg("--tmp-dir", "");
  const parent = requested ? path.resolve(requested) : os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, "vibelink-mcp-soak-"));
}

function summarizeSession(index, canary, run, durationMs) {
  const rust = canary?.rust || {};
  const baseline = canary?.baseline || {};
  const cleanDrain = Number(rust.pendingBeforeDrain || 0) === 0
    && Number(rust.pendingAfterDrain || 0) === 0
    && Number(rust.drain?.remaining || 0) === 0
    && rust.activeAfterDrain === false
    && rust.terminatedAfterDrain === true;
  return {
    index,
    passed: run.status === 0 && canary?.evaluation?.passed === true,
    exitCode: run.status,
    durationMs: Number(durationMs.toFixed(1)),
    baselineServerSpawns: Number(baseline.serverSpawns || 0),
    rustServerSpawns: Number(rust.serverSpawns || 0),
    sidecarStarts: Number(rust.sidecarStarts || 0),
    failures: Number(rust.failures || 0),
    fallbacks: Number(rust.fallbacks || 0),
    backpressureRejects: Number(rust.backpressureRejects || 0),
    pendingAfterDrain: Number(rust.pendingAfterDrain || 0),
    averageMs: Number(rust.averageMs || 0),
    maxMs: Number(rust.maxMs || 0),
    cleanDrain,
    error: run.status === 0 ? "" : String(run.stderr || run.stdout || "canary failed").trim().slice(-2000)
  };
}

function totals(sessions) {
  const sum = (key) => sessions.reduce((total, session) => total + Number(session[key] || 0), 0);
  return {
    passedSessions: sessions.filter((session) => session.passed).length,
    baselineServerSpawns: sum("baselineServerSpawns"),
    rustServerSpawns: sum("rustServerSpawns"),
    sidecarStarts: sum("sidecarStarts"),
    failures: sum("failures"),
    fallbacks: sum("fallbacks"),
    backpressureRejects: sum("backpressureRejects"),
    pendingAfterDrain: sum("pendingAfterDrain"),
    maxRustRequestMs: Math.max(0, ...sessions.map((session) => session.maxMs)),
    totalDurationMs: Number(sum("durationMs").toFixed(1))
  };
}

function printSummary(result) {
  console.log("MCP Rust auto-mode multi-session soak");
  console.log(`- sessions: ${result.totals.passedSessions}/${result.config.sessions}`);
  console.log(`- workload: ${result.config.callsPerSession} calls per session`);
  console.log(`- server spawns: Node ${result.totals.baselineServerSpawns}, Rust ${result.totals.rustServerSpawns}`);
  console.log(`- max Rust request: ${result.totals.maxRustRequestMs}ms`);
  console.log("\nChecks:");
  for (const check of result.evaluation.checks) {
    console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`\nResult: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

function main() {
  const sessionsCount = integerArg("--sessions", 5);
  const callsPerSession = integerArg("--calls", 12);
  const maxRustRequestMs = numberArg("--max-rust-request-ms", 1000);
  const minimumSpawnReductionPercent = numberArg("--min-spawn-reduction-percent", 80);
  const timeoutMs = integerArg("--session-timeout-ms", 120000);
  const command = path.resolve(stringArg("--command", defaultRustCommand()));
  if (!fs.existsSync(command)) throw new Error(`Rust MCP sidecar command is missing: ${command}`);

  const tempRoot = createTempRoot();
  const sessions = [];
  try {
    for (let index = 0; index < sessionsCount; index += 1) {
      const sessionOutput = path.join(tempRoot, `session-${index + 1}.json`);
      const startedAt = performance.now();
      const run = spawnSync(process.execPath, [
        path.join(rootDir, "tools", "mcp-session", "canary.mjs"),
        "--command", command,
        "--calls", String(callsPerSession),
        "--output", sessionOutput,
        "--tmp-dir", tempRoot,
        "--delete-temp"
      ], { cwd: rootDir, encoding: "utf8", windowsHide: true, timeout: timeoutMs });
      let canary = null;
      try {
        canary = JSON.parse(fs.readFileSync(sessionOutput, "utf8"));
      } catch {}
      sessions.push(summarizeSession(index + 1, canary, run, performance.now() - startedAt));
    }

    const aggregate = totals(sessions);
    const expectedBaselineSpawns = sessionsCount * (callsPerSession + 1);
    const spawnReductionPercent = aggregate.baselineServerSpawns
      ? Number(((1 - aggregate.rustServerSpawns / aggregate.baselineServerSpawns) * 100).toFixed(1))
      : 0;
    const checks = [
      { name: "all sessions passed", pass: aggregate.passedSessions === sessionsCount, detail: `${aggregate.passedSessions}/${sessionsCount}` },
      { name: "baseline accounting", pass: aggregate.baselineServerSpawns === expectedBaselineSpawns, detail: `${aggregate.baselineServerSpawns}/${expectedBaselineSpawns} spawns` },
      { name: "one Rust server per session", pass: aggregate.rustServerSpawns === sessionsCount && aggregate.sidecarStarts === sessionsCount, detail: `${aggregate.rustServerSpawns} servers, ${aggregate.sidecarStarts} sidecars` },
      { name: "spawn reduction", pass: spawnReductionPercent >= minimumSpawnReductionPercent, detail: `${spawnReductionPercent}% >= ${minimumSpawnReductionPercent}%` },
      { name: "fallback and failure rate", pass: aggregate.failures === 0 && aggregate.fallbacks === 0, detail: `${aggregate.failures} failures, ${aggregate.fallbacks} fallbacks` },
      { name: "normal-load backpressure", pass: aggregate.backpressureRejects === 0, detail: `${aggregate.backpressureRejects} rejects` },
      { name: "clean drains", pass: aggregate.pendingAfterDrain === 0 && sessions.every((session) => session.cleanDrain), detail: `${aggregate.pendingAfterDrain} pending; ${sessions.filter((session) => session.cleanDrain).length}/${sessionsCount} clean` },
      { name: "request latency", pass: aggregate.maxRustRequestMs <= maxRustRequestMs, detail: `${aggregate.maxRustRequestMs}ms <= ${maxRustRequestMs}ms` }
    ];
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: { canary: "tools/mcp-session/canary.mjs", rustCommand: command, productionRoutingChanged: false },
      config: { sessions: sessionsCount, callsPerSession, maxRustRequestMs, minimumSpawnReductionPercent, sessionTimeoutMs: timeoutMs },
      sessions,
      totals: { ...aggregate, spawnReductionPercent },
      evaluation: { passed: checks.every((check) => check.pass), checks }
    };

    const output = stringArg("--output", "");
    if (output) {
      const outputPath = path.resolve(output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    if (flag("--json")) console.log(JSON.stringify(result, null, 2));
    else printSummary(result);
    process.exitCode = result.evaluation.passed ? 0 : 1;
  } finally {
    if (!flag("--keep-temp")) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
