import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-task-database-restore-"));
process.env.VIBELINK_DATA_DIR = dataDir;

const { getTask, subscribeTask } = await import("../src/agents.js");
const { insertTaskEvent, upsertTask } = await import("../src/db.js");

test("getTask lazily restores a persisted task that is absent from the in-memory restore window", () => {
  const id = "persisted-task-outside-restore-window";
  upsertTask({
    id,
    agent: "codex",
    title: "Persisted task",
    cwd: dataDir,
    status: "done",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:01:00.000Z",
    exitCode: 0,
    sessionId: "session-persisted",
    commandLabel: "codex exec",
    logPath: path.join(dataDir, "tasks", `${id}.jsonl`)
  });
  insertTaskEvent(id, {
    id: "persisted-event",
    type: "assistant",
    text: "restored from sqlite",
    at: "2026-07-01T00:00:30.000Z"
  });

  const task = getTask(id);

  assert.equal(task?.id, id);
  assert.equal(task?.status, "done");
  assert.equal(task?.sessionId, "session-persisted");
  assert.equal(task?.events.some((event) => event.text === "restored from sqlite"), true);
});

test("task event subscription lazily restores a persisted task", async () => {
  const id = "persisted-task-for-subscription";
  upsertTask({
    id,
    agent: "codex",
    title: "Persisted subscription",
    cwd: dataDir,
    status: "done",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:01:00.000Z",
    exitCode: 0,
    sessionId: "",
    commandLabel: "codex exec",
    logPath: path.join(dataDir, "tasks", `${id}.jsonl`)
  });

  const response = {
    chunks: [],
    closeHandler: null,
    writeHead(status) { this.status = status; },
    write(chunk) { this.chunks.push(String(chunk)); },
    on(event, handler) {
      if (event === "close") this.closeHandler = handler;
    }
  };

  assert.equal(await subscribeTask(id, response), true);
  assert.equal(response.status, 200);
  response.closeHandler();
});
