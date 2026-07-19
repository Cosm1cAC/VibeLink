import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubReviewRuntime } from "../src/githubReviewRuntime.js";

test("GitHub review runtime collects metadata, files, diff, threads, and comment status", async () => {
  const calls = [];
  const runtime = createGitHubReviewRuntime({
    run: async (args, options = {}) => {
      calls.push({ args, options });
      if (args[0] === "repo") return { stdout: JSON.stringify({ nameWithOwner: "acme/widgets" }) };
      if (args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({
        number: 42,
        title: "Improve widgets",
        url: "https://github.com/acme/widgets/pull/42",
        state: "OPEN",
        isDraft: false,
        author: { login: "octo" },
        baseRefName: "main",
        baseRefOid: "base-sha",
        headRefName: "feature/widgets",
        headRefOid: "head-sha",
        mergeable: "MERGEABLE",
        reviewDecision: "REVIEW_REQUIRED",
        updatedAt: "2026-07-18T00:00:00Z"
      }) };
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff --git a/a.js b/a.js\n" };
      if (args[0] === "api" && args[1].includes("/files")) return { stdout: JSON.stringify([[
        { filename: "a.js", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "@@ -1 +1 @@" }
      ]]) };
      if (args[0] === "api" && args[1] === "graphql") return { stdout: JSON.stringify({ data: { repository: { pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: "thread-1",
            isResolved: true,
            isOutdated: false,
            path: "a.js",
            line: 9,
            diffSide: "RIGHT",
            resolvedBy: { login: "maintainer" },
            comments: { nodes: [{ id: "comment-1", databaseId: 7, body: "Fixed", author: { login: "octo" } }] }
          }]
        }
      } } } }) };
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    }
  });

  const result = await runtime.getPullRequest({ cwd: "C:/repo", pullRequest: 42 });
  assert.equal(result.metadata.repository, "acme/widgets");
  assert.equal(result.metadata.headSha, "head-sha");
  assert.equal(result.files[0].path, "a.js");
  assert.match(result.diff, /diff --git/);
  assert.equal(result.threads[0].comments[0].status, "resolved");
  assert.ok(calls.every((call) => call.options.cwd === "C:/repo"));
});

test("GitHub review runtime submits a decision and inline comments through the reviews API", async () => {
  let request = null;
  const runtime = createGitHubReviewRuntime({
    run: async (args, options = {}) => {
      request = { args, options };
      return { stdout: JSON.stringify({ id: 91, state: "APPROVED", html_url: "https://github.com/review/91" }) };
    }
  });

  const result = await runtime.submitReview({
    cwd: "C:/repo",
    repository: "acme/widgets",
    number: 42,
    decision: "approve",
    body: "Looks good",
    comments: [{ path: "a.js", line: 9, side: "right", body: "Nice cleanup" }]
  });
  const payload = JSON.parse(request.options.stdin);
  assert.deepEqual(request.args.slice(0, 3), ["api", "repos/acme/widgets/pulls/42/reviews", "--method"]);
  assert.equal(payload.event, "APPROVE");
  assert.equal(payload.comments[0].side, "RIGHT");
  assert.equal(result.id, 91);
});
