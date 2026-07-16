import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceTreeSidecarClient } from "../src/workspaceTreeSidecarClient.js";

function writeFixture(dir, { invalidJson = false } = {}) {
  const fixture = path.join(dir, "workspace-tree-sidecar-fixture.mjs");
  fs.writeFileSync(fixture, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
let requests = 0;
let scans = 0;
lines.on("line", (line) => {
  const request = JSON.parse(line);
  requests += 1;
  if (${JSON.stringify(invalidJson)} && request.method === "scan") {
    process.stdout.write("not-json\\n");
    return;
  }
  let result;
  if (request.method === "__health") result = { ok: true, implementation: "fixture", protocolVersion: 1 };
  else if (request.method === "scan") {
    scans += 1;
    result = { ok: true, dir: request.args[0].dir, truncated: false, signature: String(scans), items: [] };
  } else if (request.method === "stats") result = { requests, scans, pending: 0, failures: 0 };
  else if (request.method === "__close") result = true;
  else result = null;
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  if (request.method === "__close") process.exit(0);
});
`, "utf8");
  return fixture;
}

test("workspace-tree sidecar client reuses one JSONL process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-client-"));
  const fixture = writeFixture(dir);
  const client = createWorkspaceTreeSidecarClient({ command: process.execPath, args: [fixture], timeoutMs: 5000 });
  try {
    assert.equal((await client.health()).ok, true);
    assert.equal((await client.scan({ root: dir, dir: "one" })).dir, "one");
    assert.equal((await client.scan({ root: dir, dir: "two" })).dir, "two");
    const remoteStats = await client.getSidecarStats();
    assert.equal(remoteStats.scans, 2);
    assert.equal(client.stats().pending, 0);
    assert.equal(client.stats().responses, 4);
  } finally {
    await client.close();
    assert.equal(client.stats().terminated, true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace-tree sidecar client rejects invalid JSON", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-client-json-"));
  const fixture = writeFixture(dir, { invalidJson: true });
  const client = createWorkspaceTreeSidecarClient({ command: process.execPath, args: [fixture], timeoutMs: 5000 });
  try {
    await assert.rejects(client.scan({ root: dir, dir: "." }), /invalid JSON/i);
    assert.equal(client.stats().failures, 1);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
