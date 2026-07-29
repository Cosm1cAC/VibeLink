import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const spec = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));

test("legacy login OpenAPI contract documents the Rust compatibility gate", () => {
  const login = spec.paths["/api/login"].post;
  const request = login.requestBody.content["application/json"].schema;
  const success = login.responses["200"].content["application/json"].schema;

  assert.match(login.description, /first active device on a non-public host/);
  assert.deepEqual(request.required, ["pairingToken"]);
  assert.equal(request.properties.rememberKeys.default, false);
  assert.deepEqual(success.required, ["ok", "token", "device", "settings"]);
  assert.equal(success.properties.device.properties.id.format, "uuid");
  assert.equal(login.responses["401"].description, "Unauthorized");
  assert.match(login.responses["403"].description, /disabled/);
  assert.equal(login.responses["429"].description, "Rate limit exceeded");
});
