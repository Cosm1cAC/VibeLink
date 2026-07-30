import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseCandidateEvidence } from "../tools/release/release-candidate-evidence.mjs";

function passedEvidence(overrides = {}) {
  return {
    status: "passed",
    implementation: { name: "external-runtime", version: "1.2.3" },
    metrics: { requestCount: 10, fallbackCount: 0, failureCount: 0, p95Ms: 125 },
    cleanup: { status: "passed" },
    ...overrides
  };
}

function completeManifest() {
  return {
    schemaVersion: 1,
    capturedAt: "2026-07-30T12:00:00.000Z",
    release: {
      commit: "a".repeat(40),
      binary: { sha256: "b".repeat(64), version: "0.1.0" }
    },
    evidence: {
      provider: passedEvidence({ taskCount: 1, durationSeconds: 900 }),
      mcp: passedEvidence({ naturalRun: true }),
      terminal: passedEvidence({ recoveryCount: 1, durationSeconds: 1800 }),
      liveCall: passedEvidence({ weakNetwork: true, reconnectCount: 3, durationSeconds: 600 }),
      android: passedEvidence({
        checklist: {
          physicalDevice: true,
          pairing: true,
          terminalRecovery: true,
          liveCallMicrophone: true,
          cleanup: true
        }
      })
    }
  };
}

test("accepts a complete, sanitized release candidate evidence manifest", () => {
  assert.deepEqual(validateReleaseCandidateEvidence(completeManifest()), {
    ok: true,
    releaseCandidate: true,
    passed: ["provider", "mcp", "terminal", "liveCall", "android"],
    waived: []
  });
});

test("accepts an explicit natural MCP prerequisite waiver", () => {
  const manifest = completeManifest();
  manifest.evidence.mcp = {
    status: "not-run",
    reason: "prerequisite unavailable",
    prerequisite: "codebase-memory-mcp is not installed or the project is not indexed",
    waiver: { approvedBy: "release-owner", reason: "Optional local integration is unavailable." },
    cleanup: { status: "not-run" }
  };

  assert.deepEqual(validateReleaseCandidateEvidence(manifest), {
    ok: true,
    releaseCandidate: true,
    passed: ["provider", "terminal", "liveCall", "android"],
    waived: ["mcp"]
  });
});

test("records unavailable prerequisites without treating them as release evidence", () => {
  const manifest = completeManifest();
  manifest.evidence.provider = {
    status: "not-run",
    reason: "prerequisite unavailable",
    prerequisite: "provider account is unavailable",
    cleanup: { status: "not-run" }
  };

  assert.throws(() => validateReleaseCandidateEvidence(manifest), /provider evidence must be passed/);
  assert.deepEqual(validateReleaseCandidateEvidence(manifest, { releaseCandidate: false }), {
    ok: true,
    releaseCandidate: false,
    passed: ["mcp", "terminal", "liveCall", "android"],
    waived: [],
    notRun: ["provider"]
  });
});

test("rejects sensitive evidence fields before archiving", () => {
  const manifest = completeManifest();
  manifest.evidence.provider.token = "secret-provider-token";
  assert.throws(() => validateReleaseCandidateEvidence(manifest), /sensitive evidence field/i);
});

test("rejects evidence captured for a different release commit", () => {
  assert.throws(
    () => validateReleaseCandidateEvidence(completeManifest(), { expectedCommit: "c".repeat(40) }),
    /does not match expected commit/
  );
});
