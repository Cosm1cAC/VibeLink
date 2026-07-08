import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import { createTask, subscribeTask } from "../src/agents.js";
import { defaultSettings } from "../src/config.js";
import { drainEventStoreRuntime, getEventStoreRuntimeStats } from "../src/db.js";

class FakeSseResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.chunks = [];
    this.headers = null;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  close() {
    this.writableEnded = true;
    this.emit("close");
  }
}

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

test("task SSE replay uses worker query when enabled", async () => {
  const previousWorkerFlag = process.env.VIBELINK_EVENT_STORE_WORKER;
  process.env.VIBELINK_EVENT_STORE_WORKER = "1";

  try {
    const missingCommand = path.join(process.cwd(), ".does-not-exist", "codex.exe");
    const task = await createTask(
      {
        agent: "codex",
        prompt: "worker replay smoke",
        cwd: process.cwd()
      },
      {
        ...defaultSettings,
        codexCommand: missingCommand,
        defaultCwd: process.cwd(),
        allowedRoots: [process.cwd()],
        security: {
          ...defaultSettings.security,
          requireTrustedWorkspace: false
        }
      }
    );

    assert.equal(task.status, "failed");
    const response = new FakeSseResponse();
    assert.equal(await subscribeTask(task.id, response, { after: 0 }), true);
    response.close();

    const stats = getEventStoreRuntimeStats();
    assert.equal(stats.metrics.methods.listTaskEvents.modeCounts.worker >= 1, true);
    assert.match(response.chunks.join(""), /Agent executable not found/);
  } finally {
    await drainEventStoreRuntime();
    restoreEnv("VIBELINK_EVENT_STORE_WORKER", previousWorkerFlag);
  }
});
