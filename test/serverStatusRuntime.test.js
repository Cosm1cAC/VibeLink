import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");

test("/api/status keeps the Node fallback status builder without internal Rust callbacks", () => {
  const source = fs.readFileSync(path.join(rootDir, "src", "server.js"), "utf8");

  assert.match(source, /getWorkspaceRuntimeStats/);
  assert.match(source, /workspaceRuntime:\s*getWorkspaceRuntimeStats\(\)/);
  assert.match(source, /controlPlaneRuntime:\s*getStatusRuntimeStats\(\)/);
  assert.match(source, /renderStatusPayload\(await buildStatusSnapshot\(request\)\)/);
  assert.doesNotMatch(source, /\/internal\/status-snapshot/);
  assert.doesNotMatch(source, /\/internal\/doctor-report/);
  assert.doesNotMatch(source, /\/internal\/public-settings/);
  assert.doesNotMatch(source, /\/internal\/reload-settings/);
});

test("settings mutations still rehydrate Node fallback state through public routes", () => {
  const source = fs.readFileSync(path.join(rootDir, "src", "server.js"), "utf8");

  assert.match(source, /settings = ensureNotificationSettings\(await loadSettings\(\)\)/);
  assert.match(source, /scheduleToolEventsPrune\(\)/);
  assert.doesNotMatch(source, /url\.pathname === "\/internal\/reload-settings"/);
});
