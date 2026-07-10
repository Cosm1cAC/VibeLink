import assert from "node:assert/strict";
import test from "node:test";

import {
  createLiveCallSession,
  listLiveCallEvents,
  pauseLiveCallSession,
  recordLiveCallTranscript,
  resumeLiveCallSession,
  setLiveCallQuestionHook,
  stopLiveCallSession
} from "../src/liveCall.js";
import {
  getActiveAsrProviderId,
  getLiveCallAsrCheckpoints,
  getLiveCallAsrMetrics,
  ingestLiveCallAudio,
  listAsrProviders,
  recoverLiveCallAsrFromCheckpoints,
  resetLiveCallAsrMetrics,
  setActiveAsrProvider
} from "../src/liveCallAsr.js";

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

test("live call question hook receives the stable question event", () => {
  const session = createLiveCallSession({
    title: "Question event correlation test",
    source: "node-test",
    asrProvider: "mock"
  });
  let hookEvent = null;
  let hookBody = null;
  const teardown = setLiveCallQuestionHook(session.id, (_question, _session, event, body) => {
    hookEvent = event;
    hookBody = body;
  });

  recordLiveCallTranscript(session.id, {
    text: "How should we explain this project?",
    final: true,
    speaker: "remote",
    agent: "codex",
    model: "gpt-5.5"
  });

  const questionEvent = listLiveCallEvents(session.id, { limit: 20 }).find((event) => event.type === "live_call.question.detected");
  assert.equal(hookEvent?.id, questionEvent.id);
  assert.equal(hookEvent?.cursor, questionEvent.cursor);
  assert.equal(hookBody?.agent, "codex");
  assert.equal(hookBody?.model, "gpt-5.5");

  teardown();
  stopLiveCallSession(session.id, "test-cleanup");
});

test("live call sessions support pause resume lifecycle events", () => {
  const session = createLiveCallSession({
    title: "Pause resume test",
    source: "node-test",
    asrProvider: "mock"
  });

  assert.equal(pauseLiveCallSession(session.id, "test").status, "paused");
  assert.equal(resumeLiveCallSession(session.id, "test").status, "ready");

  const types = listLiveCallEvents(session.id, { limit: 20 }).map((event) => event.type);
  assert.equal(types.includes("live_call.paused"), true);
  assert.equal(types.includes("live_call.resumed"), true);
  stopLiveCallSession(session.id, "test-cleanup");
});

test("live call ASR provider list and mock ingestion produce transcripts", async () => {
  const providers = listAsrProviders();
  assert.equal(providers.some((provider) => provider.id === "mock" && provider.available), true);

  const session = createLiveCallSession({
    title: "ASR provider test",
    source: "node-test",
    asrProvider: "mock"
  });
  const frame = Buffer.alloc(6400);
  for (let index = 0; index < frame.length; index += 2) {
    frame.writeInt16LE(index % 64 === 0 ? 12000 : 4000, index);
  }

  ingestLiveCallAudio(session.id, {
    channel: "remote",
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm16le",
    buffer: frame
  });
  ingestLiveCallAudio(session.id, { channel: "remote", flush: true });

  const types = listLiveCallEvents(session.id, { limit: 50 }).map((event) => event.type);
  assert.equal(types.includes("live_call.transcript.final"), true);
  stopLiveCallSession(session.id, "test-cleanup");
});

test("live call ASR normalizes audio, segments speech, and records checkpoints", () => {
  const previousProvider = getActiveAsrProviderId();
  setActiveAsrProvider("mock");
  try {
    const session = createLiveCallSession({
      title: "ASR pipeline test",
      source: "node-test",
      asrProvider: "missing-real-provider"
    });
    const silence = Buffer.alloc(4800 * 2 * 2);
    const speech = Buffer.alloc(4800 * 2 * 2);
    for (let index = 0; index < speech.length; index += 2) speech.writeInt16LE(9000, index);

    ingestLiveCallAudio(session.id, {
      channel: "remote",
      sampleRate: 48000,
      channels: 2,
      encoding: "pcm16le",
      buffer: silence
    });
    ingestLiveCallAudio(session.id, {
      channel: "remote",
      sampleRate: 48000,
      channels: 2,
      encoding: "pcm16le",
      buffer: speech
    });
    ingestLiveCallAudio(session.id, {
      channel: "remote",
      sampleRate: 48000,
      channels: 2,
      encoding: "pcm16le",
      buffer: speech
    });
    ingestLiveCallAudio(session.id, {
      channel: "remote",
      sampleRate: 48000,
      channels: 2,
      encoding: "pcm16le",
      buffer: Buffer.alloc(4800 * 2 * 2)
    });
    ingestLiveCallAudio(session.id, { channel: "remote", flush: true });

    const events = listLiveCallEvents(session.id, { limit: 100 });
    const providerEvent = events.find((event) => event.type === "live_call.asr.provider");
    const segmentEvent = events.find((event) => event.type === "live_call.audio_segment");
    const checkpoints = getLiveCallAsrCheckpoints(session.id);
    const recovered = recoverLiveCallAsrFromCheckpoints(session.id);

    assert.equal(providerEvent.provider, "mock");
    assert.equal(providerEvent.fallback, true);
    assert.equal(segmentEvent.sampleRate, 16000);
    assert.equal(segmentEvent.channels, 1);
    assert.ok(segmentEvent.bytes > 0);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].exists, true);
    assert.ok(checkpoints[0].bytes > 0);
    assert.equal(recovered[0].channel, "remote");
    stopLiveCallSession(session.id, "test-cleanup");
  } finally {
    setActiveAsrProvider(previousProvider);
  }
});

test("live call ASR metrics count normalized audio segments", () => {
  resetLiveCallAsrMetrics();
  const previousProvider = getActiveAsrProviderId();
  setActiveAsrProvider("mock");
  try {
    const session = createLiveCallSession({
      title: "ASR metrics test",
      source: "node-test",
      asrProvider: "missing-real-provider"
    });
    const silence = Buffer.alloc(4800 * 2 * 2);
    const speech = Buffer.alloc(4800 * 2 * 2);
    for (let index = 0; index < speech.length; index += 2) speech.writeInt16LE(9000, index);

    ingestLiveCallAudio(session.id, {
      channel: "remote",
      sampleRate: 48000,
      channels: 2,
      encoding: "pcm16le",
      buffer: silence
    });
    ingestLiveCallAudio(session.id, {
      channel: "remote",
      sampleRate: 48000,
      channels: 2,
      encoding: "pcm16le",
      buffer: speech
    });
    ingestLiveCallAudio(session.id, {
      channel: "remote",
      sampleRate: 48000,
      channels: 2,
      encoding: "pcm16le",
      buffer: speech
    });
    ingestLiveCallAudio(session.id, {
      channel: "remote",
      sampleRate: 48000,
      channels: 2,
      encoding: "pcm16le",
      buffer: silence
    });
    ingestLiveCallAudio(session.id, { channel: "remote", flush: true });

    const metrics = getLiveCallAsrMetrics();
    const sessionMetrics = metrics.sessions.find((item) => item.sessionId === session.id);

    assert.ok(metrics.inputBytes > 0);
    assert.ok(metrics.normalizedBytes > 0);
    assert.ok(metrics.segments > 0);
    assert.ok(metrics.providerFeedCalls > 0);
    assert.equal(metrics.ingestDurationSamples, metrics.ingestCalls);
    assert.equal(typeof metrics.avgIngestMs, "number");
    assert.ok(metrics.maxIngestMs >= 0);
    assert.equal(sessionMetrics.providerFallbacks, 1);
    assert.equal(sessionMetrics.ingestDurationSamples, sessionMetrics.ingestCalls);
    assert.equal(sessionMetrics.segments, metrics.segments);
    stopLiveCallSession(session.id, "test-cleanup");
  } finally {
    setActiveAsrProvider(previousProvider);
  }
});
