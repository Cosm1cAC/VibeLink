#!/usr/bin/env node
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let renders = 0;

function reply(id, payload, callback) {
  process.stdout.write(`${JSON.stringify({ id, ...payload })}\n`, callback);
}

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "__health") {
    if (process.env.FAKE_STATUS_SIDECAR_HANG_HEALTH === "1") return;
    if (process.env.FAKE_STATUS_SIDECAR_FAIL_HEALTH === "1") {
      reply(request.id, { error: { name: "Error", message: "fixture health failed" } });
    } else {
      reply(request.id, { result: { ok: true, implementation: "rust", protocolVersion: 1, supportedMethods: ["renderStatus"] } });
    }
    return;
  }
  if (request.method === "renderStatus") {
    if (process.env.FAKE_STATUS_SIDECAR_FAIL_RENDER === "1") {
      reply(request.id, { error: { name: "Error", message: "fixture render failed" } });
    } else {
      renders += 1;
      reply(request.id, { result: request.args[0] });
    }
    return;
  }
  if (request.method === "stats") {
    reply(request.id, { result: { renders } });
    return;
  }
  if (request.method === "__close") {
    reply(request.id, { result: true }, () => process.exit(0));
    return;
  }
  reply(request.id, { error: { name: "Error", message: `unsupported: ${request.method}` } });
});
