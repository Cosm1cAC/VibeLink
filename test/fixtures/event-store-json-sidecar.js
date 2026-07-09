import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import { createSqliteEventStore } from "../../src/eventStore.js";
import { EVENT_STORE_CONTRACT_METHODS, serializeEventStoreError } from "../../src/eventStoreContract.js";

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
const rl = createInterface({ input: process.stdin });

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

  try {
    if (method === "__close") {
      close();
      send({ id, result: true });
      process.exit(0);
    }
    if (!methods.has(method) || typeof store[method] !== "function") {
      throw new Error(`Unsupported event store sidecar method: ${method}`);
    }
    send({ id, result: store[method](...(Array.isArray(args) ? args : [])) });
  } catch (error) {
    send({ id, error: serializeEventStoreError(error) });
  }
});

process.on("exit", close);
