import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createToolRun,
  drainEventStoreRuntime,
  getEventStoreRuntimeStats,
  insertToolEventsAsync,
  listToolEvents
} from "../src/db.js";

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

function configureRustSidecar(args, extraEnv = {}) {
  const previous = {
    rustFlag: process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR,
    command: process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND,
    args: process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON,
    timeout: process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_TIMEOUT_MS,
    workerFlag: process.env.VIBELINK_EVENT_STORE_WORKER,
    mode: process.env.VIBELINK_EVENT_STORE_TEST_SIDECAR_MODE
  };
  process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR = "1";
  process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND = process.execPath;
  process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON = JSON.stringify(args);
  delete process.env.VIBELINK_EVENT_STORE_WORKER;
  for (const [key, value] of Object.entries(extraEnv)) {
    process.env[key] = value;
  }
  return previous;
}

async function cleanupRustSidecarEnv(previous) {
  await drainEventStoreRuntime();
  restoreEnv("VIBELINK_EVENT_STORE_RUST_SIDECAR", previous.rustFlag);
  restoreEnv("VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND", previous.command);
  restoreEnv("VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON", previous.args);
  restoreEnv("VIBELINK_EVENT_STORE_RUST_SIDECAR_TIMEOUT_MS", previous.timeout);
  restoreEnv("VIBELINK_EVENT_STORE_WORKER", previous.workerFlag);
  restoreEnv("VIBELINK_EVENT_STORE_TEST_SIDECAR_MODE", previous.mode);
}

function fixturePath(name) {
  return path.join(process.cwd(), "test", "fixtures", name);
}

test("db async event store paths use Rust sidecar when explicitly enabled", async () => {
  const previous = configureRustSidecar([fixturePath("event-store-json-sidecar.js")]);
  try {
    const run = createToolRun({
      id: `rust-runtime-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    const cursors = await insertToolEventsAsync(run.id, [
      { id: `${run.id}:event-1`, type: "tool.stdout", text: "one" },
      { id: `${run.id}:event-2`, type: "tool.stdout", text: "two" }
    ]);

    assert.equal(cursors.length, 2);
    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((event) => event.text), ["one", "two"]);
    const stats = getEventStoreRuntimeStats();
    assert.equal(stats.mode, "rust-sidecar");
    assert.equal(stats.rustSidecar.enabled, true);
    assert.equal(stats.rustSidecar.active, true);
    assert.equal(stats.rustSidecar.failed, false);
    assert.equal(stats.metrics.methods.insertToolEvents.modeCounts["rust-sidecar"] >= 1, true);
  } finally {
    await cleanupRustSidecarEnv(previous);
  }
});

test("db async event store paths fall back when Rust sidecar health is not ready", async () => {
  const previous = configureRustSidecar(
    [fixturePath("event-store-failing-sidecar.js")],
    { VIBELINK_EVENT_STORE_TEST_SIDECAR_MODE: "unhealthy" }
  );
  try {
    const run = createToolRun({
      id: `rust-health-fallback-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });
    const beforeFallbacks = getEventStoreRuntimeStats().rustSidecar.fallbacks;

    await insertToolEventsAsync(run.id, [
      { id: `${run.id}:event-1`, type: "tool.stdout", text: "fallback" }
    ]);

    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((event) => event.text), ["fallback"]);
    const stats = getEventStoreRuntimeStats();
    assert.equal(stats.rustSidecar.failed, true);
    assert.equal(stats.rustSidecar.fallbacks > beforeFallbacks, true);
    assert.equal(stats.metrics.methods.insertToolEvents.modeCounts["sync-fallback"] >= 1, true);
  } finally {
    await cleanupRustSidecarEnv(previous);
  }
});

test("db async event store paths fall back when the Rust sidecar command is missing", async () => {
  const previous = configureRustSidecar([]);
  process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND = path.join(
    process.cwd(),
    ".tmp",
    `missing-event-store-sidecar-${Date.now()}.exe`
  );
  try {
    const run = createToolRun({
      id: `rust-missing-fallback-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    await insertToolEventsAsync(run.id, [
      { id: `${run.id}:event-1`, type: "tool.stderr", text: "missing fallback" }
    ]);

    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((event) => event.text), ["missing fallback"]);
    const stats = getEventStoreRuntimeStats();
    assert.equal(stats.rustSidecar.failed, true);
    assert.match(stats.rustSidecar.lastError, /ENOENT|not found|no such file/i);
    assert.equal(stats.metrics.methods.insertToolEvents.modeCounts["sync-fallback"] >= 1, true);
  } finally {
    await cleanupRustSidecarEnv(previous);
  }
});

test("db async event store paths fall back when Rust sidecar requests time out", async () => {
  const previous = configureRustSidecar(
    [fixturePath("event-store-failing-sidecar.js")],
    { VIBELINK_EVENT_STORE_TEST_SIDECAR_MODE: "timeout" }
  );
  process.env.VIBELINK_EVENT_STORE_RUST_SIDECAR_TIMEOUT_MS = "25";
  try {
    const run = createToolRun({
      id: `rust-timeout-fallback-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    await insertToolEventsAsync(run.id, [
      { id: `${run.id}:event-1`, type: "tool.stderr", text: "timeout fallback" }
    ]);

    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((event) => event.text), ["timeout fallback"]);
    const stats = getEventStoreRuntimeStats();
    assert.equal(stats.rustSidecar.failed, true);
    assert.match(stats.rustSidecar.lastError, /timed out/);
    assert.equal(stats.metrics.methods.insertToolEvents.modeCounts["sync-fallback"] >= 1, true);
  } finally {
    await cleanupRustSidecarEnv(previous);
  }
});

test("db async event store paths fall back when Rust sidecar requests fail", async () => {
  const previous = configureRustSidecar(
    [fixturePath("event-store-failing-sidecar.js")],
    { VIBELINK_EVENT_STORE_TEST_SIDECAR_MODE: "request-error" }
  );
  try {
    const run = createToolRun({
      id: `rust-request-fallback-${Date.now()}`,
      toolName: "test.tool",
      status: "running"
    });

    await insertToolEventsAsync(run.id, [
      { id: `${run.id}:event-1`, type: "tool.stderr", text: "request fallback" }
    ]);

    assert.deepEqual(listToolEvents({ toolRunId: run.id }).map((event) => event.text), ["request fallback"]);
    const stats = getEventStoreRuntimeStats();
    assert.equal(stats.rustSidecar.failed, true);
    assert.match(stats.rustSidecar.lastError, /fixture sidecar failed insertToolEvents/);
    assert.equal(stats.metrics.methods.insertToolEvents.modeCounts["sync-fallback"] >= 1, true);
  } finally {
    await cleanupRustSidecarEnv(previous);
  }
});
