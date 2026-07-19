import assert from "node:assert/strict";
import test from "node:test";
import { createGitLabReviewRuntime } from "../src/gitlabReviewRuntime.js";

test("GitLab review runtime collects merge request metadata, diffs, and discussions", async () => {
  const calls = [];
  const runtime = createGitLabReviewRuntime({
    run: async (args, options = {}) => {
      calls.push({ args, options });
      if (args[0] === "repo") return { stdout: JSON.stringify({ path_with_namespace: "acme/widgets" }) };
      if (args[1]?.endsWith("/merge_requests/42")) return { stdout: JSON.stringify({
        iid: 42,
        title: "Improve widgets",
        web_url: "https://gitlab.example/acme/widgets/-/merge_requests/42",
        state: "opened",
        draft: false,
        author: { username: "fox" },
        target_branch: "main",
        source_branch: "feature/widgets",
        sha: "head-sha",
        diff_refs: { base_sha: "base-sha", head_sha: "head-sha", start_sha: "start-sha" },
        detailed_merge_status: "mergeable",
        has_conflicts: false,
        updated_at: "2026-07-18T00:00:00Z"
      }) };
      if (args[1]?.endsWith("/diffs?per_page=100")) return { stdout: JSON.stringify([{
        new_path: "src/widget.js",
        old_path: "src/widget.js",
        new_file: false,
        deleted_file: false,
        renamed_file: false,
        diff: "@@ -1 +1 @@\n-old\n+new"
      }]) + JSON.stringify([{
        new_path: "src/second.js",
        old_path: "src/second.js",
        diff: "@@ -0,0 +1 @@\n+second"
      }]) };
      if (args[1]?.endsWith("/discussions?per_page=100")) return { stdout: JSON.stringify([{
        id: "discussion-1",
        notes: [{
          id: 7,
          body: "Please fix",
          resolvable: true,
          resolved: false,
          author: { username: "reviewer" },
          position: { new_path: "src/widget.js", new_line: 8 },
          created_at: "2026-07-18T00:00:00Z"
        }]
      }]) };
      if (args[0] === "mr" && args[1] === "diff") return { stdout: "diff --git a/src/widget.js b/src/widget.js\n" };
      throw new Error(`Unexpected glab call: ${args.join(" ")}`);
    }
  });

  const result = await runtime.getPullRequest({ cwd: "C:/repo", pullRequest: 42 });
  assert.equal(result.metadata.provider, "gitlab");
  assert.equal(result.metadata.repository, "acme/widgets");
  assert.equal(result.metadata.headSha, "head-sha");
  assert.equal(result.files[0].path, "src/widget.js");
  assert.equal(result.files[1].path, "src/second.js");
  assert.equal(result.threads[0].comments[0].status, "open");
  assert.ok(calls.every((call) => call.options.cwd === "C:/repo"));
});

test("GitLab review runtime publishes draft comments and approves the reviewed head", async () => {
  const calls = [];
  const runtime = createGitLabReviewRuntime({
    run: async (args, options = {}) => {
      calls.push({ args, options });
      if (args[1]?.endsWith("/draft_notes")) return { stdout: JSON.stringify({ id: 11 }) };
      if (args[1]?.endsWith("/draft_notes/bulk_publish")) return { stdout: JSON.stringify({ id: 12 }) };
      if (args[1]?.endsWith("/approve")) return { stdout: JSON.stringify({ id: 91, approved: true }) };
      throw new Error(`Unexpected glab call: ${args.join(" ")}`);
    }
  });

  const result = await runtime.submitReview({
    cwd: "C:/repo",
    repository: "acme/widgets",
    number: 42,
    decision: "approve",
    body: "Looks good",
    headSha: "head-sha",
    baseSha: "base-sha",
    startSha: "start-sha",
    comments: [{ path: "src/widget.js", line: 8, side: "right", body: "Nice cleanup" }]
  });

  const draft = calls.find((call) => call.args[1]?.endsWith("/draft_notes"));
  const publish = calls.find((call) => call.args[1]?.endsWith("/draft_notes/bulk_publish"));
  const approve = calls.find((call) => call.args[1]?.endsWith("/approve"));
  assert.equal(draft.options.fields["position[head_sha]"], "head-sha");
  assert.equal(draft.options.fields["position[new_line]"], "8");
  assert.equal(publish.options.fields.reviewer_state, "reviewed");
  assert.equal(approve.options.fields.sha, "head-sha");
  assert.equal(result.id, 91);
});
