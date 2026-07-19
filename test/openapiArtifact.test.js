import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const spec = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));

test("OpenAPI exposes only authenticated read contracts for artifacts", () => {
  assert.ok(spec.paths["/api/artifacts/{id}"].get);
  assert.ok(spec.paths["/api/artifacts/{id}/preview"].get);
  const content = spec.paths["/api/artifacts/{id}/content"];
  assert.ok(content.get);
  assert.equal(content.get.parameters.find((item) => item.name === "Range").required, true);
  assert.ok(content.get.responses["206"]);
  assert.ok(content.get.responses["416"]);
  for (const contract of [spec.paths["/api/artifacts/{id}"], spec.paths["/api/artifacts/{id}/preview"], content]) {
    assert.deepEqual(Object.keys(contract), ["get"]);
  }
  assert.deepEqual(spec.components.schemas.ArtifactMetadata.properties.capabilities.properties.mutation.enum, [false]);
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
});
