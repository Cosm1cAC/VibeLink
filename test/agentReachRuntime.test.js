import assert from "node:assert/strict";
import test from "node:test";

import { agentReachCommandForAction } from "../src/agentReachRuntime.js";

test("agentReachCommandForAction builds safe Agent Reach commands", () => {
  assert.deepEqual(agentReachCommandForAction("doctor"), ["doctor", "--json"]);
  assert.deepEqual(agentReachCommandForAction("skill", { operation: "uninstall" }), ["skill", "--uninstall"]);
  assert.deepEqual(agentReachCommandForAction("format", { platform: "xhs" }), ["format", "xhs"]);
  assert.deepEqual(agentReachCommandForAction("transcribe", { source: "https://example.com/a.mp3", provider: "auto" }), ["transcribe", "https://example.com/a.mp3", "--provider", "auto"]);
});

test("agentReachCommandForAction rejects unsupported or incomplete actions", () => {
  assert.throws(() => agentReachCommandForAction("install"), /Unsupported Agent Reach action/);
  assert.throws(() => agentReachCommandForAction("format", { platform: "other" }), /platform=xhs/);
  assert.throws(() => agentReachCommandForAction("transcribe"), /requires a source/);
});
