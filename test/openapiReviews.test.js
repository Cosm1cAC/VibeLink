import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("OpenAPI documents GitHub and GitLab review sync, comments, submission, and conflicts", () => {
  const spec = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  assert.ok(spec.components.schemas.ReviewSession);
  assert.ok(spec.paths["/api/reviews"].get);
  assert.ok(spec.paths["/api/reviews"].post);
  assert.ok(spec.paths["/api/reviews/{id}/sync"].post);
  assert.ok(spec.paths["/api/reviews/{id}/comments/{commentId}"].patch);
  assert.deepEqual(spec.paths["/api/reviews"].post.requestBody.content["application/json"].schema.properties.provider.enum, ["github", "gitlab"]);
  assert.equal(
    spec.paths["/api/reviews/{id}/submit"].post.responses["409"].content["application/json"].schema.$ref,
    "#/components/schemas/ReviewConflict"
  );
});

test("OpenAPI documents Git worktree list and lifecycle actions", () => {
  const spec = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  assert.ok(spec.paths["/api/workspaces/{id}/worktrees"].get);
  assert.ok(spec.paths["/api/workspaces/{id}/worktrees"].post);
  assert.deepEqual(
    spec.paths["/api/workspaces/{id}/worktrees/action"].post.requestBody.content["application/json"].schema.properties.action.enum,
    ["remove", "prune", "lock", "unlock"]
  );
});
