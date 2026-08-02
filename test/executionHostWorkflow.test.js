import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("execution-host workflow builds once and runs the ignored integration plus canary", () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "execution-host-integration.yml"),
    "utf8"
  );

  const build = "cargo build --release --manifest-path apps/windows/Cargo.toml";
  const integration = "terminal_session_uses_execd_and_persists_control_events";
  const canary = "--bin apps/windows/target/release/vibelink.exe";
  assert.ok(workflow.includes(build));
  assert.ok(workflow.includes(integration));
  assert.ok(workflow.includes("--ignored --exact"));
  assert.ok(workflow.includes(canary));
  assert.ok(workflow.indexOf(build) < workflow.indexOf(integration));
  assert.ok(workflow.indexOf(integration) < workflow.indexOf(canary));
});
