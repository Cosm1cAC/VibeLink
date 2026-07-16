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
  for (const profile of ["release", "debug"]) {
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
    hostAllowlist: [],
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

function startServer(dataDir, port, command, doctorHttp) {
  const args = [
    "--host", "127.0.0.1",
    "--port", String(port),
    "--rust-http-canary",
    "--rust-status-http"
  ];
  if (doctorHttp) args.push("--rust-doctor-http");
  args.push("bridge");
  const child = spawn(command, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      VIBELINK_ROOT: rootDir,
      VIBELINK_DATA_DIR: dataDir,
      VIBELINK_NODE_COMMAND: process.execPath,
      VIBELINK_RUST_STATUS: "0"
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
      // Route ownership is selected when the transparent front door accepts a connection.
      const response = await fetch(`${baseUrl}/api/status`, {
        headers: { Connection: "close" },
        signal: AbortSignal.timeout(1000)
      });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Rust Status HTTP canary did not become ready\n${logs.join("").slice(-4000)}`);
}

async function request(baseUrl, pathname, { method = "GET", token = "", body } = {}) {
  const headers = { "Content-Type": "application/json", Connection: "close" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  return {
    status: response.status,
    implementation: response.headers.get("x-vibelink-control-plane") || "",
    payload: text ? JSON.parse(text) : null
  };
}

async function waitForRustStatus(baseUrl, token, afterAttempts = -1) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const response = await request(baseUrl, "/api/status", { token });
    const runtime = response.payload?.controlPlaneRuntime?.statusHttp;
    if (response.status === 200 && runtime?.implementation === "rust" && runtime.attempts > afterAttempts) {
      return runtime;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Rust did not take ownership of /api/status before the canary deadline");
}

async function exerciseRustDenial(baseUrl, token, baseline) {
  let runtime = baseline;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const anonymous = await request(baseUrl, "/api/status");
    if (anonymous.status === 401 && anonymous.implementation === "rust") {
      runtime = await waitForRustStatus(baseUrl, token, runtime.attempts);
      return { anonymous, runtime };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Rust did not own an anonymous Status denial before the canary deadline");
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

async function removeTempRoot(tempRoot) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function main() {
  const command = path.resolve(stringArg("--command", defaultRustCommand()));
  if (!fs.existsSync(command)) throw new Error(`Rust bridge command is missing: ${command}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-status-http-canary-"));
  const dataDir = path.join(tempRoot, "data");
  const port = await reservePort();
  const pairingToken = crypto.randomBytes(24).toString("hex");
  const doctorHttp = process.argv.includes("--doctor-http");
  writeSettings(dataDir, port, pairingToken);
  const server = startServer(dataDir, port, command, doctorHttp);
  const baseUrl = `http://127.0.0.1:${port}`;
  let shutdown = null;

  try {
    await waitForServer(baseUrl, server.logs);
    const anonymous = await request(baseUrl, "/api/status");
    const login = await request(baseUrl, "/api/login", {
      method: "POST",
      body: { pairingToken, deviceLabel: "status-http-canary" }
    });
    if (login.status !== 200 || !login.payload?.token) {
      throw new Error(`login failed: ${login.status} ${JSON.stringify(login.payload)}`);
    }

    const baseline = await waitForRustStatus(baseUrl, login.payload.token);
    const denial = await exerciseRustDenial(baseUrl, login.payload.token, baseline);
    let runtime = denial.runtime;
    for (let index = 0; index < 3; index += 1) {
      runtime = await waitForRustStatus(baseUrl, login.payload.token, runtime.attempts);
    }
    const doctorAnonymous = doctorHttp ? await request(baseUrl, "/api/doctor") : null;
    const doctor = await request(baseUrl, "/api/doctor", { token: login.payload.token });
    const doctorRuntime = doctor.payload?.controlPlaneRuntime?.doctorHttp || {};
    const doctorToolRun = doctorHttp && doctor.payload?.toolRunId
      ? await request(baseUrl, `/api/tool-runs/${encodeURIComponent(doctor.payload.toolRunId)}`, { token: login.payload.token })
      : null;
    const audit = doctorHttp
      ? await request(baseUrl, "/api/audit-log?limit=20&fields=type,target,deviceId,path", { token: login.payload.token })
      : null;
    shutdown = await stopServer(server);
    const checks = [
      { name: "anonymous auth", pass: anonymous.status === 401, detail: `status=${anonymous.status}` },
      { name: "proxied login", pass: login.status === 200, detail: `status=${login.status}` },
      { name: "Rust Status ownership", pass: runtime.implementation === "rust" && runtime.attempts - denial.runtime.attempts === 3 && runtime.responses === runtime.attempts, detail: `authenticated direct=${runtime.attempts - denial.runtime.attempts}, attempts=${runtime.attempts}, responses=${runtime.responses}` },
      { name: "Rust Status fallback", pass: runtime.fallbacks === 0 && runtime.failures === 0 && runtime.pending === 0, detail: `fallbacks=${runtime.fallbacks}, failures=${runtime.failures}` },
      { name: "Rust Status denial", pass: denial.anonymous.status === 401 && denial.anonymous.implementation === "rust" && denial.runtime.unauthorized - baseline.unauthorized === 1, detail: `status=${denial.anonymous.status}, implementation=${denial.anonymous.implementation || "node"}, unauthorized delta=${denial.runtime.unauthorized - baseline.unauthorized}` }
    ];
    if (doctorHttp) {
      const auditItem = audit?.payload?.items?.find((item) => item.type === "system.doctor" && item.target === doctor.payload?.toolRunId);
      checks.push(
        { name: "Rust Doctor ownership", pass: doctor.status === 200 && doctor.implementation === "rust" && Array.isArray(doctor.payload?.checks) && Boolean(doctor.payload?.toolRunId), detail: `status=${doctor.status}, implementation=${doctor.implementation || "node"}, checks=${doctor.payload?.checks?.length || 0}` },
        { name: "Rust Doctor denial", pass: doctorAnonymous?.status === 401 && doctorAnonymous?.implementation === "rust" && doctorRuntime.unauthorized === 1, detail: `status=${doctorAnonymous?.status || 0}, implementation=${doctorAnonymous?.implementation || "node"}, unauthorized=${doctorRuntime.unauthorized}` },
        { name: "Rust Doctor fallback", pass: doctorRuntime.attempts === 2 && doctorRuntime.responses === 2 && doctorRuntime.fallbacks === 0 && doctorRuntime.failures === 0, detail: `attempts=${doctorRuntime.attempts}, responses=${doctorRuntime.responses}, fallbacks=${doctorRuntime.fallbacks}, failures=${doctorRuntime.failures}` },
        { name: "Doctor tool run", pass: doctorToolRun?.status === 200 && doctorToolRun.payload?.toolRun?.id === doctor.payload?.toolRunId && doctorToolRun.payload?.toolRun?.toolName === "system.doctor", detail: `status=${doctorToolRun?.status || 0}, tool=${doctorToolRun?.payload?.toolRun?.toolName || "missing"}` },
        { name: "Doctor audit", pass: audit?.status === 200 && Boolean(auditItem?.deviceId) && auditItem?.path === "/api/doctor", detail: `status=${audit?.status || 0}, device=${auditItem?.deviceId || "missing"}, path=${auditItem?.path || "missing"}` }
      );
    } else {
      checks.push({ name: "Node Doctor forwarding", pass: doctor.status === 200 && doctor.implementation === "" && Array.isArray(doctor.payload?.checks), detail: `status=${doctor.status}, checks=${doctor.payload?.checks?.length || 0}` });
    }
    checks.push({ name: "controlled shutdown", pass: shutdown.code === 0 || shutdown.signal === "SIGTERM", detail: `code=${shutdown.code}, signal=${shutdown.signal || "none"}` });
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: { route: doctorHttp ? "/api/status,/api/doctor" : "/api/status", implementation: "rust-http", command },
      runtime,
      doctorRuntime: doctorHttp ? doctorRuntime : undefined,
      shutdown,
      checks,
      passed: checks.every((check) => check.pass)
    };
    const output = stringArg("--output", "");
    if (output) {
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    console.log("Status Rust HTTP canary");
    for (const check of checks) console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    console.log(`Result: ${result.passed ? "PASS" : "FAIL"}`);
    if (!result.passed) process.exitCode = 1;
  } finally {
    if (!shutdown) await stopServer(server);
    if (process.argv.includes("--delete-temp")) await removeTempRoot(tempRoot);
  }
}

await main();
