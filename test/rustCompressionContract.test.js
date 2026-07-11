import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPRESSION_CONTRACT_METHODS,
  COMPRESSION_SIDECAR_CONTROL_METHODS,
  COMPRESSION_SIDECAR_PROTOCOL_VERSION,
  compressionErrorFromPayload
} from "../src/compressionContract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function rustSidecarRunner(t) {
  if (process.env.VIBELINK_RUST_COMPRESSION_COMMAND) {
    let args = ["compression-sidecar"];
    try {
      const parsed = JSON.parse(process.env.VIBELINK_RUST_COMPRESSION_ARGS_JSON || "[]");
      if (Array.isArray(parsed) && parsed.length) args = parsed.map(String);
    } catch {
      // Keep the documented default when the optional test override is invalid.
    }
    return { command: process.env.VIBELINK_RUST_COMPRESSION_COMMAND, args, timeoutMs: 30000 };
  }

  const binaryName = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["release", "debug"]) {
    const command = path.join(rootDir, "apps", "windows", "target", profile, binaryName);
    if (fs.existsSync(command)) return { command, args: ["compression-sidecar"], timeoutMs: 30000 };
  }

  const cargoLookup = process.platform === "win32"
    ? spawnSync("where.exe", ["cargo"], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-lc", "command -v cargo"], { encoding: "utf8", windowsHide: true });
  if (cargoLookup.status !== 0) {
    t.skip("cargo and a built VibeLink binary are unavailable");
    return null;
  }
  const cargo = String(cargoLookup.stdout || "").trim().split(/\r?\n/)[0];
  return {
    command: cargo,
    args: ["run", "--quiet", "--manifest-path", path.join(rootDir, "apps", "windows", "Cargo.toml"), "--", "compression-sidecar"],
    timeoutMs: 120000
  };
}

function createJsonlClient({ command, args = [], timeoutMs = 5000 }) {
  const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const pendingNull = [];
  const rl = createInterface({ input: child.stdout });
  let nextId = 1;
  let stderr = "";
  let closed = false;

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  rl.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      return;
    }
    const entry = message.id === null ? pendingNull.shift() : pending.get(message.id);
    if (!entry) return;
    if (message.id !== null) pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(compressionErrorFromPayload(message.error));
    else entry.resolve(message.result);
  });
  child.on("exit", (code, signal) => {
    closed = true;
    const suffix = stderr.trim() ? ` ${stderr.trim()}` : "";
    const error = new Error(`Compression sidecar exited (${signal || code}).${suffix}`);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    for (const entry of pendingNull) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    pendingNull.length = 0;
  });

  function wait(id, write) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (id === null) pendingNull.shift();
        else pending.delete(id);
        reject(new Error(`Compression sidecar request timed out.${stderr.trim() ? ` ${stderr.trim()}` : ""}`));
      }, timeoutMs);
      const entry = { resolve, reject, timer };
      if (id === null) pendingNull.push(entry);
      else pending.set(id, entry);
      child.stdin.write(write, "utf8");
    });
  }

  return {
    request(method, args = []) {
      const id = nextId++;
      return wait(id, `${JSON.stringify({ id, method, args })}\n`);
    },
    raw(line) {
      return wait(null, `${line}\n`);
    },
    async close() {
      if (closed) return;
      const result = await this.request("__close");
      assert.equal(result, true);
    }
  };
}

async function verifyContract(client, implementation) {
  const health = await client.request("__health");
  assert.equal(health.ok, true);
  assert.equal(health.implementation, implementation);
  assert.equal(health.protocolVersion, COMPRESSION_SIDECAR_PROTOCOL_VERSION);
  assert.deepEqual(health.supportedMethods, [...COMPRESSION_CONTRACT_METHODS]);
  assert.deepEqual(health.controlMethods, [...COMPRESSION_SIDECAR_CONTROL_METHODS]);
  assert.ok(Date.parse(health.startedAt));

  const text = `ab\u{1F600}\u4E2Dcd`;
  assert.deepEqual(await client.request("trimUtf8", [text, { maxBytes: 6, keep: "head" }]), {
    text: `ab\u{1F600}`,
    inputBytes: 11,
    outputBytes: 6,
    truncated: true
  });
  assert.deepEqual(await client.request("trimUtf8", [text, { maxBytes: 6 }]), {
    text: `\u4E2Dcd`,
    inputBytes: 11,
    outputBytes: 5,
    truncated: true
  });
  assert.deepEqual(await client.request("trimUtf8", [text, { maxBytes: 0, keep: "tail" }]), {
    text: "",
    inputBytes: 11,
    outputBytes: 0,
    truncated: true
  });

  assert.deepEqual(
    await client.request("sampleLogLines", [["L1", "L2", "L3", "L4", "L5", "L6"], { headLines: 2, tailLines: 2 }]),
    {
      lines: ["L1", "L2", "L5", "L6"],
      inputLines: 6,
      outputLines: 4,
      omittedLines: 2,
      inputBytes: 12,
      outputBytes: 8,
      truncated: true
    }
  );
  assert.deepEqual(
    await client.request("sampleLogLines", [["a", "\u4E2D", "c"], { headLines: 2, tailLines: 2 }]),
    {
      lines: ["a", "\u4E2D", "c"],
      inputLines: 3,
      outputLines: 3,
      omittedLines: 0,
      inputBytes: 5,
      outputBytes: 5,
      truncated: false
    }
  );

  await assert.rejects(client.request("trimUtf8", [text, { maxBytes: 6, keep: "middle" }]), (error) => {
    assert.equal(error.name, "Error");
    assert.match(error.message, /keep must be head or tail/i);
    return true;
  });
  await assert.rejects(
    client.request("trimUtf8", [text, { maxBytes: -1 }]),
    /non-negative|invalid value/i
  );
  await assert.rejects(
    client.request("trimUtf8", [text, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }]),
    /non-negative integer/i
  );
  await assert.rejects(
    client.request("sampleLogLines", [["ok", 42], { headLines: 1, tailLines: 1 }]),
    /strings|string/i
  );
  const stats = await client.request("stats");
  assert.equal(stats.implementation, implementation);
  assert.equal(stats.protocolVersion, COMPRESSION_SIDECAR_PROTOCOL_VERSION);
  assert.equal(stats.pending, 0);
  assert.equal(stats.requests, 11);
  assert.equal(stats.responses, 7);
  assert.equal(stats.failures, 4);
  assert.equal(stats.bytesIn, 50);
  assert.equal(stats.bytesOut, 24);
  assert.ok(Date.parse(stats.lastRequestAt));
  assert.ok(Date.parse(stats.lastResponseAt));
  assert.ok(Date.parse(stats.lastFailureAt));
  assert.match(stats.lastError, /string/i);

  await assert.rejects(client.raw("{not-json"), (error) => {
    assert.equal(error.name, "Error");
    assert.match(error.message, /json|expected|key/i);
    return true;
  });
  const malformedStats = await client.request("stats");
  assert.equal(malformedStats.failures, 5);
  assert.equal(malformedStats.requests, 12);
  assert.equal(malformedStats.responses, 8);
  assert.equal(malformedStats.bytesIn, 50);
  assert.equal(malformedStats.bytesOut, 24);
}

test("compression JSONL fixture satisfies protocol v1", async () => {
  const client = createJsonlClient({
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "compression-json-sidecar.js")]
  });
  try {
    await verifyContract(client, "node-fixture");
  } finally {
    await client.close();
  }
});

test("Rust compression sidecar satisfies protocol v1", async (t) => {
  const runner = rustSidecarRunner(t);
  if (!runner) return;
  const client = createJsonlClient(runner);
  try {
    await verifyContract(client, "rust");
  } finally {
    await client.close().catch(() => {});
  }
});
