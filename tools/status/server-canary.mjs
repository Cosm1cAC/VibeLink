#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = path.resolve(import.meta.dirname, "..", "..");

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function defaultRustCommand() {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["debug", "release"]) {
    const command = path.join(rootDir, "apps", "windows", "target", profile, binary);
    if (fs.existsSync(command)) return command;
  }
  return path.join(rootDir, "apps", "windows", "target", "release", binary);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function writeSettings(dataDir, port, pairingToken) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "settings.json"), `${JSON.stringify({
    host: "127.0.0.1",
    port,
    pairingToken,
    defaultCwd: rootDir,
    allowedRoots: [rootDir],
    security: {
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: false,
      requireTrustedWorkspace: false,
      trustedWorkspaces: [rootDir]
    },
    codebaseMemory: { autoMcp: false },
    mcp: { servers: [] },
    toolEvents: { autoPrune: false }
  }, null, 2)}\n`, "utf8");
}

function startServer(dataDir, port, pairingToken, command) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      VIBELINK_DATA_DIR: dataDir,
      MOBILE_AGENT_HOST: "127.0.0.1",
      MOBILE_AGENT_PORT: String(port),
      MOBILE_AGENT_TOKEN: pairingToken,
      VIBELINK_RUST_STATUS: "1",
      VIBELINK_CONTROL_PLANE_RUST_SIDECAR_COMMAND: command,
      VIBELINK_CONTROL_PLANE_RUST_SIDECAR_ARGS_JSON: JSON.stringify(["status-sidecar"])
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

async function waitForServer(baseUrl, logs) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become ready\n${logs.join("").slice(-4000)}`);
}

async function request(baseUrl, pathname, { method = "GET", token = "", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { status: response.status, payload };
}

function stopServer(server) {
  if (server.child.exitCode !== null) return Promise.resolve({ code: server.child.exitCode, signal: null });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (server.child.exitCode === null) server.child.kill();
      resolve({ code: server.child.exitCode, signal: "timeout" });
    }, 10000);
    server.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    server.child.kill("SIGTERM");
  });
}

async function main() {
  const command = path.resolve(stringArg("--command", defaultRustCommand()));
  if (!fs.existsSync(command)) throw new Error(`Rust status command is missing: ${command}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-status-server-canary-"));
  const dataDir = path.join(tempRoot, "data");
  const port = await reservePort();
  const pairingToken = crypto.randomBytes(24).toString("hex");
  writeSettings(dataDir, port, pairingToken);
  const server = startServer(dataDir, port, pairingToken, command);
  const baseUrl = `http://127.0.0.1:${port}`;
  let shutdown = null;

  try {
    await waitForServer(baseUrl, server.logs);
    const anonymous = await request(baseUrl, "/api/status");
    const login = await request(baseUrl, "/api/login", {
      method: "POST",
      body: { pairingToken, deviceLabel: "status-server-canary" }
    });
    if (login.status !== 200 || !login.payload?.token) {
      throw new Error(`login failed: ${login.status} ${JSON.stringify(login.payload)}`);
    }
    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await request(baseUrl, "/api/status", { token: login.payload.token });
      if (response.status !== 200) throw new Error(`status request failed: ${response.status}`);
      statuses.push(response.payload);
    }
    const runtime = statuses.at(-1)?.controlPlaneRuntime || {};
    shutdown = await stopServer(server);
    const checks = [
      { name: "anonymous auth", pass: anonymous.status === 401, detail: `status=${anonymous.status}` },
      { name: "Rust readiness", pass: runtime.enabled && runtime.available && runtime.ready && !runtime.failed, detail: `mode=${runtime.mode}` },
      { name: "Rust routing", pass: runtime.attempts === 2 && runtime.rustResponses === 2, detail: `attempts=${runtime.attempts}, responses=${runtime.rustResponses}` },
      { name: "single sidecar", pass: runtime.client?.requests === 3, detail: `client requests=${runtime.client?.requests}` },
      { name: "fallback rate", pass: runtime.fallbacks === 0 && runtime.client?.failures === 0, detail: `fallbacks=${runtime.fallbacks}, failures=${runtime.client?.failures}` },
      { name: "pending drain", pass: runtime.client?.pending === 0 && runtime.client?.backpressureRejects === 0, detail: `pending=${runtime.client?.pending}` },
      { name: "controlled shutdown", pass: shutdown.code === 0 || shutdown.signal === "SIGTERM", detail: `code=${shutdown.code}, signal=${shutdown.signal || "none"}` }
    ];
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: { route: "/api/status", implementation: "rust-sidecar", command },
      runtime,
      shutdown,
      checks,
      passed: checks.every((check) => check.pass)
    };
    const output = stringArg("--output", "");
    if (output) {
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    console.log("Status Rust server-route canary");
    for (const check of checks) console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    console.log(`Result: ${result.passed ? "PASS" : "FAIL"}`);
    if (!result.passed) process.exitCode = 1;
  } finally {
    if (!shutdown) await stopServer(server);
    if (process.argv.includes("--delete-temp")) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
