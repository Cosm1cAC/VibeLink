import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  defaultOnPolicyErrors,
  nodeRuntimeReadiness,
  ownershipReadiness
} from "../tools/rust-migration-policy.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../docs/rust-migration-status.json", import.meta.url), "utf8"));
const windowsMain = fs.readFileSync(new URL("../apps/windows/src/main.rs", import.meta.url), "utf8");

test("every default Rust route is declared default-on and backed by the default profile", () => {
  assert.deepEqual(defaultOnPolicyErrors(manifest, windowsMain), []);
  const defaultOn = manifest.slices.filter((slice) => slice.status === "default-on").map((slice) => slice.id);
  assert.ok(defaultOn.includes("rust-http-frontdoor"));
  assert.ok(defaultOn.includes("event-sync-http-route"));
  assert.ok(defaultOn.includes("tool-events-sse-http-route"));
});

test("Node-free packaging remains blocked until every product owner is native", () => {
  const readiness = nodeRuntimeReadiness(manifest);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.blockerIds.includes("workspace-git-command-approval"), false);
  assert.ok(readiness.blockerIds.includes("native-release-entry"));
  assert.ok(readiness.blockerIds.some((id) => id.startsWith("ownership-")));
});

test("rust-only acceptance requires every Phase 4 product family", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const required = new Set(ownership.rustOnlyAcceptance.requiredFamilies);
  const phase4Families = [
    "agent-reach",
    "artifacts",
    "attachments",
    "automations",
    "browser-sessions",
    "capabilities",
    "desktop-remote",
    "desktop-remote-control",
    "discovery",
    "doubao",
    "files",
    "openapi",
    "push",
    "reviews",
    "subagents"
  ];

  assert.deepEqual(phase4Families.filter((id) => !required.has(id)), []);
  assert.deepEqual(
    ownership.publicRouteFamilies
      .filter((family) => family.requiredForRustOnly !== false && !required.has(family.id))
      .map((family) => family.id),
    []
  );
});

test("rust-only acceptance reports missing and duplicate required family declarations", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const openapi = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  const forged = {
    ...ownership,
    rustOnlyAcceptance: {
      ...ownership.rustOnlyAcceptance,
      requiredFamilies: [...ownership.rustOnlyAcceptance.requiredFamilies, "reviews", "missing-family"]
    }
  };

  const readiness = ownershipReadiness(forged, openapi);
  const blocker = readiness.blockers.find((item) => item.id === "ownership-rust-only-acceptance-incomplete");
  assert.ok(blocker);
  assert.ok(blocker.nodeEntries.includes("duplicate family: reviews"));
  assert.ok(blocker.nodeEntries.includes("missing family: missing-family"));
});

test("artifact and attachment routes are declared Rust-owned once the native frontdoor handles them", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const byId = new Map(ownership.publicRouteFamilies.map((family) => [family.id, family]));

  assert.equal(byId.get("artifacts").owner, "rust");
  assert.equal(byId.get("artifacts").status, "default-on");
  assert.equal(byId.get("attachments").owner, "rust");
  assert.equal(byId.get("attachments").status, "default-on");
  assert.deepEqual(
    ownership.responsibilities.find((responsibility) => responsibility.id === "artifact-storage-runtime"),
    { id: "artifact-storage-runtime", owner: "rust", status: "required-for-rust-only" }
  );
});

test("tool and command discovery routes are Rust-owned once the native frontdoor handles them", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const discovery = ownership.publicRouteFamilies.find((family) => family.id === "discovery");
  const readiness = nodeRuntimeReadiness(manifest);
  const diff = readiness.blockers.find((blocker) => blocker.id === "ownership-runtime-registry-diff");

  assert.equal(discovery.owner, "rust");
  assert.equal(discovery.status, "default-on");
  assert.deepEqual(discovery.rustOnlyE2E, {
    web: ["test/rustOnlyDiscoveryE2e.test.js"],
    android: ["apps/android/app/src/test/java/com/vibelink/app/network/ApiClientRustOnlyDiscoveryE2eTest.kt"]
  });
  for (const evidence of [...discovery.rustOnlyE2E.web, ...discovery.rustOnlyE2E.android]) {
    assert.equal(fs.existsSync(new URL(`../${evidence}`, import.meta.url)), true, evidence);
  }
  assert.equal(readiness.blockerIds.includes("ownership-discovery-not-rust-owned"), false);
  assert.equal(
    (diff?.nodeEntries || []).some((entry) => entry.includes("/api/tool-registry") || entry.includes("/api/command-registry")),
    false
  );
});

test("OpenAPI is served by the Rust-only frontdoor for Web and Android", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const openapi = ownership.publicRouteFamilies.find((family) => family.id === "openapi");

  assert.equal(openapi.owner, "rust");
  assert.equal(openapi.status, "default-on");
  assert.deepEqual(openapi.rustOnlyE2E, {
    web: ["test/rustOnlyDiscoveryE2e.test.js"],
    android: ["apps/android/app/src/test/java/com/vibelink/app/network/ApiClientRustOnlyDiscoveryE2eTest.kt"]
  });
});

test("status is consumed from the Rust-only frontdoor by Web and Android", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const status = ownership.publicRouteFamilies.find((family) => family.id === "status");

  assert.equal(status.owner, "rust");
  assert.equal(status.status, "default-on");
  assert.deepEqual(status.rustOnlyE2E, {
    web: ["test/rustOnlyDiscoveryE2e.test.js"],
    android: ["apps/android/app/src/test/java/com/vibelink/app/network/ApiClientRustOnlyDiscoveryE2eTest.kt"]
  });
});

test("provider registry is consumed from the Rust-only frontdoor by Web and Android", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const providerRegistry = ownership.publicRouteFamilies.find((family) => family.id === "provider-registry");

  assert.equal(providerRegistry.owner, "rust");
  assert.equal(providerRegistry.status, "default-on");
  assert.deepEqual(providerRegistry.rustOnlyE2E, {
    web: ["test/rustOnlyDiscoveryE2e.test.js"],
    android: ["apps/android/app/src/test/java/com/vibelink/app/network/ApiClientRustOnlyDiscoveryE2eTest.kt"]
  });
});

test("doctor is consumed from the Rust-only frontdoor by Web and Android", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const doctor = ownership.publicRouteFamilies.find((family) => family.id === "doctor");

  assert.equal(doctor.owner, "rust");
  assert.equal(doctor.status, "default-on");
  assert.deepEqual(doctor.rustOnlyE2E, {
    web: ["test/rustOnlyDiscoveryE2e.test.js"],
    android: ["apps/android/app/src/test/java/com/vibelink/app/network/ApiClientRustOnlyDiscoveryE2eTest.kt"]
  });
});

test("core resource lists are consumed from the Rust-only frontdoor by Web and Android", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const expectedEvidence = {
    web: ["test/rustOnlyDiscoveryE2e.test.js"],
    android: ["apps/android/app/src/test/java/com/vibelink/app/network/ApiClientRustOnlyDiscoveryE2eTest.kt"]
  };

  for (const familyId of ["devices", "settings", "workspaces"]) {
    const family = ownership.publicRouteFamilies.find((item) => item.id === familyId);
    assert.equal(family.owner, "rust", familyId);
    assert.equal(family.status, "default-on", familyId);
    assert.deepEqual(family.rustOnlyE2E, expectedEvidence, familyId);
  }
});

test("artifact, attachment, and file reads use the Rust-only frontdoor on Web and Android", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const expectedEvidence = {
    web: ["test/rustOnlyDiscoveryE2e.test.js"],
    android: ["apps/android/app/src/test/java/com/vibelink/app/network/ApiClientRustOnlyDiscoveryE2eTest.kt"]
  };

  for (const familyId of ["artifacts", "attachments", "files"]) {
    const family = ownership.publicRouteFamilies.find((item) => item.id === familyId);
    assert.equal(family.owner, "rust", familyId);
    assert.equal(family.status, "default-on", familyId);
    assert.deepEqual(family.rustOnlyE2E, expectedEvidence, familyId);
  }
});

test("Desktop Remote observations use the Rust-only frontdoor on Web and Android", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const family = ownership.publicRouteFamilies.find((item) => item.id === "desktop-remote");

  assert.equal(family.owner, "rust");
  assert.equal(family.status, "default-on");
  assert.deepEqual(family.rustOnlyE2E, {
    web: ["test/rustOnlyDiscoveryE2e.test.js"],
    android: ["apps/android/app/src/test/java/com/vibelink/app/network/ApiClientRustOnlyDiscoveryE2eTest.kt"]
  });
});

test("the release gate refuses a rust-only package and reports concrete blockers", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../tools/check-node-removal-readiness.mjs", import.meta.url)),
    "--json"
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.ok(payload.blockers.length >= 5);
});

test("ownership readiness rejects forged manifests with incomplete coverage", () => {
  const openapi = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  const routeOwnership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const forged = {
    ...routeOwnership,
    publicRouteFamilies: routeOwnership.publicRouteFamilies.slice(0, 2).map((family) => ({ ...family, owner: "rust" })),
    internalRouteFamilies: [],
    responsibilities: []
  };
  const readiness = ownershipReadiness(forged, openapi);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockerIds.includes("ownership-openapi-unowned") || readiness.blockerIds.includes("ownership-manifest-stale"));
});

test("ownership manifest, OpenAPI, and runtime registry have no bidirectional route diff", () => {
  const readiness = nodeRuntimeReadiness(manifest);

  assert.equal(readiness.blockerIds.includes("ownership-manifest-stale"), false);
  assert.equal(readiness.blockerIds.includes("ownership-runtime-registry-diff"), false);
});

test("rust-only acceptance reports missing Web and Android E2E evidence per family", () => {
  const readiness = nodeRuntimeReadiness(manifest);
  const blocker = readiness.blockers.find((item) => item.id === "ownership-rust-only-e2e-incomplete");

  assert.ok(blocker);
  assert.ok(blocker.nodeEntries.includes("reviews:web: missing"));
  assert.ok(blocker.nodeEntries.includes("reviews:android: missing"));
  assert.equal(blocker.nodeEntries.some((entry) => entry.startsWith("discovery:")), false);
});

test("ownership comparison treats OpenAPI and runtime path parameters as the same route", () => {
  const readiness = ownershipReadiness({
    publicRouteFamilies: [{
      id: "artifacts",
      owner: "rust",
      prefixes: ["/api/artifacts"]
    }],
    runtimeRoutes: ["GET /api/artifacts/:id"]
  }, {
    paths: {
      "/api/artifacts/{id}": { get: { operationId: "getArtifact" } }
    }
  });

  assert.equal(readiness.blockerIds.includes("ownership-runtime-registry-diff"), false);
});

test("rust-owned families must be backed by Rust runtime routes, not only Node routes", () => {
  const readiness = ownershipReadiness({
    publicRouteFamilies: [{
      id: "reviews",
      owner: "rust",
      prefixes: ["/api/reviews"],
      rustOnlyE2E: {
        web: ["test/rustOnlyDiscoveryE2e.test.js"],
        android: ["apps/android/app/src/test/java/com/vibelink/app/network/ApiClientRustOnlyDiscoveryE2eTest.kt"]
      }
    }],
    rustOnlyAcceptance: {
      requiredFamilies: ["reviews"],
      forbiddenPackageEntries: ["runtime/node.exe"],
      forbiddenProcessNames: ["node.exe"],
      packageSmoke: "tools/rust-only-package-smoke.mjs"
    },
    runtimeRoutes: ["GET /api/reviews"],
    rustRuntimeRoutes: []
  }, {
    paths: {
      "/api/reviews": { get: { operationId: "listReviews" } }
    }
  });

  assert.equal(readiness.blockerIds.includes("ownership-runtime-registry-diff"), false);
  assert.ok(readiness.blockerIds.includes("ownership-reviews-missing-rust-runtime"));
});

test("the native artifact family has no OpenAPI or runtime registry gap", () => {
  const readiness = nodeRuntimeReadiness(manifest);
  const diff = readiness.blockers.find((blocker) => blocker.id === "ownership-runtime-registry-diff");
  const entries = diff?.nodeEntries || [];

  assert.equal(entries.some((entry) => entry.includes("/api/artifacts")), false);
  assert.equal(entries.some((entry) => entry.includes("/api/attachments")), false);
});

test("Desktop Remote observations are Rust-owned without hiding Node-owned desktop control", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const byId = new Map(ownership.publicRouteFamilies.map((family) => [family.id, family]));
  const responsibilities = new Map(ownership.responsibilities.map((responsibility) => [responsibility.id, responsibility]));
  const readiness = nodeRuntimeReadiness(manifest);
  const diff = readiness.blockers.find((blocker) => blocker.id === "ownership-runtime-registry-diff");
  const entries = diff?.nodeEntries || [];

  assert.equal(byId.get("desktop-remote").owner, "rust");
  assert.deepEqual(byId.get("desktop-remote").routes, ["GET /api/desktop-remote/observations"]);
  assert.equal(byId.get("desktop-remote-control").owner, "node");
  assert.deepEqual(responsibilities.get("desktop-observation-runtime"), {
    id: "desktop-observation-runtime",
    owner: "rust",
    status: "default-on"
  });
  assert.equal(responsibilities.get("desktop-remote-control-runtime").owner, "node");
  assert.equal(readiness.blockerIds.includes("ownership-desktop-remote-not-rust-owned"), false);
  assert.ok(readiness.blockerIds.includes("ownership-desktop-remote-control-not-rust-owned"));
  assert.equal(entries.some((entry) => entry.includes("/api/desktop-remote")), false);
  assert.equal(entries.some((entry) => entry.includes("/api/codex-desktop")), false);
});

test("local file downloads are declared Rust-owned once the native frontdoor streams them", () => {
  const ownership = JSON.parse(fs.readFileSync(new URL("../docs/route-ownership.json", import.meta.url), "utf8"));
  const byId = new Map(ownership.publicRouteFamilies.map((family) => [family.id, family]));
  const readiness = nodeRuntimeReadiness(manifest);

  assert.equal(byId.get("files").owner, "rust");
  assert.equal(byId.get("files").status, "default-on");
  assert.equal(readiness.blockerIds.includes("ownership-files-not-rust-owned"), false);
});

test("portable packaging gates rust-only output before omitting Node assets", () => {
  const source = fs.readFileSync(new URL("../tools/windows/package-portable.ps1", import.meta.url), "utf8");
  assert.match(source, /ValidateSet\("hybrid", "rust-only"\)/);
  assert.match(source, /check-node-removal-readiness\.mjs/);
  assert.match(source, /Test-RustOnlyPackageContents/);
  assert.match(source, /Test-RustOnlyStartupCanary/);
  assert.match(source, /if \(\$RuntimeFlavor -eq "hybrid"\)[\s\S]*runtime\\node\.exe/);
  assert.match(source, /windows-x64-rust-only\.zip/);
});
