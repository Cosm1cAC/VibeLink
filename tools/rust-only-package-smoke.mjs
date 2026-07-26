#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const MAX_DIAGNOSTIC_CHARS = 4_000;
export const RUST_ONLY_READINESS_PATH = "/api/status";
export const RUST_ONLY_SMOKE_DEVICE_TOKEN = "vibelink-rust-only-package-smoke-device";

export function rustOnlyDefaultEntryArgs(port) {
  return [
    "--host",
    "127.0.0.1",
    "--port",
    String(port)
  ];
}

export function rustOnlyServerArgs(port, dataDir) {
  return [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "rust-only",
    "--data-dir",
    dataDir
  ];
}

export function prepareRustOnlySmokeData(dataDir, port, token = RUST_ONLY_SMOKE_DEVICE_TOKEN) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
    pairingToken: "vibelink-rust-only-package-smoke-pairing",
    host: "127.0.0.1",
    port,
    hostAllowlist: ["127.0.0.1"]
  }));
  const database = new DatabaseSync(path.join(dataDir, "mobile-agent.sqlite"));
  try {
    database.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT,
        expires_at TEXT,
        rotated_at TEXT,
        meta_json TEXT
      );
    `);
    database.prepare(`
      INSERT INTO devices (
        id, label, token_hash, created_at, last_seen_at,
        revoked_at, expires_at, rotated_at, meta_json
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?)
    `).run(
      "package-smoke-device",
      "Rust-only package smoke",
      crypto.createHash("sha256").update(token).digest("hex"),
      new Date().toISOString(),
      new Date().toISOString(),
      "2099-01-01T00:00:00.000Z",
      "{}"
    );
  } finally {
    database.close();
  }
}

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

function diagnosticTail(value) {
  return value.length <= MAX_DIAGNOSTIC_CHARS ? value : value.slice(-MAX_DIAGNOSTIC_CHARS);
}

function startupDiagnostics(stdout, stderr) {
  const sections = [];
  if (stdout.trim()) sections.push(`stdout:\n${diagnosticTail(stdout).trim()}`);
  if (stderr.trim()) sections.push(`stderr:\n${diagnosticTail(stderr).trim()}`);
  return sections.length ? `\n${sections.join("\n")}` : "";
}

async function waitForServer(port, child, output, token) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(`Rust-only package exited during startup with code ${child.exitCode}.${startupDiagnostics(output.stdout, output.stderr)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${RUST_ONLY_READINESS_PATH}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000)
      });
      if (response.ok && response.headers.get("x-vibelink-control-plane") === "rust") return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  fail(`Rust-only package did not serve ${RUST_ONLY_READINESS_PATH} from Rust within 30s.${startupDiagnostics(output.stdout, output.stderr)}`);
}

export async function runRustOnlyPackageSmoke(archive) {
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
    const port = await freePort();
    const token = RUST_ONLY_SMOKE_DEVICE_TOKEN;
    prepareRustOnlySmokeData(dataDir, port, token);
    const output = { stdout: "", stderr: "" };
    const child = spawn(exe, rustOnlyDefaultEntryArgs(port), {
      cwd: packageRoot,
      env: {
        ...process.env,
        VIBELINK_DATA_DIR: dataDir,
        VIBELINK_NATIVE_UI_SMOKE_START: "1",
        VIBELINK_NATIVE_UI_SMOKE_EXIT_MS: "60000"
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output.stdout = diagnosticTail(output.stdout + chunk); });
    child.stderr.on("data", (chunk) => { output.stderr = diagnosticTail(output.stderr + chunk); });
    try {
      await waitForServer(port, child, output, token);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prepareDataDir = argValue("--prepare-data");
  if (prepareDataDir) {
    prepareRustOnlySmokeData(
      prepareDataDir,
      Number(argValue("--port")),
      argValue("--token") || RUST_ONLY_SMOKE_DEVICE_TOKEN
    );
  } else {
    await runRustOnlyPackageSmoke(argValue("--archive"));
  }
}
