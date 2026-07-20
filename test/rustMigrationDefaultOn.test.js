import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  defaultOnPolicyErrors,
  nodeRuntimeReadiness
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
  assert.deepEqual(readiness.blockerIds, [
    "workspace-git-command-approval",
    "task-history-terminal",
    "provider-runtime",
    "live-call-runtime",
    "native-release-entry"
  ]);
});

test("the release gate refuses a rust-only package and reports concrete blockers", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../tools/check-node-removal-readiness.mjs", import.meta.url)),
    "--json"
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.blockers.length, 5);
});

test("portable packaging gates rust-only output before omitting Node assets", () => {
  const source = fs.readFileSync(new URL("../tools/windows/package-portable.ps1", import.meta.url), "utf8");
  assert.match(source, /ValidateSet\("hybrid", "rust-only"\)/);
  assert.match(source, /check-node-removal-readiness\.mjs/);
  assert.match(source, /if \(\$RuntimeFlavor -eq "hybrid"\)[\s\S]*runtime\\node\.exe/);
  assert.match(source, /windows-x64-rust-only\.zip/);
});
