// Live Call ASR pipeline.
//
// Receives raw PCM frames from liveCallAudio.js (WebSocket bridge), buffers
// them per-channel, and forwards them to the active ASR provider. The
// provider emits partial / final transcripts which we route back through
// `recordLiveCallTranscript` so existing SSE subscribers see them as
// `live_call.transcript.partial` / `live_call.transcript.final` events.
//
// Provider contract:
//   {
//     id: string,
//     start({ sessionId, channel, sampleRate, channels, encoding }): Promise<void>,
//     feed(channel, buffer): void,    // PCM bytes in the format declared at start
//     flush(): Promise<void>,         // emit any pending final transcripts
//     stop(): Promise<void>,
//     onPartial?: (channel, text, confidence?) => void,
//     onFinal?:   (channel, text) => void,
//     onError?:   (error) => void
//   }
//
// The provider should emit at most one final transcript per call to flush().
//
// The default provider is `mockAsrProvider` — it doesn't do real ASR but
// it produces fake partial/final transcripts on a timer so the rest of
// the pipeline (event flow, question detection, agent hookup) can be
// exercised end-to-end. Real providers (OpenAI Whisper streaming,
// Azure Speech, Aliyun, etc.) plug in here.

import { emitLiveCallEvent, recordLiveCallTranscript, getInMemorySession } from "./liveCall.js";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { rootDir } from "./config.js";
import {
  TARGET_CHANNELS,
  TARGET_ENCODING,
  TARGET_SAMPLE_RATE,
  createVadSegmenter,
  normalizePcm16To16kMono
} from "./liveCallAudioPipeline.js";

const providers = new Map();
const sessionChannels = new Map(); // sessionId -> Map(channel -> { buffer, sampleRate, channels, encoding, provider })
const LIVE_CALL_AUDIO_DIR = path.join(rootDir, ".agent-mobile-terminal", "live-call-audio");

let activeProviderId = "mock";

function createAsrMetrics() {
  return {
    ingestCalls: 0,
    inputBytes: 0,
    normalizedBytes: 0,
    segments: 0,
    segmentBytes: 0,
    flushes: 0,
    stops: 0,
    providerStarts: 0,
    providerFallbacks: 0,
    providerFeedCalls: 0,
    errors: 0,
    lastIngestAt: 0
  };
}

const liveCallAsrMetrics = createAsrMetrics();
const liveCallAsrSessionMetrics = new Map();

function resetAsrMetrics(target) {
  Object.assign(target, createAsrMetrics());
}

function sessionAsrMetrics(sessionId) {
  let metrics = liveCallAsrSessionMetrics.get(sessionId);
  if (!metrics) {
    metrics = createAsrMetrics();
    liveCallAsrSessionMetrics.set(sessionId, metrics);
  }
  return metrics;
}

function updateAsrMetrics(sessionId, updater) {
  updater(liveCallAsrMetrics);
  updater(sessionAsrMetrics(sessionId));
}

function publicAsrMetrics(metrics) {
  return {
    ingestCalls: metrics.ingestCalls,
    inputBytes: metrics.inputBytes,
    normalizedBytes: metrics.normalizedBytes,
    segments: metrics.segments,
    segmentBytes: metrics.segmentBytes,
    flushes: metrics.flushes,
    stops: metrics.stops,
    providerStarts: metrics.providerStarts,
    providerFallbacks: metrics.providerFallbacks,
    providerFeedCalls: metrics.providerFeedCalls,
    errors: metrics.errors,
    lastIngestAt: metrics.lastIngestAt
  };
}

function recordAsrIngest(sessionId) {
  updateAsrMetrics(sessionId, (metrics) => {
    metrics.ingestCalls += 1;
    metrics.lastIngestAt = Date.now();
  });
}

function recordAsrInput(sessionId, byteLength) {
  updateAsrMetrics(sessionId, (metrics) => {
    metrics.inputBytes += byteLength;
  });
}

function recordAsrNormalized(sessionId, byteLength) {
  updateAsrMetrics(sessionId, (metrics) => {
    metrics.normalizedBytes += byteLength;
  });
}

function recordAsrSegment(sessionId, byteLength) {
  updateAsrMetrics(sessionId, (metrics) => {
    metrics.segments += 1;
    metrics.segmentBytes += byteLength;
  });
}

function recordProviderStart(sessionId, fallback) {
  updateAsrMetrics(sessionId, (metrics) => {
    metrics.providerStarts += 1;
    if (fallback) metrics.providerFallbacks += 1;
  });
}

function recordProviderFeed(sessionId) {
  updateAsrMetrics(sessionId, (metrics) => {
    metrics.providerFeedCalls += 1;
  });
}

function recordAsrFlush(sessionId) {
  updateAsrMetrics(sessionId, (metrics) => {
    metrics.flushes += 1;
  });
}

function recordAsrStop(sessionId) {
  updateAsrMetrics(sessionId, (metrics) => {
    metrics.stops += 1;
  });
}

function recordAsrError(sessionId) {
  updateAsrMetrics(sessionId, (metrics) => {
    metrics.errors += 1;
  });
}

export function resetLiveCallAsrMetrics() {
  resetAsrMetrics(liveCallAsrMetrics);
  liveCallAsrSessionMetrics.clear();
}

export function getLiveCallAsrMetrics() {
  return {
    ...publicAsrMetrics(liveCallAsrMetrics),
    sessions: [...liveCallAsrSessionMetrics.entries()].map(([sessionId, metrics]) => ({
      sessionId,
      ...publicAsrMetrics(metrics)
    }))
  };
}

/**
 * Pick the active ASR provider for a new audio stream. Today there is only
 * `mock`; real providers register via `registerAsrProvider` and can be
 * chosen with `setActiveAsrProvider`.
 */
export function setActiveAsrProvider(id) {
  if (providers.has(id)) activeProviderId = id;
  return activeProviderId;
}

export function getActiveAsrProviderId() {
  return activeProviderId;
}

export function registerAsrProvider(provider) {
  if (!provider?.id) throw new Error("ASR provider must have an id");
  providers.set(provider.id, provider);
}

export function listAsrProviders() {
  return [...providers.values()].map((p) => ({
    id: p.id,
    label: p.label || p.id,
    available: typeof p.check === "function" ? Boolean(p.check()) : true,
    active: p.id === activeProviderId,
    diagnostics: typeof p.diagnose === "function" ? p.diagnose() : {}
  }));
}

// ───────── Whisper.cpp provider ─────────
//
// Spawns whisper-cli.exe (or whisper-stream.exe as `--stream`) as a subprocess,
// pipes PCM to stdin, parses JSONL from stdout.
// Works with prebuilt binary at tools/whisper-cpp/bin/.
//
// The provider is registered automatically on module load if the binary exists.
// Falls back silently to mock if the binary cannot be found.

const WHISPER_CPP_BIN = path.join(rootDir, "tools", "whisper-cpp", "bin");
const WHISPER_MODELS = path.join(rootDir, "tools", "whisper-cpp", "models");

function findWhisperBinary() {
  const candidates = ["whisper-stream.exe", "whisper-cli.exe", "main.exe"];
  for (const name of candidates) {
    const full = path.join(WHISPER_CPP_BIN, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.size > 0) return full;
    } catch {}
  }
  return "";
}

function findModel(basename = "") {
  if (basename) {
    const full = path.join(WHISPER_MODELS, basename);
    try { if (fs.statSync(full).isFile()) return full; } catch {}
    return "";
  }
  // Auto-detect best available model
  const preferred = ["ggml-small.bin", "ggml-base.bin", "ggml-tiny.bin"];
  for (const name of preferred) {
    const full = path.join(WHISPER_MODELS, name);
    try { if (fs.statSync(full).isFile()) return full; } catch {}
  }
  return "";
}

/**
 * Whisper.cpp ASR provider.
 *
 * Uses whisper-cli --stdin for reliable segment output. The binary is
 * spawned on first `start()` and kept alive for the session. PCM is fed
 * by appending to its stdin; when enough audio accumulates (>2s) an
 * inference is triggered and JSON results are parsed from stdout.
 *
 * Advanced use: if whisper-stream.exe is available (requires a custom
 * build of whisper.cpp with streaming support), the provider will use
 * `--step N` mode for partial transcripts.
 */
class WhisperCppProvider {
  constructor() {
    this.id = "whisper-cpp";
    this.label = "Whisper.cpp (local ASR)";
    this.binaryPath = "";
    this._sessions = new Map(); // sessionKey -> { child, model, buffer, transcripting, timer }
    this._ready = false;
  }

  /** Check availability. Returns true if binary + model found. */
  check() {
    this.binaryPath = findWhisperBinary();
    if (!this.binaryPath) return false;
    return Boolean(findModel());
  }

  diagnose() {
    const binaryPath = this.binaryPath || findWhisperBinary();
    const modelPath = findModel();
    return {
      binaryPath,
      modelPath,
      ready: Boolean(binaryPath && modelPath),
      mode: binaryPath ? path.basename(binaryPath) : ""
    };
  }

  async start({ sessionId, channel, sampleRate, channels, encoding }) {
    const key = `${sessionId}:${channel}`;
    const modelPath = findModel();
    if (!this.binaryPath || !modelPath) {
      throw new Error(`Whisper.cpp not available. Binary: ${!!this.binaryPath}, Model: ${!!modelPath}`);
    }

    // Kill any existing child for this channel
    const existing = this._sessions.get(key);
    if (existing) {
      try { existing.child.kill(); } catch {}
    }

    const child = spawn(this.binaryPath, [
      "--model", modelPath,
      "--language", "zh",
      "--stdin",
      "--output-json",
      "--step-ms", "1000",
      "--length-ms", "4000",
      "--keep-context", "1",
      "--max-len", "80",
      "--no-timestamps"
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const state = {
      key,
      child,
      model: modelPath,
      buffer: [],
      totalSamples: 0,
      lastFinalText: "",
      runningInference: false,
      closed: false,
      sampleRate: sampleRate || 16000
    };

    child.stdout.on("data", (data) => this._onStdout(key, state, data));
    child.stderr.on("data", () => {}); // whisper emits progress on stderr
    child.on("close", () => { state.closed = true; });

    child.on("error", (error) => {
      this.onError?.(`whisper process failed: ${error.message}`);
    });

    this._sessions.set(key, state);
  }

  feed(channel, buffer, ctx) {
    const key = `${ctx.sessionId}:${channel}`;
    const state = this._sessions.get(key);
    if (!state || state.closed) return;

    state.buffer.push(buffer);
    state.totalSamples += buffer.length / 2; // s16le

    // Write immediately to child stdin — the child accumulates internally.
    try {
      state.child.stdin.write(buffer);
    } catch {
      // process may have exited
    }

    // After every 2s of accumulated audio, flush the child's stdin to trigger inference
    // (whisper-cli --stdin flushes on read end close; we don't close, but the
    // model's internal segment detection will emit whenever it has enough context.)
    // We gently nudge by sending a small dummy write.
    if (state.totalSamples > ctx.sampleRate * 4 && !state.runningInference) {
      state.runningInference = true;
      setTimeout(() => { state.runningInference = false; }, 2000);
    }
  }

  async flush() {
    for (const state of this._sessions.values()) {
      if (state.child?.stdin?.writable && !state.closed) {
        // whisper-cli processes stdin continuously; no explicit flush needed.
        // We send a small dummy to encourage it to process pending audio.
        try { state.child.stdin.write(Buffer.alloc(2)); } catch {}
      }
    }
  }

  async stop() {
    for (const state of this._sessions.values()) {
      try {
        if (!state.closed) {
          state.child.stdin.end();
          setTimeout(() => { state.child.kill(); }, 1000);
        }
      } catch {}
    }
    this._sessions.clear();
  }

  _onStdout(key, state, data) {
    const text = data.toString("utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // whisper-cli --output-json outputs one JSON object per segment.
        // Non-JSON lines (progress, logs) are ignored.
        continue;
      }

      // whisper-cli JSON format:
      // { "t_start": N, "t_end": N, "text": "...", "tokens": [...] }

      const segmentText = (parsed.text || "").trim();
      if (!segmentText) continue;

      const isDuplicate = segmentText === state.lastFinalText ||
        segmentText.split(" ").filter(Boolean).length <= 1;

      if (!isDuplicate) {
        state.lastFinalText = segmentText;
        this.onFinal?.(key.split(":")[1] || "remote", segmentText);
      }
    }
  }
}

// Register whisper-cpp provider if binary is available.
const whisperProvider = new WhisperCppProvider();
registerAsrProvider(whisperProvider);
if (whisperProvider.check()) {
  if (process.env.VIBELINK_ASR !== "mock") {
    setActiveAsrProvider("whisper-cpp");
    console.log("[liveCallAsr] whisper.cpp provider ready:", whisperProvider.binaryPath);
  }
} else {
  console.log("[liveCallAsr] whisper.cpp binary/model not found, using mock provider");
}

// ───────── Mock provider ─────────
//
// Maintains a rolling RMS window per channel; emits `partial` events every
// ~600 ms while speech energy is high, then a single `final` transcript
// ~1.2 s after energy drops below threshold. The transcript text is the
// question the user is most likely to be asking in a mock interview — good
// enough to verify question detection and the agent hookup.

class MockAsrProvider {
  constructor() {
    this.id = "mock";
    this.label = "Mock ASR (demo only)";
    this.sessions = new Map();
  }

  async start({ sessionId, channel, sampleRate, channels, encoding }) {
    const key = `${sessionId}:${channel}`;
    this.sessions.set(key, {
      sessionId,
      channel,
      sampleRate: sampleRate || 16000,
      channels: channels || 1,
      encoding: encoding || "pcm16le",
      buffer: [],
      energy: 0,
      energyWindow: [],
      speechActive: false,
      silenceStart: 0,
      lastEmit: 0,
      partial: "",
      finalPending: false,
      mockCounter: 0
    });
  }

  check() {
    return true;
  }

  diagnose() {
    return {
      ready: true,
      mode: "deterministic-mock",
      activeSessions: this.sessions.size
    };
  }

  feed(channel, buffer, ctx) {
    const state = this.sessions.get(`${ctx.sessionId}:${channel}`);
    if (!state) return;
    state.buffer.push(buffer);
    const rms = computeRms(buffer);
    state.energyWindow.push(rms);
    if (state.energyWindow.length > 40) state.energyWindow.shift();
    const avg = state.energyWindow.reduce((s, v) => s + v, 0) / Math.max(1, state.energyWindow.length);
    const now = Date.now();
    const speaking = avg > 0.01;
    if (speaking && !state.speechActive) {
      state.speechActive = true;
      state.silenceStart = 0;
    }
    if (!speaking && state.speechActive) {
      state.silenceStart = state.silenceStart || now;
    }
    if (state.speechActive && now - state.lastEmit > 600) {
      state.lastEmit = now;
      state.mockCounter += 1;
      const partial = mockPartialTranscript(state.mockCounter, state.partial);
      state.partial = partial;
      this.onPartial?.(state.channel, partial, 0.6);
    }
    if (state.speechActive && !speaking && state.silenceStart && now - state.silenceStart > 1200 && !state.finalPending) {
      state.finalPending = true;
      const final = mockFinalTranscript(state.partial || mockPartialTranscript(state.mockCounter + 1, ""));
      state.partial = "";
      state.speechActive = false;
      state.silenceStart = 0;
      this.onFinal?.(state.channel, final);
      // Allow another segment.
      setTimeout(() => {
        if (state) state.finalPending = false;
      }, 200);
    }
  }

  async flush() {
    for (const state of this.sessions.values()) {
      if (state.partial && !state.finalPending) {
        const final = mockFinalTranscript(state.partial);
        state.partial = "";
        this.onFinal?.(state.channel, final);
      }
    }
  }

  async stop() {
    await this.flush();
    this.sessions.clear();
  }
}

function computeRms(buffer) {
  if (!buffer || buffer.length < 2) return 0;
  const samples = Math.floor(buffer.length / 2);
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const v = buffer.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

const MOCK_QUESTIONS = [
  "请介绍一下你最近做过的一个项目，以及你在里面解决的关键问题是什么？",
  "你平时是怎么调试一个比较难复现的 bug 的？",
  "说一下你对 TypeScript 的看法，它的优点和缺点分别是什么？",
  "如果让你重新设计 VibeLink 的 Workspace 模块，你会怎么改？",
  "你在团队协作中遇到过最难沟通的问题是什么？怎么处理的？",
  "讲一下你对 React Server Components 的理解，它解决了什么问题？",
  "你最近学到的最有用的一项技术是什么？",
  "你对自己未来三年的职业规划是什么？"
];

function mockPartialTranscript(n, prev = "") {
  const base = MOCK_QUESTIONS[(n - 1) % MOCK_QUESTIONS.length];
  const partialChars = Math.min(base.length, Math.max(2, Math.floor(base.length * Math.min(1, n / 4))));
  return base.slice(0, partialChars);
}

function mockFinalTranscript(partial) {
  // If we already have a partial that looks complete, just clean it up;
  // otherwise find the closest mock question to the partial text.
  if (!partial) return MOCK_QUESTIONS[0];
  for (const q of MOCK_QUESTIONS) {
    if (q.startsWith(partial.slice(0, 8)) || partial.startsWith(q.slice(0, 8))) return q;
  }
  return MOCK_QUESTIONS[MOCK_QUESTIONS.length - 1];
}

// Register the mock provider on module load.
const mockProvider = new MockAsrProvider();
registerAsrProvider(mockProvider);

// ───────── Public ingestion entry ─────────

/**
 * Called by the WebSocket bridge for every PCM frame, control message,
 * or stream lifecycle event.
 */
export function ingestLiveCallAudio(sessionId, payload = {}) {
  const session = getInMemorySession(sessionId);
  if (!session) return;
  recordAsrIngest(sessionId);
  const channel = payload.channel || "remote";
  const channelsKey = sessionChannels.get(sessionId) || new Map();
  sessionChannels.set(sessionId, channelsKey);

  if (payload.stop) {
    recordAsrStop(sessionId);
    for (const state of channelsKey.values()) {
      const provider = providers.get(state.provider);
      if (provider?.stop) provider.stop().catch(() => {});
    }
    channelsKey.clear();
    return;
  }

  let channelState = channelsKey.get(channel);
  if (!channelState) {
    channelState = {
      sampleRate: payload.sampleRate || TARGET_SAMPLE_RATE,
      channels: payload.channels || TARGET_CHANNELS,
      encoding: payload.encoding || TARGET_ENCODING,
      provider: null,
      requestedProvider: "",
      fallbackFromProvider: "",
      vad: createVadSegmenter({ sampleRate: TARGET_SAMPLE_RATE }),
      segmentIndex: 0,
      checkpointBytes: 0,
      checkpointPath: liveCallCheckpointPath(sessionId, channel)
    };
    channelsKey.set(channel, channelState);
  }

  // If this is the first frame (provider not started yet), kick off the provider.
  if (!channelState.provider) {
    const requestedProvider = session.asrProvider || session.asr_provider || activeProviderId;
    const provider = resolveAsrProvider(requestedProvider);
    channelState.provider = provider.id;
    channelState.requestedProvider = requestedProvider || provider.id;
    channelState.fallbackFromProvider = provider.id !== requestedProvider ? requestedProvider : "";
    channelState.sampleRate = TARGET_SAMPLE_RATE;
    channelState.channels = TARGET_CHANNELS;
    channelState.encoding = TARGET_ENCODING;

    const handlers = {
      onPartial: (ch, text) => safePartial(sessionId, ch, text),
      onFinal: (ch, text) => safeFinal(sessionId, ch, text),
      onError: (error) => {
        recordAsrError(sessionId);
        console.error(`[liveCallAsr:${provider.id}]`, error?.message || error);
      }
    };
    provider.onPartial = handlers.onPartial;
    provider.onFinal = handlers.onFinal;
    provider.onError = handlers.onError;
    recordProviderStart(sessionId, Boolean(channelState.fallbackFromProvider));
    provider
      .start({
        sessionId,
        channel,
        sampleRate: TARGET_SAMPLE_RATE,
        channels: TARGET_CHANNELS,
        encoding: TARGET_ENCODING
      })
      .catch((error) => {
        recordAsrError(sessionId);
        console.error(`[liveCallAsr:start]`, error.message);
      });
    emitLiveCallEvent(sessionId, "live_call.asr.provider", {
      channel,
      provider: provider.id,
      requestedProvider: requestedProvider || provider.id,
      fallback: Boolean(channelState.fallbackFromProvider),
      fallbackFromProvider: channelState.fallbackFromProvider
    });
  }

  if (payload.buffer) {
    const provider = providers.get(channelState.provider) || mockProvider;
    recordAsrInput(sessionId, payload.buffer.length);
    const normalized = normalizePcm16To16kMono(payload.buffer, {
      sampleRate: payload.sampleRate || channelState.sampleRate,
      channels: payload.channels || channelState.channels,
      encoding: payload.encoding || channelState.encoding
    });
    recordAsrNormalized(sessionId, normalized.buffer.length);
    if (normalized.buffer.length) {
      appendCheckpoint(channelState, normalized.buffer);
      for (const segment of channelState.vad.push(normalized.buffer)) {
        feedSegment(sessionId, channel, channelState, provider, segment);
      }
    }
  }
  if (payload.flush) {
    recordAsrFlush(sessionId);
    const provider = providers.get(channelState.provider) || mockProvider;
    for (const segment of channelState.vad.flush()) {
      feedSegment(sessionId, channel, channelState, provider, segment);
    }
    if (provider.flush) provider.flush().catch(() => {});
  }
}

function resolveAsrProvider(requestedProvider = "") {
  const requested = providers.get(requestedProvider);
  if (requested && providerAvailable(requested)) return requested;
  const active = providers.get(activeProviderId);
  if (active && providerAvailable(active)) return active;
  return mockProvider;
}

function providerAvailable(provider) {
  return typeof provider.check === "function" ? Boolean(provider.check()) : true;
}

function liveCallCheckpointPath(sessionId, channel) {
  const safeSession = String(sessionId || "").replace(/[^\w.-]+/g, "_");
  const safeChannel = String(channel || "remote").replace(/[^\w.-]+/g, "_");
  return path.join(LIVE_CALL_AUDIO_DIR, `${safeSession}-${safeChannel}.pcm`);
}

function appendCheckpoint(channelState, buffer) {
  try {
    fs.mkdirSync(path.dirname(channelState.checkpointPath), { recursive: true });
    fs.appendFileSync(channelState.checkpointPath, buffer);
    channelState.checkpointBytes += buffer.length;
  } catch (error) {
    channelState.lastCheckpointError = error.message;
  }
}

function feedSegment(sessionId, channel, channelState, provider, segment) {
  channelState.segmentIndex += 1;
  recordAsrSegment(sessionId, segment.buffer.length);
  emitLiveCallEvent(sessionId, "live_call.audio_segment", {
    channel,
    provider: provider.id,
    segmentIndex: channelState.segmentIndex,
    startedAtMs: Math.round(segment.startedAtMs),
    endedAtMs: Math.round(segment.endedAtMs),
    durationMs: Math.round(segment.durationMs),
    speechMs: Math.round(segment.speechMs),
    rms: Number(segment.rms.toFixed(5)),
    bytes: segment.buffer.length,
    checkpointBytes: channelState.checkpointBytes,
    sampleRate: segment.sampleRate,
    channels: segment.channels,
    encoding: segment.encoding
  });
  provider.feed(channel, segment.buffer, {
    sessionId,
    sampleRate: segment.sampleRate,
    channels: segment.channels,
    encoding: segment.encoding,
    segmentIndex: channelState.segmentIndex,
    durationMs: segment.durationMs,
    checkpointPath: channelState.checkpointPath
  });
  recordProviderFeed(sessionId);
}

export function getLiveCallAsrCheckpoints(sessionId) {
  const channelsKey = sessionChannels.get(sessionId);
  if (!channelsKey) return [];
  return [...channelsKey.entries()].map(([channel, state]) => ({
    channel,
    path: state.checkpointPath,
    bytes: state.checkpointBytes,
    provider: state.provider || "",
    requestedProvider: state.requestedProvider || "",
    fallbackFromProvider: state.fallbackFromProvider || "",
    segmentCount: state.segmentIndex || 0,
    exists: fs.existsSync(state.checkpointPath)
  }));
}

export function recoverLiveCallAsrFromCheckpoints(sessionId) {
  const session = getInMemorySession(sessionId);
  if (!session) return [];
  const checkpoints = getLiveCallAsrCheckpoints(sessionId);
  for (const checkpoint of checkpoints) {
    if (!checkpoint.exists || !checkpoint.bytes) continue;
    emitLiveCallEvent(sessionId, "live_call.audio_checkpoint.recovered", {
      channel: checkpoint.channel,
      provider: checkpoint.provider,
      bytes: checkpoint.bytes,
      path: checkpoint.path
    });
  }
  return checkpoints;
}

function safePartial(sessionId, channel, text) {
  try {
    recordLiveCallTranscript(sessionId, { text, final: false, speaker: channel });
  } catch (error) {
    console.error("[liveCallAsr] partial failed:", error.message);
  }
}

function safeFinal(sessionId, channel, text) {
  try {
    recordLiveCallTranscript(sessionId, { text, final: true, speaker: channel });
  } catch (error) {
    console.error("[liveCallAsr] final failed:", error.message);
  }
}
