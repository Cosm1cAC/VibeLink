import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("OpenAPI documents indexed search, saved searches, and history", () => {
  const spec = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  assert.equal(spec.paths["/api/search"].get.parameters.find((item) => item.name === "sort").schema.enum.includes("updatedAt"), true);
  assert.ok(spec.paths["/api/search/saved"].post);
  assert.ok(spec.paths["/api/search/saved/{id}"].delete);
  assert.ok(spec.paths["/api/search/history"].delete);
  assert.ok(spec.paths["/api/search/index/refresh"].post);
  assert.ok(spec.components.schemas.SearchResponse);
});
