import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");

function rustRunner(t) {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["debug", "release"]) {
    const command = path.join(rootDir, "apps", "windows", "target", profile, binary);
    if (fs.existsSync(command)) return { command, args: ["status-sidecar"], timeoutMs: 30000 };
  }
  const lookup = process.platform === "win32"
    ? spawnSync("where.exe", ["cargo"], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-lc", "command -v cargo"], { encoding: "utf8", windowsHide: true });
  if (lookup.status !== 0) {
    t.skip("cargo and a built VibeLink binary are unavailable");
    return null;
  }
  return {
    command: String(lookup.stdout || "").trim().split(/\r?\n/)[0],
    args: ["run", "--quiet", "--manifest-path", path.join(rootDir, "apps", "windows", "Cargo.toml"), "--", "status-sidecar"],
    timeoutMs: 120000
  };
}

function jsonlClient({ command, args, timeoutMs }) {
  const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  child.on("exit", (code) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`status sidecar exited with code ${code}: ${stderr}`));
    }
    pending.clear();
  });
  return {
    request(method, args = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`status sidecar timed out: ${method}; ${stderr}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
      });
    },
    stop() {
      if (!child.killed) child.kill();
    }
  };
}

function statusSnapshot(overrides = {}) {
  return {
    ok: true,
    settings: { port: 8787 },
    providerRegistry: { providers: [] },
    storage: { sqlite: "C:/data/vibelink.sqlite" },
    security: { warnings: [], devices: [], cloudflare: {} },
    notifications: { webPush: {}, emailFallback: { configured: false } },
    workspaces: [],
    workspaceRuntime: { rust: { mode: "canary" } },
    network: [],
    tasks: [],
    ...overrides
  };
}

test("Rust status JSONL sidecar validates and assembles status snapshots", async (t) => {
  const runner = rustRunner(t);
  if (!runner) return;
  const client = jsonlClient(runner);

  try {
    assert.deepEqual(await client.request("__health"), {
      ok: true,
      implementation: "rust",
      protocolVersion: 1,
      supportedMethods: ["renderStatus"]
    });

    const first = statusSnapshot();
    assert.deepEqual(await client.request("renderStatus", [first]), first);
    const second = statusSnapshot({ tasks: [{ id: "task-1", status: "running" }] });
    assert.deepEqual(await client.request("renderStatus", [second]), second);

    await assert.rejects(
      client.request("renderStatus", [statusSnapshot({ workspaces: "invalid" })]),
      /workspaces/i
    );
    const stats = await client.request("stats");
    assert.equal(stats.renders, 2);
    assert.equal(stats.failures, 1);
    assert.equal(stats.requests, 5);
    assert.equal(stats.responses, 3);
    assert.equal(await client.request("__close"), true);
  } finally {
    client.stop();
  }
});
