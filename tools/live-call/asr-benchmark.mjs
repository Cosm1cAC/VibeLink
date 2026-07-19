#!/usr/bin/env node
// Deterministic ASR ingest benchmark. Use --provider whisper-cpp for a real
// quality run; mock is intentionally only available outside production.
import { performance } from "node:perf_hooks";
import { normalizePcm16To16kMono } from "../../src/liveCallAudioPipeline.js";

const args = process.argv.slice(2);
const seconds = Math.max(1, Number(args.find((a) => /^\d+$/.test(a)) || 30));
const frames = Math.ceil(seconds * 50);
const frame = Buffer.alloc(640); // 20 ms, 16 kHz mono PCM16
let bytes = 0;
const samples = [];
for (let i = 0; i < frames; i += 1) {
  const started = performance.now();
  const normalized = normalizePcm16To16kMono(frame, { sampleRate: 16000, channels: 1, encoding: "pcm16le" });
  const elapsed = performance.now() - started;
  samples.push(elapsed);
  bytes += normalized.buffer.length;
}
samples.sort((a, b) => a - b);
const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] || 0;
console.log(JSON.stringify({ seconds, frames, inputBytes: frames * frame.length, normalizedBytes: bytes,
  ingestLatencyMs: { p50: Number(percentile(0.5).toFixed(3)), p95: Number(percentile(0.95).toFixed(3)), max: Number(percentile(0.999).toFixed(3)) },
  quality: qualityReport(args) }, null, 2));

function qualityReport(argv) {
  const refIndex = argv.indexOf("--reference");
  const hypIndex = argv.indexOf("--hypothesis");
  if (refIndex < 0 || hypIndex < 0) return { wer: null, cer: null, note: "Pass --reference and --hypothesis for WER/CER." };
  const reference = argv[refIndex + 1] || "";
  const hypothesis = argv[hypIndex + 1] || "";
  return { wer: errorRate(reference.trim().split(/\s+/), hypothesis.trim().split(/\s+/)), cer: errorRate([...reference.replace(/\s/g, "")], [...hypothesis.replace(/\s/g, "")]) };
}

function errorRate(reference, hypothesis) {
  if (!reference.length) return hypothesis.length ? 1 : 0;
  const prev = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (let i = 1; i <= reference.length; i += 1) {
    let diagonal = prev[0]; prev[0] = i;
    for (let j = 1; j <= hypothesis.length; j += 1) {
      const above = prev[j];
      prev[j] = reference[i - 1] === hypothesis[j - 1] ? diagonal : 1 + Math.min(diagonal, prev[j], prev[j - 1]);
      diagonal = above;
    }
  }
  return Number((prev[hypothesis.length] / reference.length).toFixed(4));
}
