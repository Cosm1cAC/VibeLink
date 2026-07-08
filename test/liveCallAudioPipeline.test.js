import assert from "node:assert/strict";
import test from "node:test";

import {
  TARGET_SAMPLE_RATE,
  createVadSegmenter,
  normalizePcm16To16kMono
} from "../src/liveCallAudioPipeline.js";

function toneFrame({ samples = 1600, amplitude = 8000, channels = 1 } = {}) {
  const frame = Buffer.alloc(samples * channels * 2);
  for (let index = 0; index < samples; index += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      frame.writeInt16LE(amplitude, (index * channels + channel) * 2);
    }
  }
  return frame;
}

test("normalizes stereo 48k PCM to 16k mono", () => {
  const input = toneFrame({ samples: 4800, channels: 2 });
  const normalized = normalizePcm16To16kMono(input, {
    sampleRate: 48000,
    channels: 2,
    encoding: "pcm16le"
  });

  assert.equal(normalized.sampleRate, TARGET_SAMPLE_RATE);
  assert.equal(normalized.channels, 1);
  assert.equal(normalized.encoding, "pcm16le");
  assert.equal(normalized.outputFrames, 1600);
  assert.equal(normalized.buffer.length, 3200);
});

test("vad keeps pre speech padding and flushes complete segment after redemption silence", () => {
  const vad = createVadSegmenter({
    threshold: 0.01,
    redemptionMs: 200,
    preSpeechPaddingMs: 100,
    postSpeechPaddingMs: 100,
    minSpeechMs: 100
  });
  const silence = toneFrame({ samples: 1600, amplitude: 0 });
  const speech = toneFrame({ samples: 1600, amplitude: 8000 });

  assert.deepEqual(vad.push(silence), []);
  assert.deepEqual(vad.push(speech), []);
  assert.deepEqual(vad.push(speech), []);
  assert.equal(vad.push(silence).length, 0);
  const segments = vad.push(silence);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].sampleRate, TARGET_SAMPLE_RATE);
  assert.equal(segments[0].channels, 1);
  assert.equal(segments[0].encoding, "pcm16le");
  assert.ok(segments[0].durationMs >= 300);
  assert.ok(segments[0].speechMs >= 200);
});
