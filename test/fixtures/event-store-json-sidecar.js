import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import { createSqliteEventStore } from "../../src/eventStore.js";
import {
  EVENT_STORE_CONTRACT_METHODS,
  EVENT_STORE_SIDECAR_CONTROL_METHODS,
  EVENT_STORE_SIDECAR_PROTOCOL_VERSION,
  serializeEventStoreError
} from "../../src/eventStoreContract.js";

const dbPath = process.argv[2] || process.env.VIBELINK_EVENT_STORE_DB_PATH;
if (!dbPath) {
  console.error("event-store-json-sidecar requires a db path argument.");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { timeout: 5000 });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

const store = createSqliteEventStore({ database: () => db });
const methods = new Set(EVENT_STORE_CONTRACT_METHODS);
const startedAt = new Date().toISOString();
const runtimeStats = {
  requests: 0,
  responses: 0,
  failures: 0,
  lastRequestAt: "",
  lastResponseAt: "",
  lastFailureAt: "",
  lastError: ""
};
const rl = createInterface({ input: process.stdin });

function nowIso() {
  return new Date().toISOString();
}

function recordRequest() {
  runtimeStats.requests += 1;
  runtimeStats.lastRequestAt = nowIso();
}

function recordResponse() {
  runtimeStats.responses += 1;
  runtimeStats.lastResponseAt = nowIso();
}

function recordFailure(error) {
  runtimeStats.failures += 1;
  runtimeStats.lastFailureAt = nowIso();
  runtimeStats.lastError = error?.message || String(error);
}

function sidecarStats() {
  return {
    implementation: "node-fixture",
    protocolVersion: EVENT_STORE_SIDECAR_PROTOCOL_VERSION,
    startedAt,
    pending: 0,
    ...runtimeStats
  };
}

function health() {
  return {
    ok: true,
    implementation: "node-fixture",
    protocolVersion: EVENT_STORE_SIDECAR_PROTOCOL_VERSION,
    supportedMethods: [...EVENT_STORE_CONTRACT_METHODS],
    controlMethods: [...EVENT_STORE_SIDECAR_CONTROL_METHODS],
    schemaReady: true,
    startedAt
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function close() {
  try {
    db.close();
  } catch {
    // The process is exiting; best-effort close is enough for the fixture.
  }
}

rl.on("line", (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({ id: null, error: serializeEventStoreError(error) });
    return;
  }

  const { id, method, args = [] } = message;
  if (!id) return;
  recordRequest();

  try {
    if (method === "__close") {
      close();
      recordResponse();
      send({ id, result: true });
      process.exit(0);
    }
    if (method === "__health") {
      recordResponse();
      send({ id, result: health() });
      return;
    }
    if (method === "stats") {
      recordResponse();
      send({ id, result: sidecarStats() });
      return;
    }
    if (!methods.has(method) || typeof store[method] !== "function") {
      throw new Error(`Unsupported event store sidecar method: ${method}`);
    }
    const result = store[method](...(Array.isArray(args) ? args : []));
    recordResponse();
    send({ id, result });
  } catch (error) {
    recordFailure(error);
    send({ id, error: serializeEventStoreError(error) });
  }
});

process.on("exit", close);
