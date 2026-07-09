import { DatabaseSync } from "node:sqlite";
import readline from "node:readline";
import { createSqliteEventStore } from "../../src/eventStore.js";

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
    code: error?.code || ""
  };
}

const dbPath = process.env.VIBELINK_EVENT_STORE_DB_PATH;
if (!dbPath) {
  console.error("missing VIBELINK_EVENT_STORE_DB_PATH");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { timeout: 5000 });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);
const store = createSqliteEventStore({ database: () => db });
const methods = new Set(Object.keys(store));
const input = readline.createInterface({ input: process.stdin });

input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, args = [] } = message;
  if (!id) return;
  try {
    if (method === "__close") {
      db.close();
      process.stdout.write(`${JSON.stringify({ id, result: true })}\n`);
      process.exit(0);
    }
    if (!methods.has(method) || typeof store[method] !== "function") {
      throw new Error(`Unsupported event store sidecar method: ${method}`);
    }
    const result = store[method](...(Array.isArray(args) ? args : []));
    process.stdout.write(`${JSON.stringify({ id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, error: serializeError(error) })}\n`);
  }
});