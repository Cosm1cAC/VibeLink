import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { rustBinaryIsCurrent } from "./rustTestSupport.js";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(root, "apps", "windows", "src");
const binary = path.join(root, "apps", "windows", "target", "debug", process.platform === "win32" ? "vibelink.exe" : "vibelink");

async function waitFor(url, options) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(1_000) });
      if (response.status !== 503) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Rust-only discovery server did not become ready: ${url}`);
}

function descendantNodeProcesses(pid) {
  if (process.platform !== "win32") return [];
  const script = `$bad=@(); function Visit([int]$p){$children=@(Get-CimInstance Win32_Process -Filter \"ParentProcessId = $p\" -ErrorAction SilentlyContinue); foreach($child in $children){if($child.Name -ieq \"node.exe\"){$bad += $child.ExecutablePath}; Visit $child.ProcessId}}; Visit ${pid}; $bad | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const value = JSON.parse(result.stdout);
  return Array.isArray(value) ? value : [value];
}

test("Web and Android consume Rust-owned discovery without a Node backend", { timeout: 300_000 }, async (t) => {
  const cargo = process.env.CARGO || path.join(os.homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  if (!fs.existsSync(cargo)) return t.skip("cargo is not available");
  if (!rustBinaryIsCurrent(binary, sourceRoot)) {
    const build = spawnSync(cargo, ["build", "--manifest-path", "apps/windows/Cargo.toml"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-rust-only-discovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "home", ".vibelink", "skills", "e2e"), { recursive: true });
  fs.writeFileSync(path.join(directory, "home", ".vibelink", "skills", "e2e", "SKILL.md"), "---\nname: e2e\ndescription: E2E skill\n---\nRun E2E.");
  fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ pairingToken: "PAIR", hostAllowlist: ["127.0.0.1"] }));
  const database = new DatabaseSync(path.join(directory, "mobile-agent.sqlite"));
  database.exec("CREATE TABLE devices (id TEXT, label TEXT, token_hash TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT, expires_at TEXT, rotated_at TEXT, meta_json TEXT); CREATE TABLE mcp_tools (server_name TEXT, tool_name TEXT, full_name TEXT PRIMARY KEY, title TEXT, description TEXT, input_schema TEXT);");
  const hash = crypto.createHash("sha256").update("device-token").digest("hex");
  database.prepare("INSERT INTO devices VALUES (?, ?, ?, '', '', NULL, ?, NULL, '{}')").run("device", "Web E2E", hash, "2099-01-01T00:00:00.000Z");
  database.prepare("INSERT INTO mcp_tools VALUES (?, ?, ?, ?, ?, ?)").run("memory", "search", "mcp__memory__search", "Search", "Search graph", "{\"type\":\"object\"}");
  database.close();

  const child = spawn(binary, ["--host", "127.0.0.1", "--port", "0", "rust-only", "--data-dir", directory], {
    cwd: root,
    env: { ...process.env, HOME: path.join(directory, "home"), USERPROFILE: path.join(directory, "home") },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(() => {
    if (child.exitCode !== null) return;
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  });

  const startupDeadline = Date.now() + 15_000;
  let port = 0;
  while (Date.now() < startupDeadline && port === 0) {
    if (child.exitCode !== null) throw new Error(`Rust-only discovery server exited during startup.\n${logs}`);
    const match = logs.match(/Rust-only HTTP server listening on 127\.0\.0\.1:(\d+)/);
    port = Number(match?.[1] || 0);
    if (port === 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(port > 0, `Rust-only discovery server did not become ready.\n${logs}`);
  const openApiResponse = await fetch(`http://127.0.0.1:${port}/api/openapi.json`);
  assert.equal(openApiResponse.status, 200);
  assert.equal(openApiResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.match(openApiResponse.headers.get("content-type") || "", /^application\/json/);
  const openApi = await openApiResponse.json();
  assert.equal(openApi.openapi, "3.0.3");
  assert.equal(openApi.info.title, "VibeLink HTTP API");
  assert.ok(openApi.paths["/api/status"]);

  const headers = { Authorization: "Bearer device-token" };
  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`, { headers });
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.headers.get("x-vibelink-control-plane"), "rust");
  const status = await statusResponse.json();
  assert.equal(status.ok, true);
  assert.ok(status.security.devices.some((device) => device.id === "device"));

  const providerResponse = await fetch(`http://127.0.0.1:${port}/api/provider-registry`, { headers });
  assert.equal(providerResponse.status, 200);
  assert.equal(providerResponse.headers.get("x-vibelink-control-plane"), "rust");
  const providerRegistry = await providerResponse.json();
  assert.equal(providerRegistry.version, 2);
  assert.equal(providerRegistry.defaultProvider, "codex");
  assert.deepEqual(providerRegistry.providers.map((provider) => provider.id), ["codex", "claude", "doubao", "zhipu"]);

  const toolsResponse = await waitFor(`http://127.0.0.1:${port}/api/tool-registry`, { headers });
  assert.equal(toolsResponse.status, 200);
  assert.equal(toolsResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.ok((await toolsResponse.json()).items.some((item) => item.name === "mcp__memory__search"));

  const commandsResponse = await fetch(`http://127.0.0.1:${port}/api/command-registry?filter=e2e`, { headers });
  assert.equal(commandsResponse.status, 200);
  assert.equal(commandsResponse.headers.get("x-vibelink-control-plane"), "rust");
  assert.equal((await commandsResponse.json()).items[0].id, "skill:e2e");
  assert.deepEqual(descendantNodeProcesses(child.pid), []);

  const gradleCommand = process.platform === "win32" ? "cmd.exe" : "./gradlew";
  const gradleArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "gradlew.bat", "--no-daemon", "--max-workers=1", ":app:testDebugUnitTest", "--tests", "com.vibelink.app.network.ApiClientRustOnlyDiscoveryE2eTest"]
    : ["--no-daemon", "--max-workers=1", ":app:testDebugUnitTest", "--tests", "com.vibelink.app.network.ApiClientRustOnlyDiscoveryE2eTest"];
  const gradle = spawnSync(gradleCommand, gradleArgs, {
    cwd: path.join(root, "apps", "android"),
    env: {
      ...process.env,
      VIBELINK_RUST_ONLY_E2E_URL: `http://127.0.0.1:${port}`,
      VIBELINK_RUST_ONLY_E2E_TOKEN: "device-token"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000
  });
  assert.equal(gradle.status, 0, gradle.error?.message || gradle.stderr || gradle.stdout);
});
