import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createExecutionHostFacade } from "../src/executionHostClient.js";
import { resizeTerminalSession, startTerminalSession, stopTerminalSession, writeTerminalSession } from "../src/terminalRuntime.js";

test("terminal facade preserves the execution id and maps input, resize, signal, and replay", async () => {
  const executionId = crypto.randomUUID();
  const calls = [];
  let status = "running";
  let eventsServed = false;
  const snapshot = () => ({
    executionId,
    kind: "terminal",
    status,
    processPid: 4242,
    lastAckedHostSeq: 0,
    capabilities: { input: true, resize: true, backend: "conpty" },
    startedAt: "2026-07-18T00:00:00.000Z",
    endedAt: status === "running" ? "" : "2026-07-18T00:00:01.000Z",
    exitCode: status === "running" ? null : 0,
    signal: status === "running" ? "" : "stop"
  });
  const client = {
    async start(params) { calls.push(["start", params]); return snapshot(); },
    async list() { return { executions: [snapshot()] }; },
    async get() { return snapshot(); },
    async events() {
      if (eventsServed) return { events: [] };
      eventsServed = true;
      const ansi = Buffer.from("\u001b[32m你\u001b[0m", "utf8");
      return {
        events: [
          { hostSeq: 1, type: "stream.stdout", payload: { encoding: "base64", data: ansi.subarray(0, 6).toString("base64") } },
          { hostSeq: 2, type: "stream.stdout", payload: { encoding: "base64", data: ansi.subarray(6).toString("base64") } }
        ]
      };
    },
    async ack(id, seq, operationId) { calls.push(["ack", { id, seq, operationId }]); },
    async input(id, data, encoding, operationId) { calls.push(["input", { id, data, encoding, operationId }]); },
    async resize(id, cols, rows, operationId) { calls.push(["resize", { id, cols, rows, operationId }]); },
    async signal(id, signal, operationId) { calls.push(["signal", { id, signal, operationId }]); status = "cancelled"; }
  };
  const facade = createExecutionHostFacade({ client, pollIntervalMs: 1 });
  let output = "";
  const session = await startTerminalSession({
    id: executionId,
    cwd: "C:\\workspace",
    shell: "powershell.exe",
    executionHost: facade,
    onOutput: (chunk) => { output += chunk.text; }
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(session.id, executionId);
  assert.equal(session.mode, "pty");
  assert.equal(output, "\u001b[32m你\u001b[0m");
  assert.equal((await writeTerminalSession(executionId, "echo ok\r\n")).ok, true);
  assert.equal((await resizeTerminalSession(executionId, 132, 44)).ok, true);
  assert.equal((await stopTerminalSession(executionId, "test stop")).ok, true);
  assert.equal(calls.find(([method]) => method === "start")[1].executionId, executionId);
  assert.deepEqual(calls.find(([method]) => method === "input")[1], {
    id: executionId,
    data: "echo ok\r\n",
    encoding: "utf8",
    operationId: calls.find(([method]) => method === "input")[1].operationId
  });
  assert.equal(calls.find(([method]) => method === "resize")[1].cols, 132);
  assert.equal(calls.find(([method]) => method === "signal")[1].signal, "stop");
  assert.equal(calls.find(([method]) => method === "ack")[1].seq, 2);
});
