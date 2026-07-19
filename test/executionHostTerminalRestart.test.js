import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { createExecutionHostClient } from "../src/executionHostClient.js";

const rustBin = process.env.VIBELINK_EXECUTION_HOST_TEST_BIN || "";

function launch(dataDir, pipeName) {
  return spawn(rustBin, ["execd", "--data-dir", dataDir, "--pipe", pipeName], {
    windowsHide: true,
    stdio: "ignore"
  });
}

async function waitForHost(client, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`execd exited with ${child.exitCode}`);
    try {
      return await client.health();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError || new Error("execd did not become ready");
}

function waitForExit(child, timeoutMs = 3_000) {
  if (child.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

async function replayUntil(client, executionId, predicate, { after = 0, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const events = [];
  let cursor = after;
  while (Date.now() < deadline) {
    let page;
    try {
      page = await client.events(executionId, cursor, 128);
    } catch (error) {
      if (error.code !== "EXECUTION_NOT_ATTACHED") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    for (const event of page.events || []) {
      events.push(event);
      cursor = Math.max(cursor, Number(event.hostSeq || 0));
    }
    if (predicate(events)) return { events, cursor };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`terminal replay condition was not met; events=${events.map((event) => event.type).join(",")}`);
}

function outputText(events) {
  return Buffer.concat(events
    .filter((event) => event.type === "stream.stdout" || event.type === "stream.pty")
    .map((event) => event.payload?.encoding === "base64"
      ? Buffer.from(String(event.payload.data || ""), "base64")
      : Buffer.from(String(event.payload?.text ?? event.payload?.data ?? ""), "utf8")))
    .toString("utf8");
}

test("terminal survives Bridge client and execd restart with replay and controls", {
  skip: process.platform !== "win32" || !rustBin || !fs.existsSync(rustBin),
  timeout: 30_000
}, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-terminal-restart-"));
  const pipeName = `\\\\.\\pipe\\vibelink-terminal-restart-${process.pid}-${crypto.randomUUID()}`;
  const executionId = crypto.randomUUID();
  let daemon = launch(dataDir, pipeName);
  let workerPid = 0;
  let processPid = 0;
  const firstBridgeClient = createExecutionHostClient({ pipeName, command: "", requestTimeoutMs: 2000 });

  try {
    await waitForHost(firstBridgeClient, daemon);
    const started = await firstBridgeClient.start({
      executionId,
      kind: "terminal",
      backend: "conpty",
      command: "powershell.exe",
      args: ["-NoLogo", "-NoExit"],
      cwd: dataDir,
      env: { TERM: "xterm-256color" },
      cols: 100,
      rows: 30,
      operationId: `restart-start:${executionId}`
    });
    workerPid = started.workerPid;
    processPid = started.processPid;
    t.diagnostic("terminal worker started");
    await firstBridgeClient.resize(executionId, 111, 37, `resize-before:${executionId}`);
    await firstBridgeClient.input(
      executionId,
      "$e=[char]27; Write-Output \"$e[31mansi-$e[0m\"; Start-Sleep -Milliseconds 400; Write-Output ('during-'+'restart')\r\n",
      "utf8",
      `input-before:${executionId}`
    );

    daemon.kill();
    await waitForExit(daemon);
    t.diagnostic("first execd stopped");

    // A new client has no in-memory socket, cursor, or process handle from the old Bridge runtime.
    daemon = launch(dataDir, pipeName);
    const restartedBridgeClient = createExecutionHostClient({ pipeName, command: "", requestTimeoutMs: 2000 });
    await waitForHost(restartedBridgeClient, daemon);
    t.diagnostic("second execd attached");
    const reattached = await restartedBridgeClient.get(executionId);
    assert.equal(reattached.workerInstanceId, started.workerInstanceId);
    assert.equal(reattached.workerPid, started.workerPid);
    assert.equal(reattached.processPid, started.processPid);
    assert.equal(reattached.processStartedAt, started.processStartedAt);

    const replay = await replayUntil(
      restartedBridgeClient,
      executionId,
      (events) => outputText(events).includes("during-restart")
    );
    const replayedText = outputText(replay.events);
    assert.match(replayedText, /\u001b\[31mansi-\u001b\[m/);
    assert.match(replayedText, /during-restart/);
    t.diagnostic("downtime output replayed");
    await restartedBridgeClient.ack(executionId, replay.cursor, `ack-replay:${executionId}`);

    await restartedBridgeClient.input(executionId, "Write-Output ('after-'+'restart')\r\n", "utf8", `input-after:${executionId}`);
    await restartedBridgeClient.resize(executionId, 132, 44, `resize-after:${executionId}`);
    const after = await replayUntil(
      restartedBridgeClient,
      executionId,
      (events) => outputText(events).includes("after-restart"),
      { after: replay.cursor }
    );
    assert.match(outputText(after.events), /after-restart/);
    t.diagnostic("post-restart input and resize succeeded");

    await restartedBridgeClient.signal(executionId, "stop", `stop-after:${executionId}`);
    const exited = await replayUntil(
      restartedBridgeClient,
      executionId,
      (events) => events.some((event) => event.type === "execution.exited"),
      { after: after.cursor }
    );
    assert.ok(exited.events.some((event) => event.type === "execution.exited"));
    t.diagnostic("post-restart stop succeeded");
  } finally {
    if (daemon.exitCode === null) {
      daemon.kill();
      await waitForExit(daemon);
    }
    if (workerPid) {
      try { process.kill(workerPid); } catch {}
    }
    if (processPid) {
      try { process.kill(processPid); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      t.diagnostic(`fixture cleanup deferred: ${error.code || error.message}`);
    }
  }
});
