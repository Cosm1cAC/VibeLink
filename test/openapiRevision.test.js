import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("OpenAPI documents revision ETags and 409 conflicts", () => {
  const spec = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  for (const path of ["/api/settings", "/api/thread-state", "/api/workspaces/{id}/file"]) {
    assert.ok(spec.paths[path].get.responses["200"].headers.ETag);
    assert.ok(spec.paths[path].post.responses["409"]);
  }
  assert.ok(spec.paths["/api/thread-state/batch"].post.responses["409"]);
  assert.ok(spec.components.schemas.RevisionConflict);
});
