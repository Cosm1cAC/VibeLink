import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");

test("OpenAPI documents MCP persistent session health counters", () => {
  const api = JSON.parse(fs.readFileSync(path.join(rootDir, "docs", "openapi.json"), "utf8"));
  const properties =
    api.paths?.["/api/mcp/status"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.properties;
  const sessionItem = properties?.persistentSessions?.properties?.items?.items?.properties;

  assert.ok(properties?.persistentSessions, "missing persistentSessions schema");
  assert.ok(properties?.rustSidecar, "missing rustSidecar schema");
  assert.ok(properties?.rustSidecar?.properties?.fallbacks, "missing Rust sidecar fallback counter");
  assert.ok(sessionItem?.requests, "missing per-session requests counter");
  assert.ok(sessionItem?.responses, "missing per-session responses counter");
  assert.ok(sessionItem?.failures, "missing per-session failures counter");
  assert.ok(sessionItem?.timeouts, "missing per-session timeouts counter");
  assert.ok(sessionItem?.backpressureRejects, "missing per-session backpressure counter");
});
