import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");
const extensionDir = path.join(rootDir, "packages", "doubao-cli", "apps", "extension");

test("Doubao bridge extension manifest scopes permissions to Doubao and loopback bridge", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["scripting", "storage", "tabs"].sort());
  assert.ok(manifest.host_permissions.includes("https://www.doubao.com/*"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1/*"));
  assert.ok(manifest.host_permissions.includes("ws://127.0.0.1/*"));
  assert.equal(manifest.background.service_worker, "src/service-worker.js");
  assert.equal(manifest.content_scripts[0].js[0], "src/content/doubao-content.js");
});
