import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createLiveCallSession, stopLiveCallSession } from "../src/liveCall.js";
import {
  getLiveCallAudioMetrics,
  handleLiveCallAudioConnection,
  resetLiveCallAudioMetrics
} from "../src/liveCallAudio.js";

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
    this.bufferedAmount = 0;
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
}

test("live call audio metrics count frames and oversized drops", () => {
  resetLiveCallAudioMetrics();
  const session = createLiveCallSession({
    title: "Audio metrics test",
    source: "node-test",
    asrProvider: "mock"
  });
  const ws = new FakeWebSocket();

  try {
    handleLiveCallAudioConnection(session.id, ws, {});
    ws.emit("message", Buffer.from(JSON.stringify({ sampleRate: 16000, channels: 1, device: "remote" })), false);
    ws.emit("message", Buffer.alloc(320), true);
    ws.emit("message", Buffer.alloc(1024 * 1024 + 1), true);
    ws.close(1000, "test-done");

    const metrics = getLiveCallAudioMetrics();
    const sessionMetrics = metrics.sessions.find((item) => item.sessionId === session.id);

    assert.equal(metrics.connections, 1);
    assert.equal(metrics.activeConnections, 0);
    assert.equal(metrics.frames, 1);
    assert.equal(metrics.bytes, 320);
    assert.equal(metrics.droppedFrames, 1);
    assert.equal(metrics.oversizedFrames, 1);
    assert.equal(sessionMetrics.frames, 1);
    assert.equal(sessionMetrics.bytes, 320);
    assert.equal(sessionMetrics.oversizedFrames, 1);
  } finally {
    stopLiveCallSession(session.id, "test-cleanup");
  }
});

test("live call audio drops frames when websocket backpressure is high", () => {
  resetLiveCallAudioMetrics();
  const session = createLiveCallSession({
    title: "Audio backpressure test",
    source: "node-test",
    asrProvider: "mock"
  });
  const ws = new FakeWebSocket();
  ws.bufferedAmount = 2 * 1024 * 1024;

  try {
    handleLiveCallAudioConnection(session.id, ws, {});
    ws.emit("message", Buffer.from(JSON.stringify({ sampleRate: 16000, channels: 1, device: "remote" })), false);
    ws.emit("message", Buffer.alloc(320), true);
    ws.close(1000, "test-done");

    const metrics = getLiveCallAudioMetrics();
    const sessionMetrics = metrics.sessions.find((item) => item.sessionId === session.id);

    assert.equal(metrics.frames, 0);
    assert.equal(metrics.bytes, 0);
    assert.equal(metrics.droppedFrames, 1);
    assert.equal(metrics.backpressureFrames, 1);
    assert.equal(metrics.maxBufferedAmount, 2 * 1024 * 1024);
    assert.equal(sessionMetrics.backpressureFrames, 1);
    assert.equal(sessionMetrics.maxBufferedAmount, 2 * 1024 * 1024);
    assert.equal(ws.sent.some((item) => item.type === "drop" && item.reason === "backpressure"), true);
  } finally {
    stopLiveCallSession(session.id, "test-cleanup");
  }
});
