import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { createSqliteEventStore } from "./eventStore.js";

const methods = new Set([
  "insertTaskEvent",
  "insertTaskEvents",
  "listTaskEvents",
  "getTaskEventCount",
  "insertToolEvent",
  "insertToolEvents",
  "listToolEvents",
  "getToolEventStats",
  "pruneToolEvents",
  "insertLiveCallEvent",
  "insertLiveCallEvents",
  "listLiveCallEvents",
  "pruneLiveCallEvents",
  "listUnifiedEvents",
  "replayWindow"
]);

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
    code: error?.code || ""
  };
}

if (!parentPort) {
  throw new Error("eventStoreWorker must run inside a Worker thread.");
}

const dbPath = workerData?.dbPath;
if (!dbPath) {
  throw new Error("eventStoreWorker requires workerData.dbPath.");
}

const db = new DatabaseSync(dbPath, { timeout: 5000 });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

const store = createSqliteEventStore({ database: () => db });

parentPort.on("message", (message = {}) => {
  const { id, method, args = [] } = message;
  if (!id) return;

  try {
    if (method === "__close") {
      if (typeof db.close === "function") db.close();
      parentPort.postMessage({ id, result: true });
      parentPort.close();
      return;
    }
    if (!methods.has(method) || typeof store[method] !== "function") {
      throw new Error(`Unsupported event store worker method: ${method}`);
    }
    const result = store[method](...(Array.isArray(args) ? args : []));
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: serializeError(error) });
  }
});
