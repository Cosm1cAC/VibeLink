import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");

test("OpenAPI documents compact service dropped-event metrics", () => {
  const api = JSON.parse(fs.readFileSync(path.join(rootDir, "docs", "openapi.json"), "utf8"));
  const properties =
    api.paths?.["/api/compact/metrics"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.properties;
  const metricProperties = properties?.metrics?.properties;

  assert.ok(metricProperties?.summaryInputsBuilt, "missing compact summary input count");
  assert.ok(metricProperties?.summaryInputTruncations, "missing compact truncation count");
  assert.ok(metricProperties?.summaryInputDroppedEvents, "missing compact dropped-event count");
});
