import assert from "node:assert/strict";
import test from "node:test";
import { parseSupervisorPid, startSupervisorMonitor } from "../src/supervisorMonitor.js";

test("supervisor pid accepts only a different positive integer", () => {
  assert.equal(parseSupervisorPid("1234", 99), 1234);
  assert.equal(parseSupervisorPid("0", 99), 0);
  assert.equal(parseSupervisorPid("not-a-pid", 99), 0);
  assert.equal(parseSupervisorPid("99", 99), 0);
});

test("supervisor monitor invokes shutdown after the parent disappears", async () => {
  let shutdownSignal = "";
  const stopped = new Promise((resolve) => {
    const monitor = startSupervisorMonitor({
      supervisorPid: 1234,
      intervalMs: 5,
      isAlive: () => false,
      onExit: async (signal) => {
        shutdownSignal = signal;
        resolve();
      }
    });
    assert.ok(monitor);
  });

  await stopped;
  assert.equal(shutdownSignal, "SUPERVISOR_EXIT");
});
