#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function numberArg(name, fallback) {
  const parsed = Number(stringArg(name, fallback));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function defaultRustCommand() {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  const release = path.join(rootDir, "apps", "windows", "target", "release", binary);
  if (fs.existsSync(release)) return release;
  return path.join(rootDir, "apps", "windows", "target", "debug", binary);
}

function delta(after, before, key) {
  return Number(after?.[key] || 0) - Number(before?.[key] || 0);
}

function roundMs(value) {
  return Number(Number(value || 0).toFixed(1));
}

function printSummary(result) {
  console.log("Workspace-tree real-repository canary");
  console.log(`- workspace: ${result.workspace}`);
  console.log(`- root items: ${result.workload.rootItems}`);
  console.log(`- context paths: ${result.workload.contextPaths.join(", ")}`);
  console.log(`- Node baseline: ${result.timings.nodeMs}ms`);
  console.log(`- Rust cold routes: ${result.timings.rustColdMs}ms`);
  console.log(`- Rust warm routes: ${result.timings.rustWarmMs}ms`);
  console.log(`- persistent sidecar starts: ${result.rust.session.starts}`);
  console.log("\nChecks:");
  for (const check of result.evaluation.checks) {
    console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`\nResult: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

async function main() {
  const workspaceRoot = path.resolve(stringArg("--workspace", rootDir));
  const contextPaths = stringArg("--paths", "src,docs")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
  const command = path.resolve(stringArg("--command", defaultRustCommand()));
  const maxWarmMs = numberArg("--max-warm-ms", 100);
  if (!fs.existsSync(command)) throw new Error(`Rust workspace-tree command is missing: ${command}`);
  if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error(`Workspace is not a directory: ${workspaceRoot}`);

  const requestedTemp = stringArg("--tmp-dir", os.tmpdir());
  fs.mkdirSync(requestedTemp, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(path.resolve(requestedTemp), "vibelink-workspace-real-canary-"));
  process.env.VIBELINK_DATA_DIR = dataDir;
  process.env.VIBELINK_RUST_BIN = command;
  process.env.VIBELINK_RUST_WORKSPACE_TREE_SESSION = flag("--one-shot") ? "0" : "auto";

  const db = await import("../../src/db.js");
  const workspaces = await import("../../src/workspaces.js");

  try {
    const workspace = db.upsertWorkspace({ path: workspaceRoot, allowedRoot: workspaceRoot, title: "workspace-tree-real-canary" });
    const settings = { allowedRoots: [workspaceRoot], defaultCwd: workspaceRoot };

    process.env.VIBELINK_RUST_WORKSPACE_TREE = "0";
    let started = performance.now();
    const nodeTree = await workspaces.getWorkspaceTree(workspace.id, settings, "");
    const nodeContext = await workspaces.getWorkspaceContext(workspace.id, settings, { paths: contextPaths });
    const nodeMs = performance.now() - started;

    process.env.VIBELINK_RUST_WORKSPACE_TREE = "auto";
    const before = workspaces.getWorkspaceRuntimeStats().rustWorkspaceTree;
    started = performance.now();
    const rustTree = await workspaces.getWorkspaceTree(workspace.id, settings, "");
    const rustContext = await workspaces.getWorkspaceContext(workspace.id, settings, { paths: contextPaths });
    const rustColdMs = performance.now() - started;
    started = performance.now();
    const cachedTree = await workspaces.getWorkspaceTree(workspace.id, settings, "");
    const cachedContext = await workspaces.getWorkspaceContext(workspace.id, settings, { paths: contextPaths });
    const rustWarmMs = performance.now() - started;
    const after = workspaces.getWorkspaceRuntimeStats().rustWorkspaceTree;
    const persistent = process.env.VIBELINK_RUST_WORKSPACE_TREE_SESSION !== "0";
    const sessionStarts = delta(after.session, before.session, "starts");
    const sessionFailures = delta(after.session, before.session, "failures");
    const sessionFallbacks = delta(after.session, before.session, "fallbacks");
    const drain = await workspaces.closeRustWorkspaceTreeSidecar();
    const closed = workspaces.getWorkspaceRuntimeStats().rustWorkspaceTree;
    const expectedRoutes = contextPaths.length + 1;
    const checks = [
      { name: "tree metadata parity", pass: isDeepStrictEqual(rustTree.items, nodeTree.items), detail: `${rustTree.items.length} Rust items vs ${nodeTree.items.length} Node items` },
      { name: "context parity", pass: isDeepStrictEqual(rustContext.items, nodeContext.items), detail: `${rustContext.items.length} Rust contexts vs ${nodeContext.items.length} Node contexts` },
      { name: "warm result parity", pass: isDeepStrictEqual(cachedTree.items, rustTree.items) && isDeepStrictEqual(cachedContext.items, rustContext.items), detail: "second route returned the same tree and contexts" },
      { name: "auto readiness", pass: after.mode === "auto" && after.available === true, detail: `mode=${after.mode}, available=${after.available}` },
      { name: "Rust route count", pass: delta(after, before, "hits") === expectedRoutes && delta(after, before, "cacheMisses") === expectedRoutes, detail: `${delta(after, before, "hits")} hits and ${delta(after, before, "cacheMisses")} misses for ${expectedRoutes} routes` },
      { name: "warm cache reuse", pass: delta(after, before, "cacheHits") === expectedRoutes, detail: `${delta(after, before, "cacheHits")} cache hits for ${expectedRoutes} repeated routes` },
      { name: "fallback rate", pass: delta(after, before, "failures") === 0 && delta(after, before, "fallbacks") === 0, detail: `${delta(after, before, "failures")} failures, ${delta(after, before, "fallbacks")} fallbacks` },
      { name: "persistent sidecar reuse", pass: !persistent || (sessionStarts === 1 && drain.closed), detail: `${sessionStarts} start(s), closed=${drain.closed}` },
      { name: "session fallback rate", pass: !persistent || (sessionFailures === 0 && sessionFallbacks === 0), detail: `${sessionFailures} failures, ${sessionFallbacks} fallbacks` },
      { name: "session pending drain", pass: !persistent || (Number(after.session?.client?.pending || 0) === 0 && Number(closed.session?.client?.pending || 0) === 0 && closed.session?.client?.terminated === true), detail: `${after.session?.client?.pending || 0} before close, ${closed.session?.client?.pending || 0} after, terminated=${closed.session?.client?.terminated}` },
      { name: "warm latency", pass: rustWarmMs <= maxWarmMs, detail: `${roundMs(rustWarmMs)}ms; limit ${maxWarmMs}ms` }
    ];
    const result = {
      generatedAt: new Date().toISOString(), workspace: workspaceRoot, dataDir, command,
      workload: { rootItems: rustTree.items.length, contextPaths, routes: expectedRoutes },
      timings: {
        nodeMs: roundMs(nodeMs), rustColdMs: roundMs(rustColdMs), rustWarmMs: roundMs(rustWarmMs),
        coldVsNodeRatio: nodeMs > 0 ? Number((rustColdMs / nodeMs).toFixed(2)) : 0
      },
      rust: {
        hits: delta(after, before, "hits"), cacheMisses: delta(after, before, "cacheMisses"), cacheHits: delta(after, before, "cacheHits"),
        failures: delta(after, before, "failures"), fallbacks: delta(after, before, "fallbacks"), budgetHits: delta(after, before, "budgetHits"), lastError: after.lastError,
        session: {
          enabled: persistent,
          starts: sessionStarts,
          failures: sessionFailures,
          fallbacks: sessionFallbacks,
          requests: Number(closed.session?.client?.requests || 0),
          responses: Number(closed.session?.client?.responses || 0),
          pending: Number(closed.session?.client?.pending || 0),
          terminated: closed.session?.client?.terminated === true
        }
      },
      evaluation: { passed: checks.every((check) => check.pass), checks }
    };

    const output = stringArg("--output", "");
    if (output) {
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    if (flag("--json")) console.log(JSON.stringify(result, null, 2));
    else printSummary(result);
    process.exitCode = result.evaluation.passed ? 0 : 1;
  } finally {
    await workspaces.closeRustWorkspaceTreeSidecar().catch(() => {});
    await db.drainEventStoreRuntime().catch(() => {});
    try {
      db.initDb().close();
    } catch {
      // The process is exiting; cleanup remains best effort.
    }
    if (flag("--delete-temp")) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[real-canary] temp cleanup skipped: ${error.message}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
