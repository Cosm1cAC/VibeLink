import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createStatusRuntime } from "../src/statusRuntime.js";

const fixture = path.join(import.meta.dirname, "fixtures", "fake-status-sidecar.js");
const snapshot = {
  ok: true,
  settings: {},
  providerRegistry: {},
  storage: { sqlite: "db.sqlite" },
  security: {},
  notifications: {},
  workspaces: [],
  workspaceRuntime: {},
  network: [],
  tasks: []
};

function runtimeEnv(overrides = {}) {
  return {
    ...process.env,
    VIBELINK_RUST_STATUS: "1",
    VIBELINK_CONTROL_PLANE_RUST_SIDECAR_COMMAND: process.execPath,
    VIBELINK_CONTROL_PLANE_RUST_SIDECAR_ARGS_JSON: JSON.stringify([fixture]),
    ...overrides
  };
}

test("status runtime is disabled by default", async () => {
  const runtime = createStatusRuntime({ env: {} });
  assert.equal(await runtime.render(snapshot), snapshot);
  assert.equal(runtime.stats().mode, "node");
  assert.equal(runtime.stats().attempts, 0);
});

test("status runtime reuses a healthy Rust sidecar", async (t) => {
  const runtime = createStatusRuntime({
    env: runtimeEnv({ VIBELINK_CONTROL_PLANE_RUST_SIDECAR_TIMEOUT_MS: "invalid" })
  });
  t.after(() => runtime.close());

  assert.deepEqual(await runtime.render(snapshot), snapshot);
  assert.deepEqual(await runtime.render({ ...snapshot, tasks: [{ id: "task-1" }] }), {
    ...snapshot,
    tasks: [{ id: "task-1" }]
  });
  const stats = runtime.stats();
  assert.equal(stats.mode, "rust-sidecar");
  assert.equal(stats.ready, true);
  assert.equal(stats.attempts, 2);
  assert.equal(stats.rustResponses, 2);
  assert.equal(stats.fallbacks, 0);
  assert.equal(stats.client.requests, 3);
});

test("status runtime falls back after readiness failure", async (t) => {
  const runtime = createStatusRuntime({
    env: runtimeEnv({ FAKE_STATUS_SIDECAR_FAIL_HEALTH: "1" }),
    logger: { warn() {} }
  });
  t.after(() => runtime.close());

  assert.equal(await runtime.render(snapshot), snapshot);
  const stats = runtime.stats();
  assert.equal(stats.mode, "node-fallback");
  assert.equal(stats.failed, true);
  assert.equal(stats.fallbacks, 1);
  assert.match(stats.lastError, /fixture health failed/);
});

test("status runtime falls back after readiness timeout", async (t) => {
  const runtime = createStatusRuntime({
    env: runtimeEnv({
      FAKE_STATUS_SIDECAR_HANG_HEALTH: "1",
      VIBELINK_CONTROL_PLANE_RUST_SIDECAR_TIMEOUT_MS: "25"
    }),
    logger: { warn() {} }
  });
  t.after(() => runtime.close());

  assert.equal(await runtime.render(snapshot), snapshot);
  const stats = runtime.stats();
  assert.equal(stats.failed, true);
  assert.equal(stats.fallbacks, 1);
  assert.match(stats.lastError, /timed out: __health/);
  assert.equal(stats.client.timeouts, 1);
});

test("status runtime falls back after render failure", async (t) => {
  const runtime = createStatusRuntime({
    env: runtimeEnv({ FAKE_STATUS_SIDECAR_FAIL_RENDER: "1" }),
    logger: { warn() {} }
  });
  t.after(() => runtime.close());

  assert.equal(await runtime.render(snapshot), snapshot);
  const stats = runtime.stats();
  assert.equal(stats.failed, true);
  assert.equal(stats.fallbacks, 1);
  assert.match(stats.lastError, /fixture render failed/);
});

test("status runtime falls back when the configured command is missing", async (t) => {
  const runtime = createStatusRuntime({
    env: runtimeEnv({ VIBELINK_CONTROL_PLANE_RUST_SIDECAR_COMMAND: path.join(import.meta.dirname, "missing-status-sidecar.exe") }),
    logger: { warn() {} }
  });
  t.after(() => runtime.close());

  assert.equal(await runtime.render(snapshot), snapshot);
  assert.equal(runtime.stats().fallbacks, 1);
  assert.equal(runtime.stats().failed, true);
});
