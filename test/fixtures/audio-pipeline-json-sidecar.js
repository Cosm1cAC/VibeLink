import { createInterface } from "node:readline";

import {
  AUDIO_PIPELINE_CONTROL_METHODS,
  AUDIO_PIPELINE_METHODS,
  AUDIO_PIPELINE_PROTOCOL_VERSION,
  serializeAudioPipelineError
} from "../../src/audioPipelineContract.js";

function integerArg(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = Number(index >= 0 ? process.argv[index + 1] : fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const maxBufferedSamples = integerArg("--max-buffered-samples", 48_000);
const maxSamplesPerChunk = integerArg("--max-samples-per-chunk", 8_192);
const startedAt = new Date().toISOString();
const ring = [];
const state = {
  requests: 0,
  responses: 0,
  failures: 0,
  processedChunks: 0,
  processedSamples: 0,
  processedBytes: 0,
  droppedChunks: 0,
  droppedSamples: 0,
  droppedBytes: 0,
  backpressureRejects: 0,
  sequenceGaps: 0,
  duplicateSequences: 0,
  outOfOrderSequences: 0,
  bufferedSamples: 0,
  evictedChunks: 0,
  evictedSamples: 0,
  lastSequence: null,
  lastRequestAt: "",
  lastResponseAt: "",
  lastFailureAt: "",
  lastError: ""
};

function nowIso() {
  return new Date().toISOString();
}

function stats() {
  return {
    implementation: "node-fixture",
    protocolVersion: AUDIO_PIPELINE_PROTOCOL_VERSION,
    startedAt,
    pending: 0,
    maxBufferedSamples,
    maxSamplesPerChunk,
    ...state,
    bufferedChunks: ring.length
  };
}

function processPcm16(input = {}) {
  const sequence = Number(input.sequence);
  const samples = input.samples;
  const silenceThreshold = input.silenceThreshold === undefined ? 0.01 : Number(input.silenceThreshold);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("sequence must be a non-negative safe integer.");
  if (!Array.isArray(samples) || samples.length === 0) throw new Error("samples must be a non-empty array.");
  if (!Number.isFinite(silenceThreshold) || silenceThreshold < 0 || silenceThreshold > 1) throw new Error("silenceThreshold must be between 0 and 1.");
  for (const sample of samples) {
    if (!Number.isInteger(sample) || sample < -32768 || sample > 32767) throw new Error("samples must contain signed 16-bit integers.");
  }
  if (samples.length > maxSamplesPerChunk || samples.length > maxBufferedSamples) {
    state.droppedChunks += 1;
    state.droppedSamples += samples.length;
    state.droppedBytes += samples.length * 2;
    state.backpressureRejects += 1;
    throw new Error(`Audio pipeline backpressure: chunk exceeds maxSamplesPerChunk (${maxSamplesPerChunk}) or ring capacity (${maxBufferedSamples}).`);
  }

  let sequenceGap = 0;
  let duplicate = false;
  let outOfOrder = false;
  if (state.lastSequence !== null) {
    if (sequence === state.lastSequence) {
      duplicate = true;
      state.duplicateSequences += 1;
    } else if (sequence < state.lastSequence) {
      outOfOrder = true;
      state.outOfOrderSequences += 1;
    } else {
      sequenceGap = Math.max(0, sequence - state.lastSequence - 1);
      state.sequenceGaps += sequenceGap;
      state.lastSequence = sequence;
    }
  } else {
    state.lastSequence = sequence;
  }

  let sumSquares = 0;
  let peak = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    peak = Math.max(peak, Math.abs(normalized));
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / samples.length);

  while (ring.length && state.bufferedSamples + samples.length > maxBufferedSamples) {
    const removed = ring.shift();
    state.bufferedSamples -= removed;
    state.evictedChunks += 1;
    state.evictedSamples += removed;
  }
  ring.push(samples.length);
  state.bufferedSamples += samples.length;
  state.processedChunks += 1;
  state.processedSamples += samples.length;
  state.processedBytes += samples.length * 2;

  return {
    sequence,
    samples: samples.length,
    bytes: samples.length * 2,
    level: rms,
    peak,
    rms,
    silence: rms < silenceThreshold,
    sequenceGap,
    duplicate,
    outOfOrder,
    expectedSequence: state.lastSequence < Number.MAX_SAFE_INTEGER ? state.lastSequence + 1 : null,
    bufferedChunks: ring.length,
    bufferedSamples: state.bufferedSamples,
    evictedChunks: state.evictedChunks,
    evictedSamples: state.evictedSamples
  };
}

function handle(method, args) {
  if (method === "__health") {
    return {
      ok: true,
      implementation: "node-fixture",
      protocolVersion: AUDIO_PIPELINE_PROTOCOL_VERSION,
      supportedMethods: [...AUDIO_PIPELINE_METHODS],
      controlMethods: [...AUDIO_PIPELINE_CONTROL_METHODS],
      maxBufferedSamples,
      maxSamplesPerChunk,
      startedAt
    };
  }
  if (method === "stats") return stats();
  if (method === "__close") return true;
  if (method === "processPcm16") return processPcm16(args?.[0]);
  throw new Error(`Unsupported audio pipeline sidecar method: ${method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: null, error: serializeAudioPipelineError(error) })}\n`);
    return;
  }
  state.requests += 1;
  state.lastRequestAt = nowIso();
  try {
    const result = handle(request.method, request.args || []);
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    state.responses += 1;
    state.lastResponseAt = nowIso();
    if (request.method === "__close") process.exit(0);
  } catch (error) {
    state.failures += 1;
    state.lastFailureAt = nowIso();
    state.lastError = error.message;
    process.stdout.write(`${JSON.stringify({ id: request.id, error: serializeAudioPipelineError(error) })}\n`);
  }
});
