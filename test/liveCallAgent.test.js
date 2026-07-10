import assert from "node:assert/strict";
import test from "node:test";

import { __testInternals } from "../src/liveCallAgent.js";

test("live call agent forwards structured agent text and ignores process noise", () => {
  assert.equal(
    __testInternals.textFromAgentEvent({
      type: "json",
      payload: {
        type: "item.completed",
        item: { type: "agent_message", text: "LIVE_CALL_OK" }
      }
    }),
    "LIVE_CALL_OK"
  );

  assert.equal(__testInternals.textFromAgentEvent({ type: "stderr", text: "WARN noisy log\n" }), "");
  assert.equal(__testInternals.textFromAgentEvent({ type: "stdout", text: "plain process output\n" }), "");
});
