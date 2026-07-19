import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createAutomationRuntime, nextAutomationRun } from "../src/automationRuntime.js";

test("automation schedules one-shot, interval, and cron without replaying missed runs", () => {
  const now = new Date("2026-07-20T10:07:30Z");
  assert.equal(nextAutomationRun({ type: "once", value: "2026-07-20T11:00:00Z" }, now).toISOString(), "2026-07-20T11:00:00.000Z");
  assert.equal(nextAutomationRun({ type: "interval", value: "60000" }, now).toISOString(), "2026-07-20T10:08:30.000Z");
  assert.equal(nextAutomationRun({ type: "cron", value: "*/15 * * * *" }, now).toISOString(), "2026-07-20T10:15:00.000Z");
  assert.throws(() => nextAutomationRun({ type: "cron", value: "bad cron" }, now), /cron/i);
});

test("automation runtime persists definitions and prevents concurrent runs", async () => {
  const database = new DatabaseSync(":memory:");
  let resolveRun;
  const executed = [];
  const runtime = createAutomationRuntime({
    database,
    now: () => new Date("2026-07-20T10:00:00Z"),
    executeAutomation: async (item) => { executed.push(item.id); await new Promise((resolve) => { resolveRun = resolve; }); }
  });
  const created = runtime.create({ title: "Daily check", schedule: { type: "interval", value: "60000" }, payload: { prompt: "check" }, enabled: true });
  assert.equal(runtime.list().length, 1);
  const first = runtime.run(created.id);
  const second = await runtime.run(created.id);
  assert.equal(second.started, false);
  assert.equal(second.reason, "already_running");
  resolveRun();
  await first;
  assert.deepEqual(executed, [created.id]);
  assert.equal(runtime.get(created.id).lastStatus, "succeeded");
  runtime.remove(created.id);
  assert.equal(runtime.list().length, 0);
});
