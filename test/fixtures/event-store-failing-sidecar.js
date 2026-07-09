import { createInterface } from "node:readline";

import {
  EVENT_STORE_CONTRACT_METHODS,
  EVENT_STORE_SIDECAR_CONTROL_METHODS,
  EVENT_STORE_SIDECAR_PROTOCOL_VERSION,
  serializeEventStoreError
} from "../../src/eventStoreContract.js";

const mode = process.env.VIBELINK_EVENT_STORE_TEST_SIDECAR_MODE || "request-error";
const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function healthy() {
  return {
    ok: true,
    implementation: "failing-fixture",
    protocolVersion: EVENT_STORE_SIDECAR_PROTOCOL_VERSION,
    supportedMethods: [...EVENT_STORE_CONTRACT_METHODS],
    controlMethods: [...EVENT_STORE_SIDECAR_CONTROL_METHODS],
    schemaReady: true,
    startedAt: "2026-01-01T00:00:00.000Z"
  };
}

function unhealthy() {
  return {
    ok: false,
    implementation: "failing-fixture",
    protocolVersion: EVENT_STORE_SIDECAR_PROTOCOL_VERSION,
    supportedMethods: [],
    controlMethods: [...EVENT_STORE_SIDECAR_CONTROL_METHODS],
    schemaReady: false,
    startedAt: "2026-01-01T00:00:00.000Z"
  };
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const { id, method } = message;
  if (!id) return;

  if (method === "__close") {
    send({ id, result: true });
    process.exit(0);
  }

  if (method === "__health") {
    send({ id, result: mode === "unhealthy" ? unhealthy() : healthy() });
    return;
  }

  if (mode === "timeout") return;

  send({
    id,
    error: serializeEventStoreError(new Error(`fixture sidecar failed ${method}`))
  });
});
