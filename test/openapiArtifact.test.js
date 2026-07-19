import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const spec = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));

test("OpenAPI exposes authenticated artifact and browser-session contracts", () => {
  assert.ok(spec.paths["/api/artifacts/{id}"].get);
  assert.ok(spec.paths["/api/artifacts/{id}"].patch);
  assert.ok(spec.paths["/api/artifacts/{id}/preview"].get);
  const content = spec.paths["/api/artifacts/{id}/content"];
  assert.ok(content.get);
  assert.equal(content.get.parameters.find((item) => item.name === "Range").required, true);
  assert.ok(content.get.responses["206"]);
  assert.ok(content.get.responses["416"]);
  for (const contract of [spec.paths["/api/artifacts/{id}/preview"], content]) {
    assert.deepEqual(Object.keys(contract), ["get"]);
  }
  assert.ok(spec.paths["/api/browser-sessions"].get);
  assert.ok(spec.paths["/api/browser-sessions"].post);
  assert.ok(spec.paths["/api/browser-sessions/{id}/navigate"].post);
  assert.ok(spec.paths["/api/browser-sessions/{id}/trace"].get);
  assert.equal(spec.components.schemas.ArtifactMetadata.properties.capabilities.properties.mutation.type, "boolean");
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
});
