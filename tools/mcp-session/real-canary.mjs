#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function numberArg(name, fallback) {
  const parsed = Number(stringArg(name, fallback));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
  const release = path.join(rootDir, "apps", "windows", "target", "release", binary);
  if (fs.existsSync(release)) return release;
  return path.join(rootDir, "apps", "windows", "target", "debug", binary);
}

function defaultProject() {
  try {
    const artifact = JSON.parse(fs.readFileSync(path.join(rootDir, ".codebase-memory", "artifact.json"), "utf8"));
    return String(artifact.project || "");
  } catch {
    return "";
  }
}

function roundMs(value) {
  return Number(Number(value || 0).toFixed(1));
}

function printSummary(result) {
  console.log("MCP Rust real-session canary");
  console.log(`- server: ${result.server.id}`);
  console.log(`- tool: ${result.workload.tool}`);
  if (result.workload.project) console.log(`- project: ${result.workload.project}`);
  console.log(`- argument keys: ${result.workload.argumentKeys.join(", ") || "none"}`);
  console.log(`- calls: ${result.workload.calls}`);
  console.log(`- average: ${result.timings.avgMs}ms; max: ${result.timings.maxMs}ms`);
  console.log("\nChecks:");
  for (const check of result.evaluation.checks) {
    console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`\nResult: ${result.evaluation.passed ? "PASS" : "FAIL"}`);
}

async function main() {
  const serverId = stringArg("--server", "codebase-memory-mcp");
  const toolName = stringArg("--tool", "get_architecture");
  const project = stringArg("--project", defaultProject());
  const serverCommand = stringArg("--server-command", "");
  const repeatedServerArgs = repeatedArgs("--server-arg");
  const serverArgs = repeatedServerArgs.length ? repeatedServerArgs : jsonArg("--server-args-json", []);
  const hasExplicitArguments = process.argv.includes("--arguments-json");
  const usesCodebaseDefaults = !serverCommand && !hasExplicitArguments;
  const toolArguments = hasExplicitArguments
    ? jsonArg("--arguments-json", {})
    : usesCodebaseDefaults ? { project, aspects: ["overview"] } : {};
  const calls = numberArg("--calls", 3);
  const timeoutMs = numberArg("--timeout-ms", 120000);
  const command = path.resolve(stringArg("--command", defaultRustCommand()));
  if (usesCodebaseDefaults && !project) throw new Error("A real codebase-memory project is required; pass --project or provide .codebase-memory/artifact.json.");
  if (!Array.isArray(serverArgs) || serverArgs.some((item) => typeof item !== "string")) throw new Error("--server-args-json must be a JSON array of strings.");
  if (!toolArguments || typeof toolArguments !== "object" || Array.isArray(toolArguments)) throw new Error("--arguments-json must be a JSON object.");
  if (!fs.existsSync(command)) throw new Error(`Rust MCP sidecar command is missing: ${command}`);

  process.env.VIBELINK_MCP_RUST_SIDECAR = "auto";
  process.env.VIBELINK_MCP_RUST_SIDECAR_COMMAND = command;
  const runtime = await import("../../src/mcpRuntime.js");
  const settings = serverCommand
    ? {
        codebaseMemory: { autoMcp: false },
        mcp: { servers: [{ id: serverId, name: serverId, type: "stdio", enabled: true, command: serverCommand, args: serverArgs }] }
      }
    : {};
  const server = runtime.configuredMcpServers(settings).find((item) => item.id === serverId || item.name === serverId);
  if (!server) throw new Error(`Real MCP server was not discovered: ${serverId}`);

  try {
    const before = runtime.getMcpRustSidecarStats();
    const probe = await runtime.probeMcpServer(server, { timeoutMs });
    const tool = (probe.tools || []).find((item) => item.name === toolName);
    const samples = [];
    const results = [];
    if (probe.ok && tool) {
      for (let index = 0; index < calls; index += 1) {
        const started = performance.now();
        const result = await runtime.callMcpTool(settings, {
          serverId: server.id,
          toolName,
          arguments: toolArguments
        }, { timeoutMs });
        samples.push(performance.now() - started);
        results.push({ ok: result.ok, status: result.status, contentBlocks: result.content?.length || 0, error: result.error || "" });
      }
    }
    const active = runtime.getMcpRustSidecarStats();
    const drain = await runtime.closeIdlePersistentMcpSessions({ maxIdleMs: 0 });
    const closed = runtime.getMcpRustSidecarStats();
    const starts = Number(active.starts || 0) - Number(before.starts || 0);
    const failures = Number(active.failures || 0) - Number(before.failures || 0);
    const fallbacks = Number(active.fallbacks || 0) - Number(before.fallbacks || 0);
    const checks = [
      { name: "real server discovery", pass: Boolean(server.command), detail: `${server.id} -> ${server.command || "missing command"}` },
      { name: "probe", pass: probe.ok === true && probe.status === "connected" && Number(probe.toolCount || 0) > 0, detail: `status=${probe.status}, tools=${probe.toolCount || 0}` },
      { name: "read-only tool advertised", pass: Boolean(tool), detail: tool ? `${toolName} is available` : `${toolName} is missing` },
      { name: "real tool calls", pass: results.length === calls && results.every((item) => item.ok && item.status === "completed" && item.contentBlocks > 0), detail: `${results.filter((item) => item.ok).length}/${calls} completed with content` },
      { name: "single Rust sidecar", pass: starts === 1, detail: `${starts} sidecar start(s)` },
      { name: "runtime readiness", pass: active.mode === "auto" && active.available && active.ready && !active.failed && !active.lastError, detail: `available=${active.available}, ready=${active.ready}, failed=${active.failed}` },
      { name: "fallback rate", pass: failures === 0 && fallbacks === 0, detail: `${failures} failures, ${fallbacks} fallbacks` },
      { name: "normal-load backpressure", pass: Number(active.client?.backpressureRejects || 0) === 0, detail: `${active.client?.backpressureRejects || 0} rejects` },
      { name: "pending drain", pass: Number(active.client?.pending || 0) === 0 && Number(closed.client?.pending || 0) === 0, detail: `${active.client?.pending || 0} before close, ${closed.client?.pending || 0} after` },
      { name: "clean session close", pass: drain.closed === 1 && drain.remaining === 0 && !closed.active && closed.client?.terminated === true, detail: `${drain.closed} closed, ${drain.remaining} remaining, active=${closed.active}` }
    ];
    const totalMs = samples.reduce((sum, value) => sum + value, 0);
    const result = {
      generatedAt: new Date().toISOString(),
      server: { id: server.id, command: server.command, args: server.args || [] },
      rustCommand: command,
      workload: { tool: toolName, project: usesCodebaseDefaults ? project : "", argumentKeys: Object.keys(toolArguments).sort(), calls },
      probe: { status: probe.status, toolCount: probe.toolCount || 0, tools: (probe.tools || []).map((item) => item.name) },
      calls: results,
      timings: { avgMs: roundMs(samples.length ? totalMs / samples.length : 0), maxMs: roundMs(Math.max(0, ...samples)) },
      runtime: { starts, failures, fallbacks, pending: active.client?.pending || 0, backpressureRejects: active.client?.backpressureRejects || 0, drain },
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
    await runtime.closePersistentMcpSessions().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
