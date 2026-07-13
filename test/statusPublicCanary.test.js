import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluatePublicStatusEvidence, normalizeCanaryOrigin } from "../tools/status/public-canary.mjs";

test("public status canary requires HTTPS outside loopback", () => {
  assert.throws(() => normalizeCanaryOrigin("http://bridge.example.com"), /HTTPS/);
  assert.equal(normalizeCanaryOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
});

test("public status evidence accepts healthy Rust runtime deltas", () => {
  const baselineRuntime = {
    enabled: true,
    available: true,
    ready: true,
    failed: false,
    mode: "rust-sidecar",
    attempts: 10,
    rustResponses: 10,
    fallbacks: 0,
    lastError: "",
    client: {
      pending: 0,
      requests: 11,
      responses: 11,
      failures: 0,
      timeouts: 0,
      backpressureRejects: 0,
      terminated: false
    }
  };
  const finalRuntime = {
    ...baselineRuntime,
    attempts: 15,
    rustResponses: 15,
    client: {
      ...baselineRuntime.client,
      requests: 16,
      responses: 16
    }
  };

  const result = evaluatePublicStatusEvidence({
    anonymousStatus: 401,
    authenticatedStatuses: [200, 200, 200, 200, 200, 200],
    baselineRuntime,
    finalRuntime,
    sampleLatenciesMs: [82, 91, 95, 104, 118],
    expectedRequests: 5,
    maxP95Ms: 250
  });

  assert.equal(result.passed, true);
  assert.equal(result.metrics.p95Ms, 118);
  assert.equal(result.metrics.rustResponseDelta, 5);
  assert.equal(result.checks.every((check) => check.pass), true);
});

test("public status evidence rejects historical fallback and timeout counters", () => {
  const baselineRuntime = {
    enabled: true,
    available: true,
    ready: true,
    failed: false,
    mode: "rust-sidecar",
    attempts: 10,
    rustResponses: 10,
    fallbacks: 2,
    lastError: "",
    client: {
      pending: 0,
      requests: 11,
      responses: 10,
      failures: 1,
      timeouts: 1,
      backpressureRejects: 0,
      terminated: false
    }
  };
  const finalRuntime = {
    ...baselineRuntime,
    attempts: 12,
    rustResponses: 12,
    client: {
      ...baselineRuntime.client,
      requests: 13,
      responses: 12
    }
  };

  const result = evaluatePublicStatusEvidence({
    anonymousStatus: 401,
    authenticatedStatuses: [200, 200, 200],
    baselineRuntime,
    finalRuntime,
    sampleLatenciesMs: [80, 90],
    expectedRequests: 2,
    maxP95Ms: 250
  });

  assert.equal(result.passed, false);
  assert.equal(result.checks.find((check) => check.name === "fallback and failures")?.pass, false);
});

test("public status evidence rejects p95 above the rollout threshold", () => {
  const runtime = {
    enabled: true,
    available: true,
    ready: true,
    failed: false,
    mode: "rust-sidecar",
    attempts: 2,
    rustResponses: 2,
    fallbacks: 0,
    lastError: "",
    client: {
      pending: 0,
      requests: 3,
      responses: 3,
      failures: 0,
      timeouts: 0,
      backpressureRejects: 0,
      terminated: false
    }
  };
  const result = evaluatePublicStatusEvidence({
    anonymousStatus: 401,
    authenticatedStatuses: [200, 200],
    baselineRuntime: { ...runtime, attempts: 1, rustResponses: 1, client: { ...runtime.client, requests: 2, responses: 2 } },
    finalRuntime: runtime,
    sampleLatenciesMs: [251],
    expectedRequests: 1,
    maxP95Ms: 250
  });

  assert.equal(result.passed, false);
  assert.equal(result.checks.find((check) => check.name === "public latency")?.pass, false);
});

test("public status canary writes secret-safe evidence from an authenticated route", async (t) => {
  const token = crypto.randomBytes(24).toString("hex");
  let attempts = 4;
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url !== "/api/status") {
      response.writeHead(404).end(JSON.stringify({ error: "Not found." }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end(JSON.stringify({ error: "Unauthorized." }));
      return;
    }
    const runtime = {
      enabled: true,
      available: true,
      ready: true,
      failed: false,
      mode: "rust-sidecar",
      attempts,
      rustResponses: attempts,
      fallbacks: 0,
      lastError: "",
      client: {
        pending: 0,
        requests: attempts + 1,
        responses: attempts + 1,
        failures: 0,
        timeouts: 0,
        backpressureRejects: 0,
        terminated: false
      }
    };
    attempts += 1;
    response.writeHead(200).end(JSON.stringify({ ok: true, controlPlaneRuntime: runtime }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-public-status-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const output = path.join(tempRoot, "result.json");
  const child = spawn(process.execPath, [
    path.join("tools", "status", "public-canary.mjs"),
    "--base-url", `http://127.0.0.1:${address.port}`,
    "--requests", "3",
    "--max-p95-ms", "500",
    "--output", output
  ], {
    cwd: process.cwd(),
    env: { ...process.env, VIBELINK_PUBLIC_CANARY_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));

  assert.equal(exitCode, 0, stderr || stdout);
  const evidenceText = fs.readFileSync(output, "utf8");
  const evidence = JSON.parse(evidenceText);
  assert.equal(evidence.passed, true);
  assert.equal(evidence.source.origin, `http://127.0.0.1:${address.port}`);
  assert.equal(evidence.metrics.rustResponseDelta, 3);
  assert.equal(evidenceText.includes(token), false);
});
