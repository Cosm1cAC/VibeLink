#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const evidenceKinds = ["provider", "mcp", "terminal", "liveCall", "android"];
const sensitiveKey = /^(?:accessToken|apiKey|authorization|credential|password|refreshToken|secret|token)$/i;
const sensitiveValue = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\bsk-[A-Za-z0-9_-]{8,}|secret[-_:]|password[-_:]|token[-_:])/i;

function fail(message) {
  throw new Error(message);
}

function positiveNumber(value, label, { allowZero = false } = {}) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    fail(`${label} must be ${allowZero ? "a non-negative" : "a positive"} number.`);
  }
}

function rejectSensitiveFields(value, location = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveFields(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && sensitiveValue.test(value)) {
      fail(`Sensitive evidence value found at ${location}.`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key)) fail(`Sensitive evidence field found at ${location}.${key}.`);
    rejectSensitiveFields(item, `${location}.${key}`);
  }
}

function validatePassedEvidence(kind, evidence) {
  if (evidence?.status !== "passed") fail(`${kind} evidence must be passed.`);
  if (!evidence.implementation?.name || !evidence.implementation?.version) {
    fail(`${kind} evidence must include the external implementation name and version.`);
  }
  positiveNumber(evidence.metrics?.requestCount, `${kind}.metrics.requestCount`);
  positiveNumber(evidence.metrics?.fallbackCount, `${kind}.metrics.fallbackCount`, { allowZero: true });
  positiveNumber(evidence.metrics?.failureCount, `${kind}.metrics.failureCount`, { allowZero: true });
  positiveNumber(evidence.metrics?.p95Ms, `${kind}.metrics.p95Ms`, { allowZero: true });
  if (evidence.cleanup?.status !== "passed") fail(`${kind} cleanup must be passed.`);
}

function validateMcpWaiver(evidence) {
  if (evidence?.status !== "not-run" || evidence.reason !== "prerequisite unavailable") {
    fail("mcp evidence must be passed or not-run: prerequisite unavailable.");
  }
  if (!evidence.prerequisite) fail("mcp prerequisite waiver must identify the unavailable prerequisite.");
  if (!evidence.waiver?.approvedBy || !evidence.waiver?.reason) {
    fail("mcp prerequisite waiver must include approvedBy and reason.");
  }
  if (evidence.cleanup?.status !== "not-run") fail("mcp prerequisite waiver cleanup status must be not-run.");
}

function validateNotRunEvidence(kind, evidence) {
  if (evidence?.status !== "not-run" || evidence.reason !== "prerequisite unavailable") {
    fail(`${kind} not-run evidence must use reason: prerequisite unavailable.`);
  }
  if (!evidence.prerequisite) fail(`${kind} not-run evidence must identify the unavailable prerequisite.`);
  if (evidence.cleanup?.status !== "not-run") fail(`${kind} not-run cleanup status must be not-run.`);
}

export function validateReleaseCandidateEvidence(manifest, { releaseCandidate = true, expectedCommit = "" } = {}) {
  rejectSensitiveFields(manifest);
  if (manifest?.schemaVersion !== 1) fail("Evidence manifest schemaVersion must be 1.");
  if (!manifest.capturedAt || !Number.isFinite(Date.parse(manifest.capturedAt))) {
    fail("Evidence manifest must include a valid capturedAt timestamp.");
  }
  if (!/^[0-9a-f]{40,64}$/i.test(manifest.release?.commit || "")) {
    fail("release.commit must be a full Git commit hash.");
  }
  if (expectedCommit && manifest.release.commit.toLowerCase() !== expectedCommit.toLowerCase()) {
    fail(`release.commit does not match expected commit ${expectedCommit}.`);
  }
  if (!/^[0-9a-f]{64}$/i.test(manifest.release?.binary?.sha256 || "")) {
    fail("release.binary.sha256 must be a SHA-256 hash.");
  }
  if (!manifest.release?.binary?.version) fail("release.binary.version is required.");

  const mcpWaived = releaseCandidate && manifest.evidence?.mcp?.status === "not-run";
  const notRun = [];
  for (const kind of evidenceKinds) {
    if (kind === "mcp" && mcpWaived) validateMcpWaiver(manifest.evidence.mcp);
    else if (!releaseCandidate && manifest.evidence?.[kind]?.status === "not-run") {
      validateNotRunEvidence(kind, manifest.evidence[kind]);
      notRun.push(kind);
    } else validatePassedEvidence(kind, manifest.evidence?.[kind]);
  }
  const { provider, mcp, terminal, liveCall, android } = manifest.evidence;
  if (provider.status === "passed") {
    positiveNumber(provider.taskCount, "provider.taskCount");
    positiveNumber(provider.durationSeconds, "provider.durationSeconds");
  }
  if (mcp.status === "passed" && mcp.naturalRun !== true) fail("mcp evidence must be a natural run.");
  if (terminal.status === "passed") {
    positiveNumber(terminal.recoveryCount, "terminal.recoveryCount");
    positiveNumber(terminal.durationSeconds, "terminal.durationSeconds");
  }
  if (liveCall.status === "passed") {
    if (liveCall.weakNetwork !== true) fail("liveCall evidence must exercise a weak network.");
    positiveNumber(liveCall.reconnectCount, "liveCall.reconnectCount");
    positiveNumber(liveCall.durationSeconds, "liveCall.durationSeconds");
  }
  if (android.status === "passed") {
    const checklist = android.checklist || {};
    for (const item of ["physicalDevice", "pairing", "terminalRecovery", "liveCallMicrophone", "cleanup"]) {
      if (checklist[item] !== true) fail(`android.checklist.${item} must be checked.`);
    }
  }

  const result = {
    ok: true,
    releaseCandidate,
    passed: evidenceKinds.filter((kind) => !notRun.includes(kind) && !(kind === "mcp" && mcpWaived)),
    waived: mcpWaived ? ["mcp"] : []
  };
  if (!releaseCandidate) result.notRun = notRun;
  return result;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const manifestPath = path.resolve(argument("--manifest"));
    if (!argument("--manifest")) fail("Missing --manifest.");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    console.log(JSON.stringify(validateReleaseCandidateEvidence(manifest, {
      releaseCandidate: !process.argv.includes("--allow-incomplete"),
      expectedCommit: argument("--expected-commit")
    }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
