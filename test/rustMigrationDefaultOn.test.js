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
  assert.ok(readiness.blockerIds.includes("workspace-git-command-approval"));
  assert.ok(readiness.blockerIds.includes("native-release-entry"));
  assert.ok(readiness.blockerIds.some((id) => id.startsWith("ownership-")));
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

test("portable packaging gates rust-only output before omitting Node assets", () => {
  const source = fs.readFileSync(new URL("../tools/windows/package-portable.ps1", import.meta.url), "utf8");
  assert.match(source, /ValidateSet\("hybrid", "rust-only"\)/);
  assert.match(source, /check-node-removal-readiness\.mjs/);
  assert.match(source, /Test-RustOnlyPackageContents/);
  assert.match(source, /Test-RustOnlyStartupCanary/);
  assert.match(source, /if \(\$RuntimeFlavor -eq "hybrid"\)[\s\S]*runtime\\node\.exe/);
  assert.match(source, /windows-x64-rust-only\.zip/);
});
