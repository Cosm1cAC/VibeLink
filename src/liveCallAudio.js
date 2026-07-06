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
        safeSend(ws, { type: "error", error: "frame_too_large", bytes: buf.length });
        return;
      }
      bytes += buf.length;
      frameCount += 1;
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
        safeSend(ws, { type: "ack", seq: frameCount, bytes });
      }
    } catch (error) {
      safeSend(ws, { type: "error", error: String(error?.message || error) });
    }
  });

  ws.on("close", (code, reason) => {
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
    safeSend(ws, { type: "error", error: error.message });
  });
}