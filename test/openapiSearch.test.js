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

test("OpenAPI documents workspace file paging, rich preview, and batch conflicts", () => {
  const spec = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  const fileRead = spec.paths["/api/workspaces/{id}/file"].get;
  assert.ok(fileRead.parameters.find((item) => item.name === "offset"));
  assert.ok(fileRead.parameters.find((item) => item.name === "limit"));
  assert.ok(spec.paths["/api/workspaces/{id}/file/preview"].get);
  const batch = spec.paths["/api/workspaces/{id}/files/batch"].post;
  assert.deepEqual(batch.requestBody.content["application/json"].schema.properties.mode.enum, ["atomic", "best-effort"]);
  assert.ok(batch.responses["409"]);
});
