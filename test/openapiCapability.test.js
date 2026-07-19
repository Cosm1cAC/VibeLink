import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("OpenAPI exposes capability center contracts", () => {
  const spec = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  for (const path of ["/api/capabilities/{category}", "/api/capabilities/plugins/{id}", "/api/capabilities/hooks/{id}", "/api/capabilities/config/{id}", "/api/automations", "/api/automations/{id}/run", "/api/subagents"]) assert.ok(spec.paths[path]);
  assert.ok(spec.paths["/api/capabilities/{category}"].get);
  assert.ok(spec.paths["/api/capabilities/hooks/{id}"].patch);
});
