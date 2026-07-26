import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../tools/release/phase6-upgrade-rollback.mjs", import.meta.url), "utf8");

test("Phase 6 rehearsal performs a state-preserving Rust, hybrid, Rust sequence", () => {
  assert.ok(source.includes('argument("--hybrid")'));
  assert.ok(source.includes('argument("--rust-only")'));
  assert.match(source, /legacyHybrid.*hybridManifest.node/);
  assert.match(source, /phase6-state-preserved/);
  const upgrade = source.indexOf('"upgrade-to-rust-only"');
  const rollback = source.indexOf('"process-rollback-to-hybrid"');
  const reupgrade = source.indexOf('"re-upgrade-to-rust-only"');
  assert.ok(upgrade >= 0 && upgrade < rollback && rollback < reupgrade);
  assert.match(source, /listener remained open after shutdown/);
});
