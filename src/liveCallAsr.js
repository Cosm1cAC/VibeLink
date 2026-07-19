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
// The default provider comes from the checked-in production configuration.
// The deterministic mock is available only when explicitly selected for
// development or tests; an unavailable real provider is always an error.

import { emitLiveCallEvent, recordLiveCallTranscript, getInMemorySession } from "./liveCall.js";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { dataDir, rootDir } from "./config.js";
import {
  TARGET_CHANNELS,
  TARGET_ENCODING,
  TARGET_SAMPLE_RATE,
  createVadSegmenter,
  normalizePcm16To16kMono
} from "./liveCallAudioPipeline.js";

const providers = new Map();
const sessionChannels = new Map(); // sessionId -> Map(channel -> { buffer, sampleRate, channels, encoding, provider })
const LIVE_CALL_AUDIO_DIR = path.join(dataDir, "live-call-audio");
const ASR_CONFIG_PATH = path.resolve(process.env.VIBELINK_ASR_CONFIG || path.join(rootDir, "tools", "whisper-cpp", "production.json"));

function readAsrConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(ASR_CONFIG_PATH, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    console.warn(`[liveCallAsr] unable to load ASR config ${ASR_CONFIG_PATH}: ${error.message}`);
    return {};
  }
}

const asrConfig = readAsrConfig();
const pcmPolicy = {
  retentionDays: Math.max(1, Number(process.env.VIBELINK_LIVE_CALL_PCM_RETENTION_DAYS || asrConfig.retentionDays || 7)),
  maxFileBytes: Math.max(1024 * 1024, Number(process.env.VIBELINK_LIVE_CALL_PCM_MAX_BYTES || asrConfig.maxPcmBytes || 512 * 1024 * 1024)),
  maxTotalBytes: Math.max(1024 * 1024, Number(process.env.VIBELINK_LIVE_CALL_PCM_MAX_TOTAL_BYTES || asrConfig.maxTotalPcmBytes || 2 * 1024 * 1024 * 1024))
};

const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.VIBELINK_ENV === "production";
let activeProviderId = process.env.VIBELINK_ASR || asrConfig.provider || "whisper-cpp";

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
    lastIngestAt: 0,
    ingestDurationSamples: 0,
    totalIngestMs: 0,
    maxIngestMs: 0
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
    lastIngestAt: metrics.lastIngestAt,
    ingestDurationSamples: metrics.ingestDurationSamples,
    avgIngestMs: metrics.ingestDurationSamples
      ? Number((metrics.totalIngestMs / metrics.ingestDurationSamples).toFixed(2))
      : 0,
    maxIngestMs: metrics.maxIngestMs
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

function recordAsrIngestDuration(sessionId, durationMs) {
  updateAsrMetrics(sessionId, (metrics) => {
    const safeDurationMs = Math.max(0, durationMs);
    metrics.ingestDurationSamples += 1;
    metrics.totalIngestMs += safeDurationMs;
    metrics.maxIngestMs = Math.max(metrics.maxIngestMs, safeDurationMs);
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

export function getLiveCallAsrReadiness(requestedProvider = "") {
  const providerId = requestedProvider || activeProviderId;
  const provider = providers.get(providerId);
  const available = Boolean(provider && providerAvailable(provider));
  return {
    ready: available,
    provider: providerId,
    code: available ? "ready" : "no_production_asr_provider",
    diagnostics: provider && typeof provider.diagnose === "function" ? provider.diagnose() : {}
  };
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
    diagnostics: {
      ...(typeof p.diagnose === "function" ? p.diagnose() : {}),
      configuredDefault: p.id === (asrConfig.provider || "whisper-cpp"),
      configPath: ASR_CONFIG_PATH
    }
  }));
}

// ───────── Whisper.cpp provider ─────────
//
// Spawns whisper-cli.exe (or whisper-stream.exe as `--stream`) as a subprocess,
// pipes PCM to stdin, parses JSONL from stdout.
// Works with prebuilt binary at tools/whisper-cpp/bin/.
//
// The provider is registered automatically on module load if the fixed binary
// and model exist. Production never falls back silently to the demo provider.

const WHISPER_CPP_BIN = path.resolve(process.env.VIBELINK_WHISPER_CPP_BIN || path.join(rootDir, "tools", "whisper-cpp", "bin"));
const WHISPER_MODELS = path.resolve(process.env.VIBELINK_WHISPER_CPP_MODELS || path.join(rootDir, "tools", "whisper-cpp", "models"));
const WHISPER_BINARY_NAME = process.env.VIBELINK_WHISPER_CPP_BINARY || asrConfig.binary || "whisper-cli.exe";
const WHISPER_MODEL_NAME = process.env.VIBELINK_WHISPER_CPP_MODEL || asrConfig.model || "ggml-base.bin";
const WHISPER_LANGUAGE = process.env.VIBELINK_WHISPER_CPP_LANGUAGE || asrConfig.language || "zh";
const WHISPER_TEMP_DIR = path.join(dataDir, "live-call-asr-tmp");

function findWhisperBinary() {
  const full = path.join(WHISPER_CPP_BIN, WHISPER_BINARY_NAME);
  try { if (fs.statSync(full).isFile() && fs.statSync(full).size > 0) return full; } catch {}
  return "";
}

function findModel(basename = "") {
  if (basename) {
    const full = path.join(WHISPER_MODELS, basename);
    try { if (fs.statSync(full).isFile()) return full; } catch {}
    return "";
  }
  const full = path.join(WHISPER_MODELS, WHISPER_MODEL_NAME);
  try { if (fs.statSync(full).isFile()) return full; } catch {}
  return "";
}

/**
 * Whisper.cpp ASR provider.
 *
 * Runs one bounded whisper-cli process per VAD segment. whisper-cli's stdin
 * mode waits for EOF and is not a streaming protocol, so keeping one stdin
 * process alive can silently buffer an entire call. Segment WAV files keep
 * inference deterministic and let us serialize work per session/channel.
 */
export class WhisperCppProvider {
  constructor() {
    this.id = "whisper-cpp";
    this.label = "Whisper.cpp (local ASR)";
    this.binaryPath = "";
    this._sessions = new Map();
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

  async start({ sessionId, channel, sampleRate, channels, encoding, onFinal, onError }) {
    const key = `${sessionId}:${channel}`;
    const modelPath = findModel();
    if (!this.binaryPath || !modelPath) {
      throw new Error(`Whisper.cpp not available. Binary: ${!!this.binaryPath}, Model: ${!!modelPath}`);
    }

    this._sessions.set(key, {
      key,
      sessionId,
      channel,
      model: modelPath,
      sampleRate: sampleRate || 16000,
      channels: channels || 1,
      encoding: encoding || "pcm16le",
      queue: [],
      draining: null,
      stopped: false,
      segmentIndex: 0,
      lastFinalText: "",
      onFinal,
      onError
    });
  }

  feed(channel, buffer, ctx) {
    const key = `${ctx.sessionId}:${channel}`;
    const state = this._sessions.get(key);
    if (!state || state.stopped || !buffer?.length) return;
    state.queue.push(Buffer.from(buffer));
    this._drain(state);
  }

  async flush(ctx = {}) {
    const state = this._sessions.get(`${ctx.sessionId}:${ctx.channel}`);
    if (state) await this._drain(state);
  }

  async stop(ctx = {}) {
    const key = `${ctx.sessionId}:${ctx.channel}`;
    const state = this._sessions.get(key);
    if (!state) return;
    state.stopped = true;
    await this._drain(state);
    this._sessions.delete(key);
  }

  _drain(state) {
    if (state.draining) return state.draining;
    state.draining = (async () => {
      while (state.queue.length) {
        const pcm = state.queue.shift();
        try {
          const text = await this._transcribe(state, pcm);
          if (text && text !== state.lastFinalText) {
            state.lastFinalText = text;
            state.onFinal?.(state.channel, text);
          }
        } catch (error) {
          state.onError?.(error);
        }
      }
    })().finally(() => { state.draining = null; });
    return state.draining;
  }

  async _transcribe(state, pcm) {
    fs.mkdirSync(WHISPER_TEMP_DIR, { recursive: true });
    state.segmentIndex += 1;
    const prefix = path.join(WHISPER_TEMP_DIR, `${safeFilePart(state.sessionId)}-${safeFilePart(state.channel)}-${state.segmentIndex}-${Date.now()}`);
    const wavPath = `${prefix}.wav`;
    const jsonPath = `${prefix}.json`;
    fs.writeFileSync(wavPath, pcm16ToWav(pcm, state.sampleRate, state.channels));
    try {
      const result = await spawnAndCollect(this.binaryPath, [
        "--model", state.model,
        "--file", wavPath,
        "--language", WHISPER_LANGUAGE,
        "--output-json",
        "--output-file", prefix,
        "--no-timestamps",
        "--no-prints"
      ]);
      if (result.code !== 0) {
        throw new Error(`whisper-cli exited ${result.code}: ${result.stderr.trim().slice(-500)}`);
      }
      const raw = fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath, "utf8") : result.stdout;
      return transcriptFromWhisperJson(raw);
    } finally {
      for (const file of [wavPath, jsonPath]) {
        try { fs.rmSync(file, { force: true }); } catch {}
      }
    }
  }
}

function spawnAndCollect(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => { stdout += value.toString("utf8"); });
    child.stderr.on("data", (value) => { stderr += value.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: Number(code ?? -1), stdout, stderr }));
  });
}

function safeFilePart(value) {
  return String(value || "unknown").replace(/[^\w.-]+/g, "_").slice(0, 80);
}

export function pcm16ToWav(pcm, sampleRate = 16000, channels = 1) {
  const data = Buffer.from(pcm || []);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function transcriptFromWhisperJson(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw || "")); } catch { return ""; }
  if (typeof parsed.text === "string") return parsed.text.trim();
  const segments = Array.isArray(parsed.transcription) ? parsed.transcription : Array.isArray(parsed) ? parsed : [];
  return segments.map((segment) => String(segment?.text || "").trim()).filter(Boolean).join(" ").trim();
}

// Register whisper-cpp provider if binary is available.
const whisperProvider = new WhisperCppProvider();
registerAsrProvider(whisperProvider);
if (whisperProvider.check()) {
  console.log("[liveCallAsr] whisper.cpp provider ready:", whisperProvider.binaryPath);
} else {
  console.warn(`[liveCallAsr] whisper.cpp unavailable (binary=${WHISPER_BINARY_NAME}, model=${WHISPER_MODEL_NAME}); deterministic mock requires explicit development selection`);
}

// Keep long-running recordings bounded even when sessions are abandoned.
const pcmPruneTimer = setInterval(() => pruneLiveCallAudio(), Math.max(60_000, Number(asrConfig.pruneIntervalMinutes || 60) * 60_000));
pcmPruneTimer.unref?.();

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

  async start({ sessionId, channel, sampleRate, channels, encoding, onPartial, onFinal, onError }) {
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
      mockCounter: 0,
      onPartial,
      onFinal,
      onError
    });
  }

  check() {
    return !IS_PRODUCTION;
  }

  diagnose() {
    return {
      ready: !IS_PRODUCTION,
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
      state.onPartial?.(state.channel, partial, 0.6);
    }
    if (state.speechActive && !speaking && state.silenceStart && now - state.silenceStart > 1200 && !state.finalPending) {
      state.finalPending = true;
      const final = mockFinalTranscript(state.partial || mockPartialTranscript(state.mockCounter + 1, ""));
      state.partial = "";
      state.speechActive = false;
      state.silenceStart = 0;
      state.onFinal?.(state.channel, final);
      // Allow another segment.
      setTimeout(() => {
        if (state) state.finalPending = false;
      }, 200);
    }
  }

  async flush(ctx = {}) {
    const state = this.sessions.get(`${ctx.sessionId}:${ctx.channel}`);
    if (state?.partial && !state.finalPending) {
      const final = mockFinalTranscript(state.partial);
      state.partial = "";
      state.onFinal?.(state.channel, final);
    }
  }

  async stop(ctx = {}) {
    await this.flush(ctx);
    this.sessions.delete(`${ctx.sessionId}:${ctx.channel}`);
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
  const ingestStartedAt = Date.now();
  recordAsrIngest(sessionId);
  const channel = payload.channel || "remote";
  const channelsKey = sessionChannels.get(sessionId) || new Map();
  sessionChannels.set(sessionId, channelsKey);

  try {
    if (payload.stop) {
      recordAsrStop(sessionId);
      for (const [stateChannel, state] of channelsKey.entries()) {
        const provider = providers.get(state.provider);
        if (provider?.stop) provider.stop({ sessionId, channel: stateChannel }).catch(() => {});
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
      try { channelState.checkpointBytes = fs.statSync(channelState.checkpointPath).size; } catch {}
      channelsKey.set(channel, channelState);
    }

    // If this is the first frame (provider not started yet), kick off the provider.
    if (!channelState.provider) {
      const requestedProvider = session.asrProvider || session.asr_provider || activeProviderId;
      const provider = resolveAsrProvider(requestedProvider);
      if (!provider) {
        recordAsrError(sessionId);
        emitLiveCallEvent(sessionId, "live_call.asr.error", { channel, requestedProvider, error: "no_production_asr_provider" });
        throw new Error("No production ASR provider is available; configure whisper.cpp binary and model.");
      }
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
      recordProviderStart(sessionId, Boolean(channelState.fallbackFromProvider));
      provider
        .start({
          sessionId,
          channel,
          sampleRate: TARGET_SAMPLE_RATE,
          channels: TARGET_CHANNELS,
          encoding: TARGET_ENCODING,
          ...handlers
        })
        .catch((error) => {
          recordAsrError(sessionId);
          channelState.provider = null;
          emitLiveCallEvent(sessionId, "live_call.asr.error", {
            channel,
            requestedProvider,
            provider: provider.id,
            error: error.message
          });
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
      const provider = providers.get(channelState.provider);
      if (!provider) return;
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
      const provider = providers.get(channelState.provider);
      if (!provider) return;
      for (const segment of channelState.vad.flush()) {
        feedSegment(sessionId, channel, channelState, provider, segment);
      }
      if (provider.flush) provider.flush({ sessionId, channel }).catch((error) => {
        recordAsrError(sessionId);
        emitLiveCallEvent(sessionId, "live_call.asr.error", { channel, provider: provider.id, error: error.message });
      });
    }
  } finally {
    recordAsrIngestDuration(sessionId, Date.now() - ingestStartedAt);
  }
}

function resolveAsrProvider(requestedProvider = "") {
  const selectedId = requestedProvider || activeProviderId;
  const selected = providers.get(selectedId);
  if (!selected || !providerAvailable(selected)) return null;
  if (selected.id === "mock" && selectedId !== "mock") return null;
  return selected;
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
    if (channelState.checkpointBytes + buffer.length > pcmPolicy.maxFileBytes && fs.existsSync(channelState.checkpointPath)) {
      const parsed = path.parse(channelState.checkpointPath);
      const rotated = path.join(parsed.dir, `${parsed.name}.${Date.now()}${parsed.ext}`);
      fs.renameSync(channelState.checkpointPath, rotated);
      channelState.checkpointBytes = 0;
    }
    fs.appendFileSync(channelState.checkpointPath, buffer);
    channelState.checkpointBytes += buffer.length;
  } catch (error) {
    channelState.lastCheckpointError = error.message;
  }
}

export function pruneLiveCallAudio(now = Date.now()) {
  const cutoff = now - pcmPolicy.retentionDays * 86400000;
  let removed = 0;
  let removedBytes = 0;
  try {
    if (!fs.existsSync(LIVE_CALL_AUDIO_DIR)) return { removed, removedBytes, ...pcmPolicy, totalBytes: 0 };
    const activePaths = new Set([...sessionChannels.values()].flatMap((channels) => [...channels.values()].map((state) => state.checkpointPath)));
    const files = fs.readdirSync(LIVE_CALL_AUDIO_DIR)
      .map((name) => {
        const filePath = path.join(LIVE_CALL_AUDIO_DIR, name);
        try { return { name, path: filePath, stat: fs.statSync(filePath) }; } catch { return null; }
      })
      .filter((item) => item?.stat.isFile() && item.name.endsWith(".pcm"));
    for (const item of files) {
      if (!activePaths.has(item.path) && item.stat.mtimeMs < cutoff) {
        fs.rmSync(item.path);
        removed += 1;
        removedBytes += item.stat.size;
        item.removed = true;
      }
    }
    let retained = files.filter((item) => !item.removed);
    let totalBytes = retained.reduce((sum, item) => sum + item.stat.size, 0);
    for (const item of retained.sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs)) {
      if (totalBytes <= pcmPolicy.maxTotalBytes) break;
      if (activePaths.has(item.path)) continue;
      fs.rmSync(item.path);
      removed += 1;
      removedBytes += item.stat.size;
      totalBytes -= item.stat.size;
    }
    return { removed, removedBytes, ...pcmPolicy, totalBytes };
  } catch (error) {
    return { removed, removedBytes, ...pcmPolicy, error: error.message };
  }
}

export function getLiveCallAudioPolicy() {
  return { directory: LIVE_CALL_AUDIO_DIR, ...pcmPolicy };
}

export function listLiveCallAudioFiles() {
  if (!fs.existsSync(LIVE_CALL_AUDIO_DIR)) return [];
  const activePaths = new Set([...sessionChannels.values()].flatMap((channels) => [...channels.values()].map((state) => state.checkpointPath)));
  return fs.readdirSync(LIVE_CALL_AUDIO_DIR)
    .filter((name) => name.endsWith(".pcm"))
    .map((name) => {
      const filePath = path.join(LIVE_CALL_AUDIO_DIR, name);
      const stat = fs.statSync(filePath);
      return { name, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), active: activePaths.has(filePath) };
    })
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

export function deleteLiveCallAudioFile(name) {
  const safeName = path.basename(String(name || ""));
  if (!safeName || safeName !== name || !safeName.endsWith(".pcm")) return { ok: false, reason: "invalid_name" };
  const filePath = path.join(LIVE_CALL_AUDIO_DIR, safeName);
  const active = [...sessionChannels.values()].some((channels) => [...channels.values()].some((state) => state.checkpointPath === filePath));
  if (active) return { ok: false, reason: "recording_active" };
  if (!fs.existsSync(filePath)) return { ok: false, reason: "not_found" };
  fs.rmSync(filePath);
  return { ok: true, name: safeName };
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
