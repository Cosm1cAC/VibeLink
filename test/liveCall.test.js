import assert from "node:assert/strict";
import test from "node:test";

import {
  createLiveCallSession,
  listLiveCallEvents,
  recordLiveCallTranscript,
  stopLiveCallSession
} from "../src/liveCall.js";

test("live call sessions preserve workspace and ASR metadata", () => {
  const workspaceId = `ws-test-${Date.now()}`;
  const session = createLiveCallSession({
    title: "Live Call metadata test",
    source: "node-test",
    workspaceId,
    asrProvider: "mock"
  });

  assert.equal(session.workspaceId, workspaceId);
  assert.equal(session.asrProvider, "mock");

  recordLiveCallTranscript(session.id, {
    text: "Please explain one recent project?",
    final: true,
    speaker: "remote"
  });

  const types = new Set(listLiveCallEvents(session.id, { limit: 20 }).map((event) => event.type));
  assert.equal(types.has("live_call.started"), true);
  assert.equal(types.has("live_call.transcript.final"), true);
  assert.equal(types.has("live_call.question.detected"), true);

  const stopped = stopLiveCallSession(session.id, "test-cleanup");
  assert.equal(stopped.status, "stopped");
});
