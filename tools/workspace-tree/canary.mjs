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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return String(process.argv[index + 1] || fallback);
}

function flag(name) {
  return process.argv.includes(name);
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index];
}

function defaultRustCommand() {
  if (process.env.VIBELINK_RUST_BIN) return process.env.VIBELINK_RUST_BIN;
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  const release = path.join(rootDir, "apps", "windows", "target", "release", binary);
  if (fs.existsSync(release)) return release;
  return path.join(rootDir, "apps", "windows", "target", "debug", binary);
}

function rustArgs() {
  const raw = stringArg("--args-json", process.env.VIBELINK_RUST_BIN_ARGS_JSON || "[]");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    throw new Error("--args-json must be a JSON array.");
  }
}

function createTempRoot() {
  const requested = stringArg("--tmp-dir", "");
  if (requested) {
    fs.mkdirSync(requested, { recursive: true });
    return fs.mkdtempSync(path.join(path.resolve(requested), "vibelink-workspace-tree-canary-"));
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-tree-canary-"));
}

function writeFixture(fixture) {
  fs.mkdirSync(path.join(fixture, "src", "generated"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "src", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "src", "private"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "src", "target"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "src", ".gitignore"),
    "secret.txt\n*.log\n!keep.log\nprivate/\ngenerated/*.tmp\n!generated/keep.tmp\n",
    "utf8"
  );
  fs.writeFileSync(path.join(fixture, "src", ".env"), "CANARY=1", "utf8");
  fs.writeFileSync(path.join(fixture, "src", ".hidden"), "hidden", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "app.rs"), "fn main() {}", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "debug.log"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "keep.log"), "kept", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "secret.txt"), "initially ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "generated", "keep.tmp"), "kept", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "generated", "noise.tmp"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "generated", "note.txt"), "kept", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "node_modules", "noise.js"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "private", "note.txt"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "target", "noise.txt"), "ignored", "utf8");
}

async function measure(callback) {
  const startedAt = performance.now();
  const value = await callback();
  return { value, durationMs: performance.now() - startedAt };
}

function delta(after, before, key) {
  return Number(after?.[key] || 0) - Number(before?.[key] || 0);
}

function printSummary(result) {
  console.log("Workspace-tree Rust auto-mode canary");
  console.log(`- command: ${result.rust.command}`);
  console.log(`- first launch: ${result.rust.available.firstLaunchMs}ms`);
  console.log(`- cold: ${result.rust.available.coldMs}ms`);
  console.log(`- warm p95: ${result.rust.available.warmP95Ms}ms`);
  console.log(`- warm cache hits: ${result.rust.available.cacheHits}`);
  console.log("\nChecks:");
  for (const check of result.evaluation.checks) {
    console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`\nResult: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

async function main() {
  const command = path.resolve(stringArg("--command", defaultRustCommand()));
  const args = rustArgs();
  const warmScans = Math.max(1, Math.floor(numberArg("--warm-scans", 5)));
  const maxFirstLaunchMs = numberArg("--max-first-launch-ms", 1000);
  const maxColdMs = numberArg("--max-cold-ms", 500);
  const maxWarmMs = numberArg("--max-warm-ms", 50);
  if (!fs.existsSync(command)) {
    throw new Error(`Rust workspace-tree command is missing: ${command}`);
  }

  const tempRoot = createTempRoot();
  const fixture = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  writeFixture(fixture);
  process.env.VIBELINK_DATA_DIR = dataDir;

  try {
    const [{ getWorkspaceContext, getWorkspaceRuntimeStats, getWorkspaceTree }, { upsertWorkspace }] = await Promise.all([
      import("../../src/workspaces.js"),
      import("../../src/db.js")
    ]);
    const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "workspace-tree-canary" });
    const settings = { allowedRoots: [fixture] };

    delete process.env.VIBELINK_RUST_WORKSPACE_TREE;
    delete process.env.VIBELINK_RUST_BIN;
    delete process.env.VIBELINK_RUST_BIN_ARGS_JSON;
    const nodeInitial = await measure(() => getWorkspaceContext(workspace.id, settings, { paths: ["src"] }));

    process.env.VIBELINK_RUST_WORKSPACE_TREE = "auto";
    process.env.VIBELINK_RUST_BIN = command;
    process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify(args);
    const beforeFirstLaunch = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const firstLaunch = await measure(() => getWorkspaceTree(workspace.id, settings, ""));
    const afterFirstLaunch = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const beforeAvailable = afterFirstLaunch;
    const rustCold = await measure(() => getWorkspaceContext(workspace.id, settings, { paths: ["src"] }));
    const afterCold = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const warmDurations = [];
    for (let index = 0; index < warmScans; index += 1) {
      const warm = await measure(() => getWorkspaceContext(workspace.id, settings, { paths: ["src"] }));
      warmDurations.push(warm.durationMs);
      if (warm.value.prompt !== rustCold.value.prompt) {
        throw new Error(`Warm scan ${index + 1} changed the workspace context output.`);
      }
    }
    const afterWarm = getWorkspaceRuntimeStats().rustWorkspaceTree;

    fs.writeFileSync(path.join(fixture, "src", ".gitignore"), "public.txt\n*.log\n!keep.log\nprivate/\ngenerated/*.tmp\n!generated/keep.tmp\n", "utf8");
    const rustRefreshed = await measure(() => getWorkspaceContext(workspace.id, settings, { paths: ["src"] }));
    const afterRefresh = getWorkspaceRuntimeStats().rustWorkspaceTree;
    delete process.env.VIBELINK_RUST_WORKSPACE_TREE;
    const nodeRefreshed = await measure(() => getWorkspaceContext(workspace.id, settings, { paths: ["src"] }));

    process.env.VIBELINK_RUST_WORKSPACE_TREE = "auto";
    process.env.VIBELINK_RUST_BIN = path.join(tempRoot, "missing-vibelink-command.exe");
    const beforeMissing = getWorkspaceRuntimeStats().rustWorkspaceTree;
    await getWorkspaceTree(workspace.id, settings, "");
    const afterMissing = getWorkspaceRuntimeStats().rustWorkspaceTree;

    const available = {
      starts: delta(afterWarm, beforeAvailable, "hits"),
      coldStarts: delta(afterCold, beforeAvailable, "hits"),
      additionalStartsDuringWarmScans: delta(afterWarm, afterCold, "hits"),
      refreshStarts: delta(afterRefresh, afterWarm, "hits"),
      failures: delta(afterWarm, beforeAvailable, "failures"),
      fallbacks: delta(afterWarm, beforeAvailable, "fallbacks"),
      cacheHits: delta(afterWarm, afterCold, "cacheHits"),
      cacheMisses: delta(afterWarm, beforeAvailable, "cacheMisses"),
      firstLaunchStarts: delta(afterFirstLaunch, beforeFirstLaunch, "hits"),
      firstLaunchFailures: delta(afterFirstLaunch, beforeFirstLaunch, "failures"),
      firstLaunchFallbacks: delta(afterFirstLaunch, beforeFirstLaunch, "fallbacks"),
      firstLaunchLastError: afterFirstLaunch.lastError,
      firstLaunchMs: roundMs(firstLaunch.durationMs),
      coldMs: roundMs(rustCold.durationMs),
      warmAvgMs: roundMs(warmDurations.reduce((sum, value) => sum + value, 0) / warmDurations.length),
      warmP95Ms: roundMs(percentile(warmDurations, 0.95)),
      refreshMs: roundMs(rustRefreshed.durationMs),
      stats: afterRefresh
    };
    const missingCommand = {
      available: afterMissing.available,
      missDelta: delta(afterMissing, beforeMissing, "misses"),
      failureDelta: delta(afterMissing, beforeMissing, "failures"),
      fallbackDelta: delta(afterMissing, beforeMissing, "fallbacks")
    };
    const parity = {
      initial: rustCold.value.prompt === nodeInitial.value.prompt,
      afterGitignoreChange: rustRefreshed.value.prompt === nodeRefreshed.value.prompt
    };
    const checks = [
      { name: "initial path/type parity", pass: parity.initial, detail: parity.initial ? "exact prompt match" : "Node/Rust output differs" },
      { name: "post-gitignore parity", pass: parity.afterGitignoreChange, detail: parity.afterGitignoreChange ? "exact refreshed prompt match" : "refreshed output differs" },
      { name: "available command routing", pass: beforeAvailable.available && available.coldStarts === 1, detail: `${available.coldStarts} cold Rust start(s)` },
      { name: "available command fallback", pass: available.failures === 0 && available.fallbacks === 0, detail: `${available.failures} failures, ${available.fallbacks} fallbacks` },
      { name: "warm cache reuse", pass: available.cacheHits >= warmScans && available.additionalStartsDuringWarmScans === 0, detail: `${available.cacheHits} cache hits, ${available.additionalStartsDuringWarmScans} extra Rust starts` },
      { name: "nested gitignore invalidation", pass: available.refreshStarts === 1 && /secret\.txt/.test(rustRefreshed.value.prompt), detail: `${available.refreshStarts} refresh Rust start(s)` },
      { name: "missing command auto fallback", pass: missingCommand.available === false && missingCommand.failureDelta === 0 && missingCommand.fallbackDelta === 0, detail: `${missingCommand.failureDelta} failures, ${missingCommand.fallbackDelta} fallbacks` },
      { name: "first launch routing", pass: available.firstLaunchStarts === 1 && available.firstLaunchFailures === 0 && available.firstLaunchFallbacks === 0, detail: `${available.firstLaunchStarts} Rust start, ${available.firstLaunchFailures} failures, ${available.firstLaunchFallbacks} fallbacks${available.firstLaunchLastError ? `: ${available.firstLaunchLastError}` : ""}` },
      { name: "first launch latency", pass: available.firstLaunchMs <= maxFirstLaunchMs, detail: `${available.firstLaunchMs}ms; limit ${maxFirstLaunchMs}ms` },
      { name: "cold latency", pass: available.coldMs <= maxColdMs, detail: `${available.coldMs}ms; limit ${maxColdMs}ms` },
      { name: "warm latency", pass: available.warmP95Ms <= maxWarmMs, detail: `${available.warmP95Ms}ms p95; limit ${maxWarmMs}ms` }
    ];
    const result = {
      generatedAt: new Date().toISOString(),
      tempRoot,
      workload: { warmScans, maxFirstLaunchMs, maxColdMs, maxWarmMs },
      node: {
        initialMs: roundMs(nodeInitial.durationMs),
        refreshedMs: roundMs(nodeRefreshed.durationMs)
      },
      parity,
      rust: { command, args, available, missingCommand },
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
    if (flag("--delete-temp")) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[workspace-tree-canary] temp cleanup skipped: ${error.message}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
