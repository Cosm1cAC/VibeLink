import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";
import { getWorkspace } from "./db.js";
import { githubReviewRuntime } from "./githubReviewRuntime.js";
import { gitlabReviewRuntime } from "./gitlabReviewRuntime.js";
import { resolveAllowedPath } from "./security.js";

const reviewPath = path.join(dataDir, "reviews.json");
const COMMENT_STATUSES = new Set(["open", "resolved", "dismissed", "submitted"]);
const REVIEW_STATUSES = new Set(["open", "submitted", "resolved"]);

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function reviewError(message, status, code, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function defaultResolveCwd(workspaceId, settings = {}) {
  const workspace = getWorkspace(String(workspaceId || ""));
  if (!workspace) throw reviewError("Workspace not found.", 404, "REVIEW_WORKSPACE_NOT_FOUND");
  return resolveAllowedPath(workspace.path, settings);
}

function normalizeComment(input = {}, current = null) {
  const now = new Date().toISOString();
  const status = COMMENT_STATUSES.has(input.status) ? input.status : current?.status || "open";
  return {
    ...(current || {}),
    id: current?.id || crypto.randomUUID(),
    file: cleanText(input.file ?? current?.file, 1000),
    line: Math.max(0, Number(input.line ?? current?.line ?? 0) || 0),
    startLine: Math.max(0, Number(input.startLine ?? current?.startLine ?? 0) || 0),
    side: ["left", "right"].includes(String(input.side || current?.side || "").toLowerCase())
      ? String(input.side || current?.side).toLowerCase()
      : "right",
    body: cleanText(input.body ?? current?.body, 4000),
    severity: ["critical", "high", "medium", "low", "info"].includes(input.severity)
      ? input.severity
      : current?.severity || "info",
    status,
    createdAt: current?.createdAt || now,
    updatedAt: now
  };
}

export function createReviewService(options = {}) {
  const filePath = options.filePath || reviewPath;
  const runtimes = options.runtime || { github: githubReviewRuntime, gitlab: gitlabReviewRuntime };
  const resolveCwd = options.resolveCwd || defaultResolveCwd;
  const clock = options.clock || (() => new Date().toISOString());

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  function save(items) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
    return items;
  }

  function listReviews() {
    return load().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function getReview(id) {
    return load().find((item) => item.id === id) || null;
  }

  function createReview(input = {}) {
    const now = clock();
    const review = {
      id: crypto.randomUUID(),
      workspaceId: String(input.workspaceId || ""),
      branch: String(input.branch || ""),
      title: cleanText(input.title || "PR Review", 200),
      status: "open",
      source: ["github", "gitlab"].includes(input.source) ? input.source : "local",
      ...(input.remote ? { remote: input.remote } : {}),
      files: Array.isArray(input.files) ? input.files : [],
      diff: String(input.diff || ""),
      threads: Array.isArray(input.threads) ? input.threads : [],
      comments: [],
      createdAt: now,
      updatedAt: now
    };
    save([...load(), review]);
    return review;
  }

  function runtimeFor(provider = "github") {
    if (typeof runtimes.getPullRequest === "function") return runtimes;
    const runtime = runtimes[provider];
    if (!runtime) throw reviewError(`Review provider '${provider}' is not configured.`, 400, "REVIEW_PROVIDER_INVALID");
    return runtime;
  }

  function updateReview(id, patch = {}) {
    const items = load();
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const current = items[index];
    const next = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt: clock() };
    if (!REVIEW_STATUSES.has(next.status)) next.status = current.status;
    if (!Array.isArray(next.comments)) next.comments = current.comments || [];
    items[index] = next;
    save(items);
    return next;
  }

  function addReviewComment(id, input = {}) {
    const review = getReview(id);
    if (!review) return null;
    const comment = normalizeComment(input);
    if (!comment.file || !comment.line || !comment.body) {
      throw reviewError("Review comments require file, line, and body.", 400, "REVIEW_COMMENT_INVALID");
    }
    return updateReview(id, { comments: [...(review.comments || []), comment] });
  }

  function updateReviewComment(id, commentId, patch = {}) {
    const review = getReview(id);
    if (!review) return null;
    const index = (review.comments || []).findIndex((comment) => comment.id === commentId);
    if (index < 0) throw reviewError("Review comment not found.", 404, "REVIEW_COMMENT_NOT_FOUND");
    const comments = [...review.comments];
    comments[index] = normalizeComment(patch, comments[index]);
    return updateReview(id, { comments });
  }

  async function syncRemoteReview(id, input = {}, context = {}) {
    const existing = id ? getReview(id) : null;
    if (id && !existing) return null;
    const workspaceId = String(input.workspaceId || existing?.workspaceId || "");
    const cwd = await resolveCwd(workspaceId, context.settings || {});
    const pullRequest = input.pullRequest || input.number || existing?.remote?.number || existing?.remote?.url;
    if (!pullRequest) throw reviewError("A pull request or merge request number/URL is required.", 400, "REVIEW_PULL_REQUEST_REQUIRED");
    const provider = String(input.provider || existing?.remote?.provider
      || (["github", "gitlab"].includes(existing?.source) ? existing.source : "")
      || (/gitlab/i.test(String(pullRequest)) ? "gitlab" : "github")).toLowerCase();
    if (!new Set(["github", "gitlab"]).has(provider)) {
      throw reviewError("Review provider must be github or gitlab.", 400, "REVIEW_PROVIDER_INVALID");
    }
    const runtime = runtimeFor(provider);
    const snapshot = await runtime.getPullRequest({
      cwd,
      pullRequest,
      repository: input.repository || existing?.remote?.repository || ""
    });
    const syncedAt = clock();
    const patch = {
      workspaceId,
      branch: snapshot.metadata.headRefName,
      title: snapshot.metadata.title || existing?.title || "PR Review",
      source: provider,
      remote: { ...snapshot.metadata, syncedAt },
      files: snapshot.files,
      diff: snapshot.diff,
      threads: snapshot.threads
    };
    return existing
      ? updateReview(existing.id, patch)
      : createReview({ ...patch, comments: existing?.comments || [] });
  }

  async function submitRemoteReview(id, input = {}, context = {}) {
    const review = getReview(id);
    if (!review) return null;
    if (!["github", "gitlab"].includes(review.source) || !review.remote?.number) {
      throw reviewError("Review session is not connected to a remote pull request.", 409, "REVIEW_NOT_REMOTE");
    }
    const decision = String(input.decision || "").toLowerCase();
    if (!new Set(["approve", "request_changes", "comment"]).has(decision)) {
      throw reviewError("Review decision must be approve, request_changes, or comment.", 400, "REVIEW_DECISION_INVALID");
    }
    if (decision === "request_changes" && !cleanText(input.body, 4000)) {
      throw reviewError("Request changes reviews require a body.", 400, "REVIEW_BODY_REQUIRED");
    }
    if (!cleanText(input.expectedHeadSha, 200)) {
      throw reviewError("The reviewed head SHA is required.", 400, "REVIEW_HEAD_REQUIRED");
    }
    const cwd = await resolveCwd(review.workspaceId, context.settings || {});
    const runtime = runtimeFor(review.source);
    const latestResult = await (runtime.getPullRequestMetadata
      ? runtime.getPullRequestMetadata({
          cwd,
          pullRequest: review.remote.number,
          repository: review.remote.repository
        })
      : runtime.getPullRequest({
          cwd,
          pullRequest: review.remote.number,
          repository: review.remote.repository
        }));
    const latestMetadata = latestResult.metadata || latestResult;
    const expectedHeadSha = String(input.expectedHeadSha);
    const actualHeadSha = String(latestMetadata.headSha || "");
    if (!expectedHeadSha || expectedHeadSha !== actualHeadSha) {
      throw reviewError("The pull request changed after this review session was synced.", 409, "REVIEW_REMOTE_CONFLICT", {
        expectedHeadSha,
        actualHeadSha,
        current: latestMetadata
      });
    }
    const currentReview = getReview(id);
    if (!currentReview) return null;
    const openComments = (currentReview.comments || []).filter((comment) => comment.status === "open");
    if (decision === "comment" && !openComments.length && !cleanText(input.body, 4000)) {
      throw reviewError("Comment reviews require a body or an open inline comment.", 400, "REVIEW_BODY_REQUIRED");
    }
    const submitted = await runtime.submitReview({
      cwd,
      repository: review.remote.repository,
      number: review.remote.number,
      decision,
      body: input.body,
      headSha: actualHeadSha,
      baseSha: latestMetadata.baseSha || review.remote.baseSha,
      startSha: latestMetadata.startSha || review.remote.startSha,
      comments: openComments.map((comment) => ({
        path: comment.file,
        line: comment.line,
        startLine: comment.startLine,
        side: comment.side,
        body: comment.body
      }))
    });
    const submittedAt = clock();
    const submittedCommentIds = new Set(openComments.map((comment) => comment.id));
    const finalReview = getReview(id) || currentReview;
    return updateReview(id, {
      status: "submitted",
      decision,
      submittedAt,
      remote: {
        ...finalReview.remote,
        ...latestMetadata,
        reviewId: String(submitted.id || ""),
        reviewUrl: String(submitted.html_url || submitted.web_url || ""),
        reviewState: String(submitted.state || submitted.reviewer_state || "").toLowerCase()
      },
      comments: (finalReview.comments || []).map((comment) => comment.status === "open" && submittedCommentIds.has(comment.id)
        ? { ...comment, status: "submitted", submittedAt, remoteReviewId: String(submitted.id || ""), updatedAt: submittedAt }
        : comment)
    });
  }

  return {
    addReviewComment,
    createReview,
    getReview,
    listReviews,
    submitRemoteReview,
    syncRemoteReview,
    updateReview,
    updateReviewComment
  };
}

const service = createReviewService();

export const addReviewComment = service.addReviewComment;
export const createReview = service.createReview;
export const getReview = service.getReview;
export const listReviews = service.listReviews;
export const submitRemoteReview = service.submitRemoteReview;
export const syncRemoteReview = service.syncRemoteReview;
export const updateReview = service.updateReview;
export const updateReviewComment = service.updateReviewComment;
