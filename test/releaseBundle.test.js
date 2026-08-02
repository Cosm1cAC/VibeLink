import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseBundleMetadata } from "../tools/release/release-bundle.mjs";

function fixture() {
  const commit = "a".repeat(40);
  const hybridSha = "b".repeat(64);
  const rustOnlySha = "c".repeat(64);
  return {
    tag: "v0.1.1",
    commit,
    releaseType: "preview",
    qg003: { decision: "non-blocking", reason: "External prerequisites are unavailable for this preview." },
    packages: {
      hybrid: { sha256: hybridSha, manifest: { version: "0.1.1", commit, runtimeFlavor: "hybrid" } },
      rustOnly: { sha256: rustOnlySha, manifest: { version: "0.1.1", commit, runtimeFlavor: "rust-only" } }
    },
    sbom: { format: "CycloneDX", version: "0.1.1", sha256: "d".repeat(64) },
    audit: { sha256: "e".repeat(64), vulnerabilities: { total: 0, high: 0, critical: 0 } },
    rollback: {
      passed: true,
      stages: [
        { name: "upgrade-to-rust-only", ready: true },
        { name: "process-rollback-to-hybrid", ready: true },
        { name: "re-upgrade-to-rust-only", ready: true }
      ],
      archives: {
        hybrid: { commit, sha256: hybridSha },
        rustOnly: { commit, sha256: rustOnlySha }
      }
    }
  };
}

test("accepts a release bundle whose tag, manifests, hashes, audit, and rollback align", () => {
  const input = fixture();
  assert.deepEqual(validateReleaseBundleMetadata(input), {
    version: "0.1.1",
    commit: input.commit,
    tag: "v0.1.1",
    releaseType: "preview",
    qg003Decision: "non-blocking",
    passed: true
  });
});
