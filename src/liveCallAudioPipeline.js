export const TARGET_SAMPLE_RATE = 16000;
export const TARGET_CHANNELS = 1;
export const TARGET_ENCODING = "pcm16le";

function clampInt16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function sampleCount(buffer, channels = 1) {
  return Math.floor((buffer?.length || 0) / 2 / Math.max(1, channels));
}

export function computePcm16Rms(buffer) {
  if (!buffer || buffer.length < 2) return 0;
  const samples = Math.floor(buffer.length / 2);
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = buffer.readInt16LE(index * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, samples));
}

export function normalizePcm16To16kMono(buffer, options = {}) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const encoding = String(options.encoding || TARGET_ENCODING).toLowerCase();
  if (encoding !== TARGET_ENCODING) {
    const error = new Error(`Unsupported audio encoding: ${encoding}`);
    error.code = "UNSUPPORTED_AUDIO_ENCODING";
    throw error;
  }

  const sourceRate = Math.max(8000, Math.min(48000, Number(options.sampleRate || TARGET_SAMPLE_RATE)));
  const sourceChannels = Number(options.channels || TARGET_CHANNELS) === 2 ? 2 : 1;
  const frames = sampleCount(source, sourceChannels);
  if (!frames) {
    return {
      buffer: Buffer.alloc(0),
      sampleRate: TARGET_SAMPLE_RATE,
      channels: TARGET_CHANNELS,
      encoding: TARGET_ENCODING,
      inputFrames: 0,
      outputFrames: 0,
      durationMs: 0
    };
  }

  const mono = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let total = 0;
    for (let channel = 0; channel < sourceChannels; channel += 1) {
      total += source.readInt16LE((frame * sourceChannels + channel) * 2);
    }
    mono[frame] = total / sourceChannels;
  }

  if (sourceRate === TARGET_SAMPLE_RATE) {
    const output = Buffer.alloc(frames * 2);
    for (let frame = 0; frame < frames; frame += 1) output.writeInt16LE(clampInt16(mono[frame]), frame * 2);
    return {
      buffer: output,
      sampleRate: TARGET_SAMPLE_RATE,
      channels: TARGET_CHANNELS,
      encoding: TARGET_ENCODING,
      inputFrames: frames,
      outputFrames: frames,
      durationMs: frames / TARGET_SAMPLE_RATE * 1000
    };
  }

  const outputFrames = Math.max(1, Math.round(frames * TARGET_SAMPLE_RATE / sourceRate));
  const output = Buffer.alloc(outputFrames * 2);
  for (let frame = 0; frame < outputFrames; frame += 1) {
    const sourceIndex = frame * sourceRate / TARGET_SAMPLE_RATE;
    const left = Math.min(frames - 1, Math.floor(sourceIndex));
    const right = Math.min(frames - 1, left + 1);
    const fraction = sourceIndex - left;
    const value = mono[left] * (1 - fraction) + mono[right] * fraction;
    output.writeInt16LE(clampInt16(value), frame * 2);
  }

  return {
    buffer: output,
    sampleRate: TARGET_SAMPLE_RATE,
    channels: TARGET_CHANNELS,
    encoding: TARGET_ENCODING,
    inputFrames: frames,
    outputFrames,
    durationMs: outputFrames / TARGET_SAMPLE_RATE * 1000
  };
}

export class VadSegmenter {
  constructor(options = {}) {
    this.sampleRate = Number(options.sampleRate || TARGET_SAMPLE_RATE);
    this.threshold = Number(options.threshold || 0.012);
    this.redemptionMs = Number(options.redemptionMs || 700);
    this.preSpeechPaddingMs = Number(options.preSpeechPaddingMs || 240);
    this.postSpeechPaddingMs = Number(options.postSpeechPaddingMs || 240);
    this.minSpeechMs = Number(options.minSpeechMs || 180);
    this.maxSegmentMs = Number(options.maxSegmentMs || 30000);
    this.reset();
  }

  reset() {
    this.positionMs = this.positionMs || 0;
    this.preRoll = [];
    this.chunks = [];
    this.inSpeech = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.segmentStartedAtMs = 0;
  }

  push(buffer) {
    const chunk = this._chunk(buffer);
    if (!chunk.buffer.length) return [];
    const segments = [];
    const isSpeech = chunk.rms >= this.threshold;

    if (!this.inSpeech) {
      if (isSpeech) {
        this.inSpeech = true;
        this.segmentStartedAtMs = Math.max(0, chunk.startMs - this._duration(this.preRoll));
        this.chunks = [...this.preRoll, chunk];
        this.preRoll = [];
        this.speechMs = chunk.durationMs;
        this.silenceMs = 0;
      } else {
        this._pushPreRoll(chunk);
      }
      this.positionMs += chunk.durationMs;
      return segments;
    }

    this.chunks.push(chunk);
    if (isSpeech) {
      this.speechMs += chunk.durationMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += chunk.durationMs;
    }

    const segmentMs = this._duration(this.chunks);
    if (this.silenceMs >= this.redemptionMs || segmentMs >= this.maxSegmentMs) {
      const segment = this._finalize();
      if (segment) segments.push(segment);
    }

    this.positionMs += chunk.durationMs;
    return segments;
  }

  flush() {
    if (!this.inSpeech) {
      this.preRoll = [];
      return [];
    }
    const segment = this._finalize({ force: true });
    return segment ? [segment] : [];
  }

  _chunk(buffer) {
    const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    const samples = Math.floor(source.length / 2);
    const durationMs = samples / this.sampleRate * 1000;
    return {
      buffer: source,
      rms: computePcm16Rms(source),
      durationMs,
      startMs: this.positionMs,
      endMs: this.positionMs + durationMs
    };
  }

  _pushPreRoll(chunk) {
    this.preRoll.push(chunk);
    while (this._duration(this.preRoll) > this.preSpeechPaddingMs && this.preRoll.length > 1) this.preRoll.shift();
  }

  _duration(chunks) {
    return chunks.reduce((total, chunk) => total + chunk.durationMs, 0);
  }

  _finalize() {
    if (this.speechMs < this.minSpeechMs) {
      const tail = this.chunks.slice(-3);
      this.reset();
      for (const chunk of tail) this._pushPreRoll(chunk);
      return null;
    }

    let lastSpeechIndex = -1;
    for (let index = this.chunks.length - 1; index >= 0; index -= 1) {
      if (this.chunks[index].rms >= this.threshold) {
        lastSpeechIndex = index;
        break;
      }
    }

    let keepUntil = lastSpeechIndex;
    let postMs = 0;
    for (let index = lastSpeechIndex + 1; index < this.chunks.length; index += 1) {
      if (postMs >= this.postSpeechPaddingMs) break;
      postMs += this.chunks[index].durationMs;
      keepUntil = index;
    }

    const kept = this.chunks.slice(0, Math.max(0, keepUntil) + 1);
    const segment = {
      buffer: Buffer.concat(kept.map((chunk) => chunk.buffer)),
      sampleRate: this.sampleRate,
      channels: TARGET_CHANNELS,
      encoding: TARGET_ENCODING,
      startedAtMs: this.segmentStartedAtMs,
      endedAtMs: kept.at(-1)?.endMs || this.positionMs,
      durationMs: this._duration(kept),
      speechMs: this.speechMs,
      rms: kept.reduce((total, chunk) => total + chunk.rms, 0) / Math.max(1, kept.length)
    };

    const tail = this.chunks.slice(Math.max(0, keepUntil + 1));
    this.reset();
    for (const chunk of tail) this._pushPreRoll(chunk);
    return segment;
  }
}

export function createVadSegmenter(options = {}) {
  return new VadSegmenter(options);
}
