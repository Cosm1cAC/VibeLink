import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const spec = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));

test("OpenAPI exposes Desktop Remote and Codex Desktop control contracts", () => {
  for (const routePath of [
    "/api/codex-app-server/probe",
    "/api/codex-desktop/status",
    "/api/codex-desktop/draft-probe",
    "/api/codex-desktop/send",
    "/api/desktop-remote/status",
    "/api/desktop-remote/observations",
    "/api/desktop-remote/events",
    "/api/desktop-remote/messages",
    "/api/desktop-remote/retry",
    "/api/desktop-remote/clear",
    "/api/desktop-remote/focus"
  ]) {
    assert.ok(spec.paths[routePath], routePath + " is documented");
  }

  assert.ok(spec.paths["/api/codex-desktop/status"].get);
  assert.ok(spec.paths["/api/codex-desktop/draft-probe"].post);
  assert.ok(spec.paths["/api/codex-desktop/send"].post);
  assert.ok(spec.paths["/api/desktop-remote/status"].get);
  assert.ok(spec.paths["/api/desktop-remote/events"].get);
  assert.ok(spec.paths["/api/desktop-remote/messages"].post);
  assert.ok(spec.paths["/api/desktop-remote/focus"].post);
});
