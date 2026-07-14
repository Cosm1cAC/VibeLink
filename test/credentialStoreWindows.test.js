import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Windows credential store round-trips DPAPI files with trailing newlines", { skip: process.platform !== "win32" }, async () => {
  const previousDataDir = process.env.VIBELINK_DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-node-dpapi-"));
  process.env.VIBELINK_DATA_DIR = dataDir;
  try {
    const store = await import(`../src/credentialStore.js?test=${Date.now()}`);
    assert.equal(await store.writeSecret("openai", "node-dpapi-secret"), true);
    const ciphertext = fs.readFileSync(path.join(dataDir, "secrets", "openai.dpapi"), "utf8");
    assert.ok(ciphertext.trim().length > 0);
    assert.equal(ciphertext.includes("node-dpapi-secret"), false);
    assert.equal(await store.readSecret("openai"), "node-dpapi-secret");
  } finally {
    if (previousDataDir === undefined) delete process.env.VIBELINK_DATA_DIR;
    else process.env.VIBELINK_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
