import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReviewService } from "../src/reviews.js";

function snapshot(headSha = "head-1") {
  return {
    metadata: {
      provider: "github",
      repository: "acme/widgets",
      number: 42,
      title: "Improve widgets",
      url: "https://github.com/acme/widgets/pull/42",
      state: "open",
      headRefName: "feature/widgets",
      headSha,
      baseRefName: "main",
      baseSha: "base-1"
    },
    files: [{ path: "src/widget.js", status: "modified", additions: 3, deletions: 1 }],
    diff: "diff --git a/src/widget.js b/src/widget.js\n",
    threads: [{ id: "thread-1", isResolved: false, comments: [{ id: "remote-comment", status: "open" }] }]
  };
}

function fixture(t, runtime) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-review-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createReviewService({
    filePath: path.join(dir, "reviews.json"),
    runtime,
    resolveCwd: async () => dir,
    clock: (() => {
      let tick = 0;
      return () => `2026-07-18T00:00:0${tick++}Z`;
    })()
  });
}

test("remote PR sync creates and updates a local session without discarding draft comments", async (t) => {
  let remote = snapshot();
  const service = fixture(t, { getPullRequest: async () => remote });
  const review = await service.syncRemoteReview(null, { workspaceId: "w1", pullRequest: 42 });
  assert.equal(review.source, "github");
  assert.equal(review.remote.headSha, "head-1");
  assert.equal(review.files[0].path, "src/widget.js");
  assert.equal(review.threads[0].comments[0].status, "open");

  const commented = service.addReviewComment(review.id, {
    file: "src/widget.js",
    line: 12,
    body: "Please cover this branch",
    severity: "high"
  });
  remote = snapshot("head-2");
  const synced = await service.syncRemoteReview(review.id);
  assert.equal(synced.remote.headSha, "head-2");
  assert.equal(synced.comments[0].id, commented.comments[0].id);
  assert.equal(synced.comments[0].status, "open");
});

test("review submission sends draft comments and records their submitted status", async (t) => {
  const submissions = [];
  const runtime = {
    getPullRequest: async () => snapshot(),
    submitReview: async (input) => {
      submissions.push(input);
      return { id: 91, state: "APPROVED", html_url: "https://github.com/review/91" };
    }
  };
  const service = fixture(t, runtime);
  let review = await service.syncRemoteReview(null, { workspaceId: "w1", pullRequest: 42 });
  review = service.addReviewComment(review.id, { file: "src/widget.js", line: 12, body: "Nit" });
  review = await service.submitRemoteReview(review.id, { decision: "approve", body: "Looks good", expectedHeadSha: "head-1" });

  assert.equal(submissions[0].decision, "approve");
  assert.equal(submissions[0].comments[0].path, "src/widget.js");
  assert.equal(review.status, "submitted");
  assert.equal(review.comments[0].status, "submitted");
  assert.equal(review.remote.reviewId, "91");
});

test("review submission rejects a changed remote head before posting", async (t) => {
  let submitCount = 0;
  let reads = 0;
  const runtime = {
    getPullRequest: async () => snapshot(reads++ === 0 ? "head-1" : "head-2"),
    submitReview: async () => { submitCount += 1; }
  };
  const service = fixture(t, runtime);
  const review = await service.syncRemoteReview(null, { workspaceId: "w1", pullRequest: 42 });

  await assert.rejects(
    service.submitRemoteReview(review.id, { decision: "comment", expectedHeadSha: "head-1" }),
    (error) => error.status === 409
      && error.code === "REVIEW_REMOTE_CONFLICT"
      && error.expectedHeadSha === "head-1"
      && error.actualHeadSha === "head-2"
  );
  assert.equal(submitCount, 0);
  assert.equal(service.getReview(review.id).status, "open");
});

test("review submission preserves comments added while the remote request is in flight", async (t) => {
  let releaseSubmit;
  let submissionStarted;
  const started = new Promise((resolve) => { submissionStarted = resolve; });
  const runtime = {
    getPullRequest: async () => snapshot(),
    submitReview: async () => {
      submissionStarted();
      await new Promise((resolve) => { releaseSubmit = resolve; });
      return { id: 92, state: "COMMENTED" };
    }
  };
  const service = fixture(t, runtime);
  let review = await service.syncRemoteReview(null, { workspaceId: "w1", pullRequest: 42 });
  review = service.addReviewComment(review.id, { file: "src/widget.js", line: 12, body: "First" });

  const submitting = service.submitRemoteReview(review.id, { decision: "comment", expectedHeadSha: "head-1" });
  await started;
  service.addReviewComment(review.id, { file: "src/widget.js", line: 13, body: "Second" });
  releaseSubmit();
  const submitted = await submitting;

  assert.deepEqual(submitted.comments.map((comment) => comment.status), ["submitted", "open"]);
});
