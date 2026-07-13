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
    allowLegacyPairingTokenLogin: true,
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

function startServer(dataDir, port, command, doctorHttp, devicesHttp, deviceMutationsHttp, pairingHttp) {
  const args = [
    "--host", "127.0.0.1",
    "--port", String(port),
    "--rust-http-canary",
    "--rust-status-http"
  ];
  if (doctorHttp) args.push("--rust-doctor-http");
  if (devicesHttp) args.push("--rust-devices-http");
  if (deviceMutationsHttp) args.push("--rust-device-mutations-http");
  if (pairingHttp) args.push("--rust-pairing-http");
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
    rateLimit: {
      limit: response.headers.get("x-ratelimit-limit") || "",
      remaining: response.headers.get("x-ratelimit-remaining") || "",
      reset: response.headers.get("x-ratelimit-reset") || "",
      retryAfter: response.headers.get("retry-after") || ""
    },
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
  const devicesHttp = process.argv.includes("--devices-http");
  const deviceMutationsHttp = process.argv.includes("--device-mutations-http");
  const pairingHttp = process.argv.includes("--pairing-http");
  writeSettings(dataDir, port, pairingToken);
  const server = startServer(dataDir, port, command, doctorHttp, devicesHttp, deviceMutationsHttp, pairingHttp);
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
    let activeToken = login.payload.token;
    let mutationEvidence = null;
    if (deviceMutationsHttp) {
      const secondLogin = await request(baseUrl, "/api/login", {
        method: "POST",
        body: { pairingToken, deviceLabel: "device-mutation-target" }
      });
      if (secondLogin.status !== 200 || !secondLogin.payload?.device?.id) {
        throw new Error(`second login failed: ${secondLogin.status} ${JSON.stringify(secondLogin.payload)}`);
      }
      const anonymousMutation = await request(baseUrl, "/api/devices/current/rotate", {
        method: "POST",
        body: {}
      });
      const originalToken = activeToken;
      const rotations = [];
      for (let index = 0; index < 6; index += 1) {
        const rotation = await request(baseUrl, "/api/devices/current/rotate", {
          method: "POST",
          token: activeToken,
          body: {}
        });
        rotations.push(rotation);
        if (rotation.status !== 200 || !rotation.payload?.token) break;
        activeToken = rotation.payload.token;
      }
      const rateDenied = await request(baseUrl, "/api/devices/current/rotate", {
        method: "POST",
        token: activeToken,
        body: {}
      });
      const oldTokenStatus = await request(baseUrl, "/api/status", { token: originalToken });
      const activeTokenStatus = await request(baseUrl, "/api/status", { token: activeToken });
      const revoke = await request(baseUrl, `/api/devices/${encodeURIComponent(secondLogin.payload.device.id)}/revoke`, {
        method: "POST",
        token: activeToken,
        body: {}
      });
      const revokeAgain = await request(baseUrl, `/api/devices/${encodeURIComponent(secondLogin.payload.device.id)}/revoke`, {
        method: "POST",
        token: activeToken,
        body: {}
      });
      const mutationAudit = await request(
        baseUrl,
        "/api/audit-log?limit=40&fields=type,target,deviceId,path,success,reason",
        { token: activeToken }
      );
      mutationEvidence = {
        secondLogin,
        anonymousMutation,
        rotations,
        rateDenied,
        oldTokenStatus,
        activeTokenStatus,
        revoke,
        revokeAgain,
        mutationAudit
      };
    }
    let pairingEvidence = null;
    if (pairingHttp) {
      const created = await request(baseUrl, "/api/pairing-sessions", {
        method: "POST",
        body: { deviceLabel: "pairing-http-canary" }
      });
      if (created.status !== 201 || !created.payload?.session?.id || !created.payload?.session?.code) {
        throw new Error(`pairing create failed: ${created.status} ${JSON.stringify(created.payload)}`);
      }
      const sessionId = created.payload.session.id;
      const pending = await request(baseUrl, `/api/pairing-sessions/${encodeURIComponent(sessionId)}`);
      const adminList = await request(
        baseUrl,
        "/api/pairing-sessions?status=pending&fields=id,status,label",
        { token: activeToken }
      );
      const approved = await request(baseUrl, `/api/pairing-sessions/${encodeURIComponent(sessionId)}/approve`, {
        method: "POST",
        token: activeToken,
        body: {}
      });
      const approvedStatus = await request(baseUrl, `/api/pairing-sessions/${encodeURIComponent(sessionId)}`);
      const claimed = await request(baseUrl, `/api/pairing-sessions/${encodeURIComponent(sessionId)}/claim`, {
        method: "POST",
        body: { code: created.payload.session.code, deviceLabel: "pairing-http-claimed" }
      });
      const claimedStatus = await request(baseUrl, `/api/pairing-sessions/${encodeURIComponent(sessionId)}`);
      const pairingAudit = await request(
        baseUrl,
        "/api/audit-log?limit=30&fields=type,target,deviceId,path,success,reason",
        { token: activeToken }
      );
      pairingEvidence = {
        created,
        sessionId,
        pending,
        adminList,
        approved,
        approvedStatus,
        claimed,
        claimedStatus,
        pairingAudit
      };
    }
    const doctorAnonymous = doctorHttp ? await request(baseUrl, "/api/doctor") : null;
    const doctor = await request(baseUrl, "/api/doctor", { token: activeToken });
    const doctorRuntime = doctor.payload?.controlPlaneRuntime?.doctorHttp || {};
    const doctorToolRun = doctorHttp && doctor.payload?.toolRunId
      ? await request(baseUrl, `/api/tool-runs/${encodeURIComponent(doctor.payload.toolRunId)}`, { token: activeToken })
      : null;
    const audit = doctorHttp
      ? await request(baseUrl, "/api/audit-log?limit=20&fields=type,target,deviceId,path", { token: activeToken })
      : null;
    const devicesAnonymous = devicesHttp ? await request(baseUrl, "/api/devices") : null;
    const devices = devicesHttp ? await request(baseUrl, "/api/devices", { token: activeToken }) : null;
    const devicesFiltered = devicesHttp
      ? await request(baseUrl, "/api/devices?fields=id,label", { token: activeToken })
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
    if (devicesHttp) {
      const filteredItem = devicesFiltered?.payload?.items?.[0] || {};
      const devicesRuntime = devicesFiltered?.payload?.controlPlaneRuntime?.devicesHttp || {};
      checks.push(
        { name: "Rust Devices ownership", pass: devices?.status === 200 && devices.implementation === "rust" && Array.isArray(devices.payload?.items) && devices.payload?.currentDeviceId === login.payload?.device?.id, detail: `status=${devices?.status || 0}, implementation=${devices?.implementation || "node"}, items=${devices?.payload?.items?.length || 0}` },
        { name: "Rust Devices denial", pass: devicesAnonymous?.status === 401 && devicesAnonymous?.implementation === "rust", detail: `status=${devicesAnonymous?.status || 0}, implementation=${devicesAnonymous?.implementation || "node"}` },
        { name: "Rust Devices fields", pass: devicesFiltered?.status === 200 && devicesFiltered.implementation === "rust" && Object.keys(filteredItem).every((key) => key === "id" || key === "label") && Boolean(filteredItem.id), detail: `status=${devicesFiltered?.status || 0}, fields=${Object.keys(filteredItem).join(",") || "missing"}` },
        { name: "Rust Devices fallback", pass: devicesRuntime.attempts === 3 && devicesRuntime.responses === 3 && devicesRuntime.fallbacks === 0 && devicesRuntime.failures === 0 && devicesRuntime.pending === 0, detail: `attempts=${devicesRuntime.attempts}, responses=${devicesRuntime.responses}, fallbacks=${devicesRuntime.fallbacks}, failures=${devicesRuntime.failures}` }
      );
    }
    if (deviceMutationsHttp) {
      const rotations = mutationEvidence?.rotations || [];
      const auditItems = mutationEvidence?.mutationAudit?.payload?.items || [];
      const rotateAudits = auditItems.filter((item) => item.type === "device.rotate" && item.success === true);
      const rateAudit = auditItems.find((item) => item.type === "rate_limit" && item.reason === "device.rotate");
      const revokeAudits = auditItems.filter((item) => item.type === "device.revoke" && item.target === mutationEvidence?.secondLogin?.payload?.device?.id);
      checks.push(
        { name: "Rust Device mutation denial", pass: mutationEvidence?.anonymousMutation?.status === 401 && mutationEvidence.anonymousMutation.implementation === "rust", detail: `status=${mutationEvidence?.anonymousMutation?.status || 0}, implementation=${mutationEvidence?.anonymousMutation?.implementation || "node"}` },
        { name: "Rust Device rotation ownership", pass: rotations.length === 6 && rotations.every((item) => item.status === 200 && item.implementation === "rust" && /^[0-9a-f]{64}$/.test(item.payload?.token || "")), detail: `successful=${rotations.filter((item) => item.status === 200).length}, rust=${rotations.filter((item) => item.implementation === "rust").length}` },
        { name: "Device token replacement", pass: mutationEvidence?.oldTokenStatus?.status === 401 && mutationEvidence?.oldTokenStatus?.implementation === "rust" && mutationEvidence?.activeTokenStatus?.status === 200, detail: `old=${mutationEvidence?.oldTokenStatus?.status || 0}, active=${mutationEvidence?.activeTokenStatus?.status || 0}` },
        { name: "Device rotation rate limit", pass: mutationEvidence?.rateDenied?.status === 429 && mutationEvidence.rateDenied.implementation === "rust" && mutationEvidence.rateDenied.rateLimit.limit === "6" && Boolean(mutationEvidence.rateDenied.rateLimit.retryAfter), detail: `status=${mutationEvidence?.rateDenied?.status || 0}, remaining=${mutationEvidence?.rateDenied?.rateLimit?.remaining || "missing"}, retryAfter=${mutationEvidence?.rateDenied?.rateLimit?.retryAfter || "missing"}` },
        { name: "Rust Device revoke idempotence", pass: mutationEvidence?.revoke?.status === 200 && mutationEvidence.revoke.implementation === "rust" && mutationEvidence.revoke.payload?.ok === true && mutationEvidence?.revokeAgain?.status === 200 && mutationEvidence.revokeAgain.payload?.ok === false, detail: `first=${mutationEvidence?.revoke?.payload?.ok}, second=${mutationEvidence?.revokeAgain?.payload?.ok}` },
        { name: "Device mutation audit", pass: mutationEvidence?.mutationAudit?.status === 200 && rotateAudits.length === 6 && Boolean(rateAudit) && revokeAudits.length === 2, detail: `rotate=${rotateAudits.length}, rateLimit=${Boolean(rateAudit)}, revoke=${revokeAudits.length}` }
      );
    }
    if (pairingHttp) {
      const sessionId = pairingEvidence?.sessionId;
      const listed = pairingEvidence?.adminList?.payload?.items?.find((item) => item.id === sessionId);
      const auditItems = pairingEvidence?.pairingAudit?.payload?.items || [];
      const approveAudit = auditItems.find((item) => item.type === "pairing.approve" && item.target === sessionId && item.success === true);
      const claimAudit = auditItems.find((item) => item.type === "pairing.claim" && item.target === sessionId && item.success === true);
      checks.push(
        { name: "Pairing create Node fallback", pass: pairingEvidence?.created?.status === 201 && pairingEvidence.created.implementation === "", detail: `status=${pairingEvidence?.created?.status || 0}, implementation=${pairingEvidence?.created?.implementation || "node"}` },
        { name: "Rust Pairing public status", pass: pairingEvidence?.pending?.status === 200 && pairingEvidence.pending.implementation === "rust" && pairingEvidence.pending.payload?.session?.status === "pending", detail: `status=${pairingEvidence?.pending?.status || 0}, state=${pairingEvidence?.pending?.payload?.session?.status || "missing"}` },
        { name: "Rust Pairing admin list", pass: pairingEvidence?.adminList?.status === 200 && pairingEvidence.adminList.implementation === "rust" && listed?.status === "pending", detail: `status=${pairingEvidence?.adminList?.status || 0}, listed=${Boolean(listed)}` },
        { name: "Rust Pairing approval", pass: pairingEvidence?.approved?.status === 200 && pairingEvidence.approved.implementation === "rust" && pairingEvidence.approved.payload?.session?.status === "approved" && pairingEvidence?.approvedStatus?.payload?.session?.status === "approved", detail: `status=${pairingEvidence?.approved?.status || 0}, state=${pairingEvidence?.approved?.payload?.session?.status || "missing"}` },
        { name: "Pairing claim Node fallback", pass: pairingEvidence?.claimed?.status === 200 && pairingEvidence.claimed.implementation === "" && /^[0-9a-f]{64}$/.test(pairingEvidence.claimed.payload?.token || ""), detail: `status=${pairingEvidence?.claimed?.status || 0}, implementation=${pairingEvidence?.claimed?.implementation || "node"}` },
        { name: "Rust Pairing claimed status", pass: pairingEvidence?.claimedStatus?.status === 200 && pairingEvidence.claimedStatus.implementation === "rust" && pairingEvidence.claimedStatus.payload?.session?.status === "claimed", detail: `status=${pairingEvidence?.claimedStatus?.status || 0}, state=${pairingEvidence?.claimedStatus?.payload?.session?.status || "missing"}` },
        { name: "Pairing audit continuity", pass: pairingEvidence?.pairingAudit?.status === 200 && Boolean(approveAudit?.deviceId) && Boolean(claimAudit?.deviceId), detail: `approve=${Boolean(approveAudit)}, claim=${Boolean(claimAudit)}` }
      );
    }
    checks.push({ name: "controlled shutdown", pass: shutdown.code === 0 || shutdown.signal === "SIGTERM", detail: `code=${shutdown.code}, signal=${shutdown.signal || "none"}` });
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: { route: ["/api/status", doctorHttp ? "/api/doctor" : "", devicesHttp ? "/api/devices" : "", deviceMutationsHttp ? "/api/devices/*/(rotate|revoke)" : "", pairingHttp ? "/api/pairing-sessions*" : ""].filter(Boolean).join(","), implementation: "rust-http", command },
      runtime,
      doctorRuntime: doctorHttp ? doctorRuntime : undefined,
      deviceMutations: deviceMutationsHttp ? {
        rotations: mutationEvidence?.rotations?.length || 0,
        rateLimited: mutationEvidence?.rateDenied?.status === 429,
        revokeIdempotent: mutationEvidence?.revoke?.payload?.ok === true && mutationEvidence?.revokeAgain?.payload?.ok === false
      } : undefined,
      pairing: pairingHttp ? {
        publicStatus: pairingEvidence?.pending?.payload?.session?.status || "",
        approved: pairingEvidence?.approved?.payload?.session?.status === "approved",
        claimed: pairingEvidence?.claimedStatus?.payload?.session?.status === "claimed"
      } : undefined,
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
