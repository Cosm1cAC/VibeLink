import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createLiveCallSession, recordLiveCallTranscript, subscribeLiveCallEvents } from "../src/liveCall.js";
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

test("live call SSE replay uses worker query when enabled", async () => {
  const previousWorkerFlag = process.env.VIBELINK_EVENT_STORE_WORKER;
  process.env.VIBELINK_EVENT_STORE_WORKER = "1";

  try {
    const session = createLiveCallSession({ title: "Worker replay smoke" });
    recordLiveCallTranscript(session.id, {
      text: "worker live transcript",
      final: true
    });

    const response = new FakeSseResponse();
    assert.equal(await subscribeLiveCallEvents(session.id, response, { after: 0 }), true);
    response.close();

    const stats = getEventStoreRuntimeStats();
    assert.equal(stats.metrics.methods.listLiveCallEvents.modeCounts.worker >= 1, true);
    assert.match(response.chunks.join(""), /worker live transcript/);
  } finally {
    await drainEventStoreRuntime();
    restoreEnv("VIBELINK_EVENT_STORE_WORKER", previousWorkerFlag);
  }
});
