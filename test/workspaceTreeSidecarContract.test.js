import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

function rustRunner(t) {
  const binary = process.platform === "win32" ? "vibelink.exe" : "vibelink";
  for (const profile of ["release", "debug"]) {
    const command = path.join(process.cwd(), "apps", "windows", "target", profile, binary);
    if (fs.existsSync(command)) return { command, args: ["workspace-tree-sidecar"], timeoutMs: 30000 };
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
    args: ["run", "--quiet", "--manifest-path", path.join(process.cwd(), "apps", "windows", "Cargo.toml"), "--", "workspace-tree-sidecar"],
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
      request.reject(new Error(`workspace-tree sidecar exited with code ${code}: ${stderr}`));
    }
    pending.clear();
  });
  return {
    request(method, args = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`workspace-tree sidecar timed out: ${method}; ${stderr}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
      });
    }
  };
}

test("Rust workspace-tree JSONL sidecar scans repeatedly in one process", async (t) => {
  const runner = rustRunner(t);
  if (!runner) return;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-sidecar-"));
  fs.mkdirSync(path.join(fixture, "src"));
  fs.writeFileSync(path.join(fixture, "README.md"), "readme", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "index.js"), "export {};", "utf8");
  fs.writeFileSync(path.join(fixture, ".hidden"), "hidden", "utf8");
  const client = jsonlClient(runner);

  try {
    const health = await client.request("__health");
    assert.equal(health.ok, true);
    assert.equal(health.implementation, "rust");
    assert.equal(health.protocolVersion, 1);
    assert.deepEqual(health.supportedMethods, ["scan"]);

    const root = await client.request("scan", [{ root: fixture, dir: ".", depth: 1, maxEntries: 20 }]);
    assert.equal(root.ok, true);
    assert.deepEqual(root.items.map((item) => item.name), ["src", "README.md"]);
    const nested = await client.request("scan", [{ root: fixture, dir: "src", depth: 1, maxEntries: 20 }]);
    assert.deepEqual(nested.items.map((item) => item.path), ["src/index.js"]);

    const stats = await client.request("stats");
    assert.equal(stats.scans, 2);
    assert.equal(stats.failures, 0);
    assert.equal(stats.pending, 0);
    assert.equal(stats.requests, 4);
    assert.equal(stats.responses, 3);
    assert.equal(await client.request("__close"), true);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
