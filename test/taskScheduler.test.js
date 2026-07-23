import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createTaskQueuePersistence, ensureTaskQueueSchema } from "../src/taskQueuePersistence.js";
import { createTaskScheduler } from "../src/taskScheduler.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE tasks (id TEXT PRIMARY KEY);
    INSERT INTO tasks (id) VALUES ('task-1'), ('task-2'), ('task-3');
  `);
  ensureTaskQueueSchema(db);
  return { db, store: createTaskQueuePersistence({ database: () => db }) };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for scheduler state.");
}

test("persistent scheduler enforces the concurrency limit", async () => {
  const { store } = fixture();
  let active = 0;
  let peak = 0;
  const scheduler = createTaskScheduler({
    store,
    concurrency: 2,
    pollIntervalMs: 10,
    execute: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return { status: "done" };
    }
  });
  scheduler.enqueue({ taskId: "task-1", payload: {} });
  scheduler.enqueue({ taskId: "task-2", payload: {} });
  scheduler.enqueue({ taskId: "task-3", payload: {} });
  scheduler.start();
  await waitFor(() => active === 2);
  assert.equal(peak, 2);
  assert.equal(scheduler.status().counts.queued, 1);
  await waitFor(() => scheduler.status().counts.completed === 3);
  scheduler.stop();
});

test("failed jobs retry up to maxAttempts and persist the terminal error", async () => {
  const { store } = fixture();
  let calls = 0;
  const scheduler = createTaskScheduler({
    store,
    concurrency: 1,
    pollIntervalMs: 5,
    retryBaseMs: 5,
    execute: async () => {
      calls += 1;
      throw new Error(`failure-${calls}`);
    }
  });
  scheduler.enqueue({ taskId: "task-1", payload: {}, maxAttempts: 3 });
  scheduler.start();
  const failed = await waitFor(() => scheduler.status().items.find((job) => job.status === "failed"));
  assert.equal(calls, 3);
  assert.equal(failed.attempts, 3);
  assert.equal(failed.lastError, "failure-3");
  scheduler.stop();
});

test("startup recovers orphaned running jobs but preserves reattached tasks", () => {
  const { store } = fixture();
  store.enqueue({ id: "job-1", taskId: "task-1", payload: {} });
  store.enqueue({ id: "job-2", taskId: "task-2", payload: {} });
  store.claimNext();
  store.claimNext();
  assert.equal(store.recoverRunning({ preserveTaskIds: ["task-2"] }), 1);
  assert.equal(store.get("task-1").status, "queued");
  assert.equal(store.get("task-2").status, "running");
});

test("passive scheduler persists work without claiming Rust-owned jobs", async () => {
  const { store } = fixture();
  let calls = 0;
  const scheduler = createTaskScheduler({
    store,
    passive: true,
    pollIntervalMs: 5,
    execute: async () => {
      calls += 1;
      return { status: "done" };
    }
  });
  scheduler.enqueue({ taskId: "task-1", payload: { prompt: "rust owns this" } });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 0);
  assert.equal(store.get("task-1").status, "queued");
  assert.equal(scheduler.status().owner, "rust-execd");
  scheduler.stop();
});
