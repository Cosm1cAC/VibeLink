#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function fail(message) {
  throw new Error(message);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function powershellJson(script) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ], { encoding: "utf8" });
  if (result.status !== 0) fail(result.stderr || result.stdout || "PowerShell command failed.");
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function descendantNodeProcesses(pid) {
  return powershellJson(`
    $bad = @()
    function Visit([int]$ParentPid) {
      $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentPid" -ErrorAction SilentlyContinue)
      foreach ($child in $children) {
        if ($child.Name -ieq "node.exe") { $bad += $child.ExecutablePath }
        Visit $child.ProcessId
      }
    }
    Visit ${pid}
    $bad | ConvertTo-Json -Compress
  `) || [];
}

function stopTree(pid) {
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

async function waitForStatus(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`Rust-only package exited during startup with code ${child.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  fail("Rust-only package did not serve /api/status within 30s.");
}

const archive = argValue("--archive");
if (!archive) fail("Missing --archive.");
if (!fs.existsSync(archive)) fail(`Archive not found: ${archive}`);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-rust-only-smoke-"));
try {
  const extract = path.join(tempRoot, "extract");
  fs.mkdirSync(extract, { recursive: true });
  const expand = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${extract.replace(/'/g, "''")}' -Force`
  ], { encoding: "utf8" });
  if (expand.status !== 0) {
    fail(expand.stderr || expand.stdout || "Failed to expand rust-only archive.");
  }

  const forbidden = ["runtime/node.exe", "src/", "node_modules/", "package.json"];
  const entries = [];
  const walk = (dir, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.posix.join(prefix, entry.name);
      entries.push(rel.replace(/\\/g, "/"));
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(extract);

  const violations = forbidden.filter((needle) => entries.some((entry) => entry === needle || entry.startsWith(`${needle}/`)));
  if (violations.length) {
    fail(`Rust-only package still contains forbidden entries: ${violations.join(", ")}`);
  }

  const packageRoot = path.join(extract, "VibeLink");
  const exe = path.join(packageRoot, "vibelink.exe");
  if (!fs.existsSync(exe)) fail("Rust-only package does not contain VibeLink/vibelink.exe.");

  const dataDir = path.join(tempRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const child = spawn(exe, ["--host", "127.0.0.1", "--port", String(port), "run"], {
    cwd: packageRoot,
    env: { ...process.env, VIBELINK_DATA_DIR: dataDir },
    windowsHide: true,
    stdio: "ignore"
  });
  try {
    await waitForStatus(port, child);
    const nodeChildrenValue = descendantNodeProcesses(child.pid);
    const nodeChildren = Array.isArray(nodeChildrenValue)
      ? nodeChildrenValue
      : nodeChildrenValue
        ? [nodeChildrenValue]
        : [];
    if (nodeChildren.length) fail(`Rust-only package spawned Node: ${nodeChildren.join(", ")}`);
  } finally {
    if (child.exitCode === null) stopTree(child.pid);
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
