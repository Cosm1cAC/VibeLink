import { createInterface } from "node:readline";

import {
  COMPRESSION_CONTRACT_METHODS,
  COMPRESSION_SIDECAR_CONTROL_METHODS,
  COMPRESSION_SIDECAR_PROTOCOL_VERSION,
  serializeCompressionError
} from "../../src/compressionContract.js";

const startedAt = new Date().toISOString();
const runtimeStats = {
  requests: 0,
  responses: 0,
  failures: 0,
  bytesIn: 0,
  bytesOut: 0,
  lastRequestAt: "",
  lastResponseAt: "",
  lastFailureAt: "",
  lastError: ""
};
const rl = createInterface({ input: process.stdin });

function nowIso() {
  return new Date().toISOString();
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, error) {
  runtimeStats.failures += 1;
  runtimeStats.lastFailureAt = nowIso();
  runtimeStats.lastError = error?.message || String(error);
  send({ id, error: { ...serializeCompressionError(error), name: "Error" } });
}

function requireOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("options must be an object.");
  }
  return value;
}

function requireCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function trimUtf8(text, options) {
  if (typeof text !== "string") throw new TypeError("text must be a string.");
  const normalized = requireOptions(options);
  const maxBytes = requireCount(normalized.maxBytes, "maxBytes");
  const keep = normalized.keep ?? "tail";
  if (keep !== "head" && keep !== "tail") throw new TypeError("keep must be head or tail.");

  const characters = Array.from(text);
  const output = [];
  let outputBytes = 0;
  const ordered = keep === "head" ? characters : characters.slice().reverse();
  for (const character of ordered) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (outputBytes + bytes > maxBytes) break;
    output.push(character);
    outputBytes += bytes;
  }
  if (keep === "tail") output.reverse();

  const inputBytes = Buffer.byteLength(text, "utf8");
  const result = {
    text: output.join(""),
    inputBytes,
    outputBytes,
    truncated: outputBytes < inputBytes
  };
  runtimeStats.bytesIn += inputBytes;
  runtimeStats.bytesOut += outputBytes;
  return result;
}

function sampleLogLines(lines, options) {
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) {
    throw new TypeError("lines must be an array of strings.");
  }
  const normalized = requireOptions(options);
  const headLines = requireCount(normalized.headLines, "headLines");
  const tailLines = requireCount(normalized.tailLines, "tailLines");
  const headCount = Math.min(headLines, lines.length);
  const tailStart = Math.max(headCount, lines.length - tailLines);
  const sampled = [...lines.slice(0, headCount), ...lines.slice(tailStart)];
  const inputBytes = lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
  const outputBytes = sampled.reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
  const result = {
    lines: sampled,
    inputLines: lines.length,
    outputLines: sampled.length,
    omittedLines: lines.length - sampled.length,
    inputBytes,
    outputBytes,
    truncated: sampled.length < lines.length
  };
  runtimeStats.bytesIn += inputBytes;
  runtimeStats.bytesOut += outputBytes;
  return result;
}

function health() {
  return {
    ok: true,
    implementation: "node-fixture",
    protocolVersion: COMPRESSION_SIDECAR_PROTOCOL_VERSION,
    supportedMethods: [...COMPRESSION_CONTRACT_METHODS],
    controlMethods: [...COMPRESSION_SIDECAR_CONTROL_METHODS],
    startedAt
  };
}

function stats() {
  return {
    implementation: "node-fixture",
    protocolVersion: COMPRESSION_SIDECAR_PROTOCOL_VERSION,
    startedAt,
    pending: 0,
    ...runtimeStats
  };
}

rl.on("line", (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    fail(null, error);
    return;
  }

  const { id = null, method, args = [] } = request;
  runtimeStats.requests += 1;
  runtimeStats.lastRequestAt = nowIso();
  try {
    let result;
    if (method === "__close") {
      result = true;
    } else if (method === "__health") {
      result = health();
    } else if (method === "stats") {
      runtimeStats.responses += 1;
      runtimeStats.lastResponseAt = nowIso();
      send({ id, result: stats() });
      return;
    } else if (method === "trimUtf8") {
      result = trimUtf8(args[0], args[1]);
    } else if (method === "sampleLogLines") {
      result = sampleLogLines(args[0], args[1]);
    } else {
      throw new Error(`Unsupported compression sidecar method: ${method}`);
    }

    runtimeStats.responses += 1;
    runtimeStats.lastResponseAt = nowIso();
    send({ id, result });
    if (method === "__close") process.exit(0);
  } catch (error) {
    fail(id, error);
  }
});
