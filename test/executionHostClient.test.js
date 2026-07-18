import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import test from "node:test";

import { createExecutionHostClient, createExecutionHostFacade } from "../src/executionHostClient.js";

function listen(server, pipeName) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("execution host client uses bounded v1 frames and maps protocol errors", async () => {
  const pipeName = `\\\\.\\pipe\\vibelink-execution-host-client-${process.pid}-${crypto.randomUUID()}`;
  let requests = 0;
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32LE(0);
      if (buffered.length < length + 4) return;
      const request = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
      requests += 1;
      const response = request.method === "execution.get"
        ? {
            protocolVersion: 1,
            requestId: request.requestId,
            error: { code: "EXECUTION_NOT_FOUND", message: "missing", retryable: false, details: {} }
          }
        : {
            protocolVersion: 1,
            requestId: request.requestId,
            result: { ok: true, method: request.method }
          };
      const payload = Buffer.from(JSON.stringify(response));
      const frame = Buffer.alloc(4 + payload.length);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      socket.end(frame);
    });
  });
  await listen(server, pipeName);
  const client = createExecutionHostClient({ pipeName, command: "", requestTimeoutMs: 1000 });
  try {
    assert.deepEqual(await client.health(), { ok: true, method: "host.health" });
    await assert.rejects(
      () => client.get(crypto.randomUUID()),
      (error) => error.code === "EXECUTION_NOT_FOUND" && error.retryable === false
    );
    assert.equal(requests, 3);
  } finally {
    await close(server);
  }
});

test("execution host facade replays UTF-8 streams, acknowledges events, and keeps the execution id", async () => {
  const executionId = crypto.randomUUID();
  const utf8 = Buffer.from("你", "utf8");
  const pages = [
    [
      { executionId, hostSeq: 1, eventId: `${executionId}:1`, type: "stream.stdout", payload: { encoding: "base64", data: utf8.subarray(0, 2).toString("base64") } },
      { executionId, hostSeq: 2, eventId: `${executionId}:2`, type: "stream.stdout", payload: { encoding: "base64", data: utf8.subarray(2).toString("base64") } },
      { executionId, hostSeq: 3, eventId: `${executionId}:3`, type: "stream.stderr", payload: { encoding: "base64", data: Buffer.from("warn\n").toString("base64") } }
    ],
    [{ executionId, hostSeq: 4, eventId: `${executionId}:4`, type: "execution.exited", payload: { exitCode: 0, signal: "" } }]
  ];
  const acknowledgements = [];
  const starts = [];
  const client = {
    async start(params) {
      starts.push(params);
      return { executionId, status: "running", signal: "", exitCode: null };
    },
    async events() {
      return { events: pages.shift() || [], lastHostSeq: 4 };
    },
    async ack(id, hostSeq, idempotencyKey) {
      acknowledgements.push({ id, hostSeq, idempotencyKey });
      return { ackedHostSeq: hostSeq };
    },
    async get() {
      return { executionId, status: "running", signal: "", exitCode: null };
    },
    async signal() {
      throw new Error("signal should not be called");
    }
  };
  const output = [];
  const facade = createExecutionHostFacade({ client, pollIntervalMs: 1 });
  const result = await facade.runCommand({
    executionId,
    shell: "shell",
    args: ["arg"],
    cwd: "C:\\workspace",
    env: { PATH: "bin" },
    onOutput: (chunk) => output.push(chunk)
  });

  assert.equal(result.ok, true);
  assert.equal(result.executionId, executionId);
  assert.equal(result.stdout, "你");
  assert.equal(result.stderr, "warn\n");
  assert.equal(output.map((chunk) => chunk.text).join(""), "你warn\n");
  assert.equal(starts[0].executionId, executionId);
  assert.equal(starts[0].kind, "command");
  assert.equal(starts[0].backend, "stdio");
  assert.deepEqual(acknowledgements.map((item) => item.hostSeq), [3]);
});

test("execution host facade translates timeout and cancellation into stop signals", async () => {
  async function run(reason) {
    const executionId = crypto.randomUUID();
    let status = "running";
    const signals = [];
    const client = {
      async start() { return { executionId, status, signal: "", exitCode: null }; },
      async events() {
        if (status === "cancelled") {
          return { events: [{ executionId, hostSeq: 1, eventId: `${executionId}:1`, type: "execution.exited", payload: { exitCode: 3221225786, signal: "stop" } }] };
        }
        return { events: [] };
      },
      async ack() { return { ackedHostSeq: 1 }; },
      async get() { return { executionId, status, signal: status === "cancelled" ? "stop" : "", exitCode: null }; },
      async signal(id, signal, idempotencyKey) {
        signals.push({ id, signal, idempotencyKey });
        status = "cancelled";
        return { accepted: true };
      }
    };
    const controller = new AbortController();
    if (reason === "cancelled") controller.abort();
    const facade = createExecutionHostFacade({ client, pollIntervalMs: 1 });
    const result = await facade.runCommand({
      executionId,
      shell: "shell",
      timeoutMs: reason === "timeout" ? 5 : 1000,
      signal: controller.signal
    });
    return { result, signals };
  }

  const timedOut = await run("timeout");
  assert.equal(timedOut.result.timedOut, true);
  assert.equal(timedOut.result.exitCode, -1);
  assert.match(timedOut.result.stderr, /timed out after 5ms/);
  assert.equal(timedOut.signals[0].signal, "stop");

  const cancelled = await run("cancelled");
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(cancelled.result.exitCode, -1);
  assert.equal(cancelled.result.stderr, "Command stopped by user.");
  assert.equal(cancelled.signals[0].signal, "stop");
});
