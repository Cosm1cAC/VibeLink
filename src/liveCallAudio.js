// Live Call Audio WebSocket bridge.
//
// One WebSocket connection per session at /api/live-calls/:id/audio.
// First message MUST be a JSON header describing the stream:
//   { "sampleRate": 16000, "channels": 1, "encoding": "pcm16le", "device": "remote" }
// Subsequent binary messages are raw PCM frames; periodic JSON messages
// (e.g. { "type": "level", "rms": ..., "peak": ... }) may be interspersed.
//
// Frames are forwarded to:
//
//   - recordLiveCallLevel (per-channel level meter)
//   - the active ASR provider (liveCallAsr) for transcript generation
//
// We don't buffer or resample here — the ASR provider is responsible for
// the audio format it expects (typically 16 kHz mono int16).
//
// The WS is half-duplex in the sense that the bridge only writes acks/acks
// of accepted frames back; clients send data, server replies with JSON
// status messages.

import {
  emitLiveCallEvent,
  getInMemorySession,
  recordLiveCallLevel
} from "./liveCall.js";
import { ingestLiveCallAudio } from "./liveCallAsr.js";

const MAX_FRAME_BYTES = 1 * 1024 * 1024; // 1 MB upper bound per binary frame

function backpressureBytesLimit() {
  const value = Number(process.env.VIBELINK_LIVE_CALL_AUDIO_BACKPRESSURE_BYTES || 1024 * 1024);
  return Number.isFinite(value) && value > 0 ? value : 1024 * 1024;
}

function createAudioMetrics() {
  return {
    connections: 0,
    activeConnections: 0,
    frames: 0,
    bytes: 0,
    droppedFrames: 0,
    oversizedFrames: 0,
    backpressureFrames: 0,
    errors: 0,
    acks: 0,
    maxFrameBytes: 0,
    maxBufferedAmount: 0,
    lastFrameAt: 0,
    totalInterFrameMs: 0,
    interFrameSamples: 0
  };
}

const liveCallAudioMetrics = createAudioMetrics();
const liveCallAudioSessionMetrics = new Map();

function resetMetrics(target) {
  Object.assign(target, createAudioMetrics());
}

function sessionMetrics(sessionId) {
  let metrics = liveCallAudioSessionMetrics.get(sessionId);
  if (!metrics) {
    metrics = createAudioMetrics();
    liveCallAudioSessionMetrics.set(sessionId, metrics);
  }
  return metrics;
}

function publicMetrics(metrics) {
  const avgInterFrameMs = metrics.interFrameSamples
    ? metrics.totalInterFrameMs / metrics.interFrameSamples
    : 0;
  const totalFrames = metrics.frames + metrics.droppedFrames;
  const dropRate = totalFrames > 0 ? metrics.droppedFrames / totalFrames : 0;
  return {
    connections: metrics.connections,
    activeConnections: metrics.activeConnections,
    frames: metrics.frames,
    bytes: metrics.bytes,
    droppedFrames: metrics.droppedFrames,
    dropRate: Number(dropRate.toFixed(4)),
    oversizedFrames: metrics.oversizedFrames,
    backpressureFrames: metrics.backpressureFrames,
    errors: metrics.errors,
    acks: metrics.acks,
    maxFrameBytes: metrics.maxFrameBytes,
    maxBufferedAmount: metrics.maxBufferedAmount,
    avgInterFrameMs: Number(avgInterFrameMs.toFixed(2)),
    lastFrameAt: metrics.lastFrameAt
  };
}

function updateFrameMetrics(metrics, byteLength, now) {
  metrics.frames += 1;
  metrics.bytes += byteLength;
  metrics.maxFrameBytes = Math.max(metrics.maxFrameBytes, byteLength);
  if (metrics.lastFrameAt) {
    metrics.totalInterFrameMs += Math.max(0, now - metrics.lastFrameAt);
    metrics.interFrameSamples += 1;
  }
  metrics.lastFrameAt = now;
}

function recordAudioConnection(sessionId) {
  liveCallAudioMetrics.connections += 1;
  liveCallAudioMetrics.activeConnections += 1;
  const metrics = sessionMetrics(sessionId);
  metrics.connections += 1;
  metrics.activeConnections += 1;
}

function recordAudioDisconnect(sessionId) {
  liveCallAudioMetrics.activeConnections = Math.max(0, liveCallAudioMetrics.activeConnections - 1);
  const metrics = sessionMetrics(sessionId);
  metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
}

function recordAudioFrame(sessionId, byteLength) {
  const now = Date.now();
  updateFrameMetrics(liveCallAudioMetrics, byteLength, now);
  updateFrameMetrics(sessionMetrics(sessionId), byteLength, now);
}

function recordBufferedAmount(sessionId, bufferedAmount) {
  const value = Math.max(0, Number(bufferedAmount) || 0);
  liveCallAudioMetrics.maxBufferedAmount = Math.max(liveCallAudioMetrics.maxBufferedAmount, value);
  const metrics = sessionMetrics(sessionId);
  metrics.maxBufferedAmount = Math.max(metrics.maxBufferedAmount, value);
}

function recordDroppedFrame(sessionId, { oversized = false, backpressure = false } = {}) {
  liveCallAudioMetrics.droppedFrames += 1;
  if (oversized) liveCallAudioMetrics.oversizedFrames += 1;
  if (backpressure) liveCallAudioMetrics.backpressureFrames += 1;
  const metrics = sessionMetrics(sessionId);
  metrics.droppedFrames += 1;
  if (oversized) metrics.oversizedFrames += 1;
  if (backpressure) metrics.backpressureFrames += 1;
}

function recordAudioError(sessionId) {
  liveCallAudioMetrics.errors += 1;
  sessionMetrics(sessionId).errors += 1;
}

function recordAudioAck(sessionId) {
  liveCallAudioMetrics.acks += 1;
  sessionMetrics(sessionId).acks += 1;
}

export function resetLiveCallAudioMetrics() {
  resetMetrics(liveCallAudioMetrics);
  liveCallAudioSessionMetrics.clear();
}

export function getLiveCallAudioMetrics() {
  return {
    ...publicMetrics(liveCallAudioMetrics),
    sessions: [...liveCallAudioSessionMetrics.entries()].map(([sessionId, metrics]) => ({
      sessionId,
      ...publicMetrics(metrics)
    }))
  };
}

function safeSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* ignore broken sockets */
  }
}

export function handleLiveCallAudioConnection(sessionId, ws, ctx = {}) {
  const session = getInMemorySession(sessionId);
  if (!session) {
    safeSend(ws, { type: "error", error: "session_not_found" });
    try { ws.close(4404, "session_not_found"); } catch {}
    return;
  }

  let header = null;
  let frameCount = 0;
  let bytes = 0;
  let startedAt = Date.now();
  let closed = false;

  recordAudioConnection(sessionId);

  emitLiveCallEvent(sessionId, "live_call.audio_stream.connected", {
    source: ctx?.auth?.device?.id ? "device" : "open",
    deviceName: header?.device || ""
  });

  ws.on("message", (raw, isBinary) => {
    try {
      if (!isBinary) {
        // Treat as JSON control message.
        let msg;
        try {
          msg = JSON.parse(raw.toString("utf8"));
        } catch {
          safeSend(ws, { type: "error", error: "invalid_json" });
          return;
        }
        if (!header) {
          if (typeof msg.sampleRate !== "number" || msg.sampleRate < 8000 || msg.sampleRate > 48000) {
            safeSend(ws, { type: "error", error: "bad_sample_rate" });
            try { ws.close(4400, "bad_sample_rate"); } catch {}
            return;
          }
          if (msg.channels !== 1 && msg.channels !== 2) {
            safeSend(ws, { type: "error", error: "bad_channels" });
            try { ws.close(4400, "bad_channels"); } catch {}
            return;
          }
          header = {
            sampleRate: msg.sampleRate,
            channels: msg.channels,
            encoding: String(msg.encoding || "pcm16le"),
            device: String(msg.device || "remote").slice(0, 40)
          };
          safeSend(ws, { type: "ready", sessionId, ...header });
          return;
        }
        if (msg.type === "level") {
          recordLiveCallLevel(sessionId, {
            channel: header.device === "local" ? "local" : "remote",
            rms: Number(msg.rms || 0),
            peak: Number(msg.peak || 0),
            bytes,
            deviceName: header.device
          });
          return;
        }
        if (msg.type === "flush") {
          ingestLiveCallAudio(sessionId, { channel: header.device, flush: true });
          safeSend(ws, { type: "flushed" });
          return;
        }
        if (msg.type === "stop") {
          ingestLiveCallAudio(sessionId, { channel: header.device, stop: true });
          safeSend(ws, { type: "stopped" });
          try { ws.close(1000, "client_stop"); } catch {}
          return;
        }
        return;
      }
      // Binary frame — PCM samples.
      if (!header) {
        safeSend(ws, { type: "error", error: "header_required" });
        return;
      }
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf.length === 0) return;
      if (buf.length > MAX_FRAME_BYTES) {
        recordDroppedFrame(sessionId, { oversized: true });
        safeSend(ws, { type: "error", error: "frame_too_large", bytes: buf.length });
        return;
      }
      const bufferedAmount = Number(ws.bufferedAmount || 0);
      recordBufferedAmount(sessionId, bufferedAmount);
      const bufferedLimit = backpressureBytesLimit();
      if (bufferedAmount > bufferedLimit) {
        recordDroppedFrame(sessionId, { backpressure: true });
        safeSend(ws, {
          type: "drop",
          reason: "backpressure",
          bufferedAmount,
          limit: bufferedLimit,
          bytes: buf.length
        });
        return;
      }
      bytes += buf.length;
      frameCount += 1;
      recordAudioFrame(sessionId, buf.length);
      const channel = header.device === "local" ? "local" : "remote";
      ingestLiveCallAudio(sessionId, {
        channel,
        sampleRate: header.sampleRate,
        channels: header.channels,
        encoding: header.encoding,
        buffer: buf,
        seq: frameCount
      });
      if (frameCount % 20 === 0) {
        recordAudioAck(sessionId);
        safeSend(ws, { type: "ack", seq: frameCount, bytes });
      }
    } catch (error) {
      recordAudioError(sessionId);
      safeSend(ws, { type: "error", error: String(error?.message || error) });
    }
  });

  ws.on("close", (code, reason) => {
    if (closed) return;
    closed = true;
    recordAudioDisconnect(sessionId);
    const durationMs = Date.now() - startedAt;
    emitLiveCallEvent(sessionId, "live_call.audio_stream.disconnected", {
      code,
      reason: String(reason || ""),
      bytes,
      frames: frameCount,
      durationMs
    });
    ingestLiveCallAudio(sessionId, { stop: true });
  });

  ws.on("error", (error) => {
    recordAudioError(sessionId);
    safeSend(ws, { type: "error", error: error.message });
  });
}
