#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function counter(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function delta(before, after) {
  return counter(after) - counter(before);
}

function percentile95(values) {
  if (!values.length) return 0;
  const sorted = values.map(Number).sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export function evaluatePublicStatusEvidence({
  anonymousStatus,
  authenticatedStatuses = [],
  baselineRuntime = {},
  finalRuntime = {},
  sampleLatenciesMs = [],
  expectedRequests,
  maxP95Ms
} = {}) {
  const baselineClient = baselineRuntime.client || {};
  const finalClient = finalRuntime.client || {};
  const metrics = {
    p95Ms: percentile95(sampleLatenciesMs),
    attemptDelta: delta(baselineRuntime.attempts, finalRuntime.attempts),
    rustResponseDelta: delta(baselineRuntime.rustResponses, finalRuntime.rustResponses),
    fallbackDelta: delta(baselineRuntime.fallbacks, finalRuntime.fallbacks),
    requestDelta: delta(baselineClient.requests, finalClient.requests),
    responseDelta: delta(baselineClient.responses, finalClient.responses),
    failureDelta: delta(baselineClient.failures, finalClient.failures),
    timeoutDelta: delta(baselineClient.timeouts, finalClient.timeouts),
    backpressureDelta: delta(baselineClient.backpressureRejects, finalClient.backpressureRejects)
  };
  const checks = [
    { name: "anonymous auth", pass: anonymousStatus === 401, detail: `status=${anonymousStatus}` },
    {
      name: "authenticated status",
      pass: authenticatedStatuses.length === expectedRequests + 1 && authenticatedStatuses.every((status) => status === 200),
      detail: `statuses=${authenticatedStatuses.join(",")}`
    },
    {
      name: "Rust readiness",
      pass: finalRuntime.enabled === true && finalRuntime.available === true && finalRuntime.ready === true
        && finalRuntime.failed === false && finalRuntime.mode === "rust-sidecar",
      detail: `mode=${finalRuntime.mode || "unknown"}`
    },
    {
      name: "Rust routing",
      pass: metrics.attemptDelta === expectedRequests && metrics.rustResponseDelta === expectedRequests,
      detail: `attempts=${metrics.attemptDelta}, responses=${metrics.rustResponseDelta}`
    },
    {
      name: "sidecar request parity",
      pass: metrics.requestDelta === expectedRequests && metrics.responseDelta === expectedRequests,
      detail: `requests=${metrics.requestDelta}, responses=${metrics.responseDelta}`
    },
    {
      name: "fallback and failures",
      pass: metrics.fallbackDelta === 0 && metrics.failureDelta === 0 && metrics.timeoutDelta === 0
        && metrics.backpressureDelta === 0 && counter(finalRuntime.fallbacks) === 0
        && counter(finalClient.failures) === 0 && counter(finalClient.timeouts) === 0
        && counter(finalClient.backpressureRejects) === 0 && !finalRuntime.lastError,
      detail: `fallbacks=${counter(finalRuntime.fallbacks)}, failures=${counter(finalClient.failures)}, timeouts=${counter(finalClient.timeouts)}, backpressure=${counter(finalClient.backpressureRejects)}`
    },
    {
      name: "pending drain",
      pass: counter(finalClient.pending) === 0,
      detail: `pending=${counter(finalClient.pending)}`
    },
    {
      name: "public latency",
      pass: sampleLatenciesMs.length === expectedRequests && metrics.p95Ms <= maxP95Ms,
      detail: `p95=${metrics.p95Ms}ms, limit=${maxP95Ms}ms`
    }
  ];

  return { metrics, checks, passed: checks.every((check) => check.pass) };
}

function stringArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function positiveIntegerArg(name, fallback) {
  const value = Number(stringArg(name, fallback));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

export function normalizeCanaryOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--base-url must use HTTP or HTTPS.");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("--base-url must not contain credentials, query parameters, or a fragment.");
  }
  if (url.pathname !== "/") throw new Error("--base-url must be an origin without a path.");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !loopback) throw new Error("--base-url must use HTTPS outside loopback.");
  return url.origin;
}

async function statusRequest(origin, token, timeoutMs) {
  const startedAt = performance.now();
  const response = await fetch(`${origin}/api/status`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`/api/status returned non-JSON content with status ${response.status}.`);
    }
  }
  return { status: response.status, payload, latencyMs };
}

function runtimeEvidence(runtime = {}) {
  return {
    enabled: runtime.enabled === true,
    available: runtime.available === true,
    ready: runtime.ready === true,
    failed: runtime.failed === true,
    mode: String(runtime.mode || ""),
    attempts: counter(runtime.attempts),
    rustResponses: counter(runtime.rustResponses),
    fallbacks: counter(runtime.fallbacks),
    lastError: runtime.lastError ? "[redacted]" : "",
    client: {
      pending: counter(runtime.client?.pending),
      requests: counter(runtime.client?.requests),
      responses: counter(runtime.client?.responses),
      failures: counter(runtime.client?.failures),
      timeouts: counter(runtime.client?.timeouts),
      backpressureRejects: counter(runtime.client?.backpressureRejects),
      terminated: runtime.client?.terminated === true
    }
  };
}

async function main() {
  const origin = normalizeCanaryOrigin(stringArg("--base-url"));
  const expectedRequests = positiveIntegerArg("--requests", 10);
  const maxP95Ms = positiveIntegerArg("--max-p95-ms", 2000);
  const timeoutMs = positiveIntegerArg("--timeout-ms", 10000);
  const token = String(process.env.VIBELINK_PUBLIC_CANARY_TOKEN || "").trim();
  if (!token) throw new Error("VIBELINK_PUBLIC_CANARY_TOKEN is required.");

  const anonymous = await statusRequest(origin, "", timeoutMs);
  const baseline = await statusRequest(origin, token, timeoutMs);
  const samples = [];
  for (let index = 0; index < expectedRequests; index += 1) {
    samples.push(await statusRequest(origin, token, timeoutMs));
  }
  const baselineRuntime = runtimeEvidence(baseline.payload?.controlPlaneRuntime);
  const finalRuntime = runtimeEvidence(samples.at(-1)?.payload?.controlPlaneRuntime);
  const evaluation = evaluatePublicStatusEvidence({
    anonymousStatus: anonymous.status,
    authenticatedStatuses: [baseline.status, ...samples.map((sample) => sample.status)],
    baselineRuntime,
    finalRuntime,
    sampleLatenciesMs: samples.map((sample) => sample.latencyMs),
    expectedRequests,
    maxP95Ms
  });
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: { origin, route: "/api/status", requests: expectedRequests, maxP95Ms },
    runtime: { baseline: baselineRuntime, final: finalRuntime },
    ...evaluation
  };
  const output = stringArg("--output");
  if (output) {
    const outputPath = path.resolve(output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  console.log("Public Status Rust canary");
  for (const check of result.checks) console.log(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  console.log(`Result: ${result.passed ? "PASS" : "FAIL"}`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Public Status canary failed: ${error.message}`);
    process.exitCode = 1;
  });
}
