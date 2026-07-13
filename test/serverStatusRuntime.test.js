import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");

test("/api/status exposes workspace runtime scanner stats", () => {
  const source = fs.readFileSync(path.join(rootDir, "src", "server.js"), "utf8");

  assert.match(source, /getWorkspaceRuntimeStats/);
  assert.match(source, /workspaceRuntime:\s*getWorkspaceRuntimeStats\(\)/);
  assert.match(source, /controlPlaneRuntime:\s*getStatusRuntimeStats\(\)/);
  assert.match(source, /renderStatusPayload\(statusPayload\)/);
});
