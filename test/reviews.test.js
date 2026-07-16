import assert from "node:assert/strict";
import test from "node:test";
import { addReviewComment, createReview, getReview, updateReview } from "../src/reviews.js";

test("review sessions can be saved, resumed, commented, and resolved", () => {
  const review = createReview({ workspaceId: "w1", branch: "feature/search", title: "Search review" });
  assert.equal(getReview(review.id).status, "open");
  const withComment = addReviewComment(review.id, { file: "src/search.js", line: 10, body: "Please add coverage", severity: "high" });
  assert.equal(withComment.comments[0].severity, "high");
  assert.equal(updateReview(review.id, { status: "resolved" }).status, "resolved");
});
