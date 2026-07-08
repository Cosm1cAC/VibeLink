import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createLiveCallSession,
  listLiveCallEvents,
  listLiveCallEventsReplay,
  recordLiveCallTranscript,
  subscribeLiveCallEvents
} from "../src/liveCall.js";
import { drainEventStoreRuntime, flushLiveCallEventBatches, getEventStoreRuntimeStats, listLiveCallEvents as listPersistedLiveCallEvents } from "../src/db.js";

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

test("live call catch-up replay uses worker query when enabled", async () => {
  const previousWorkerFlag = process.env.VIBELINK_EVENT_STORE_WORKER;
  process.env.VIBELINK_EVENT_STORE_WORKER = "1";

  try {
    const session = createLiveCallSession({ title: "Worker catch-up smoke" });
    recordLiveCallTranscript(session.id, {
      text: "worker catch-up transcript",
      final: true
    });

    const items = await listLiveCallEventsReplay(session.id, { after: 0, limit: 100 });
    const stats = getEventStoreRuntimeStats();

    assert.equal(stats.metrics.methods.listLiveCallEvents.modeCounts.worker >= 1, true);
    assert.equal(items.some((event) => /worker catch-up transcript/.test(event.text || "")), true);
  } finally {
    await drainEventStoreRuntime();
    restoreEnv("VIBELINK_EVENT_STORE_WORKER", previousWorkerFlag);
  }
});

test("live call event append uses worker when enabled", async () => {
  const previousWorkerFlag = process.env.VIBELINK_EVENT_STORE_WORKER;
  process.env.VIBELINK_EVENT_STORE_WORKER = "1";

  try {
    const session = createLiveCallSession({ title: "Worker append smoke" });
    recordLiveCallTranscript(session.id, {
      text: "worker append transcript",
      final: true
    });

    await drainEventStoreRuntime();
    const stats = getEventStoreRuntimeStats();

    assert.equal(stats.metrics.methods.insertLiveCallEvent.modeCounts.worker >= 1, true);
  } finally {
    await drainEventStoreRuntime();
    restoreEnv("VIBELINK_EVENT_STORE_WORKER", previousWorkerFlag);
  }
});

test("live call event append batches persistence while keeping memory events immediate", async () => {
  const previousBatchFlag = process.env.VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND;
  process.env.VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND = "1";

  try {
    const session = createLiveCallSession({ title: "Batched live-call append smoke" });
    recordLiveCallTranscript(session.id, {
      text: "batched live transcript",
      final: true
    });

    assert.equal(listLiveCallEvents(session.id).some((event) => /batched live transcript/.test(event.text || "")), true);
    assert.equal(listPersistedLiveCallEvents({ sessionId: session.id }).some((event) => /batched live transcript/.test(event.text || "")), false);
    assert.equal(getEventStoreRuntimeStats().liveCallBatchAppend.pending >= 2, true);

    await flushLiveCallEventBatches();

    assert.equal(listPersistedLiveCallEvents({ sessionId: session.id }).some((event) => /batched live transcript/.test(event.text || "")), true);
  } finally {
    await drainEventStoreRuntime();
    restoreEnv("VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND", previousBatchFlag);
  }
});
