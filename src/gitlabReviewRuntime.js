import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export class GitLabReviewRuntimeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "GitLabReviewRuntimeError";
    this.status = options.status || 502;
    this.code = options.code || "GITLAB_REVIEW_RUNTIME_ERROR";
    this.command = options.command || [];
    this.stderr = options.stderr || "";
  }
}

function parseJson(value, label) {
  const text = String(value || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new GitLabReviewRuntimeError(`GitLab returned invalid JSON for ${label}.`, { code: "GITLAB_INVALID_RESPONSE" });
  }
}

function parsePaginatedJson(value, label) {
  const text = String(value || "").trim();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {}

  const pages = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "[" || character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const page = parseJson(text.slice(start, index + 1), label);
        pages.push(...(Array.isArray(page) ? page : [page]));
        start = -1;
      }
    }
  }
  if (!pages.length || depth !== 0 || quoted) {
    throw new GitLabReviewRuntimeError(`GitLab returned invalid JSON for ${label}.`, { code: "GITLAB_INVALID_RESPONSE" });
  }
  return pages;
}

function runGlab(args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const commandArgs = [...args.map(String)];
  for (const [key, value] of Object.entries(options.fields || {})) {
    if (value === undefined || value === null || value === "") continue;
    commandArgs.push("-f", `${key}=${value}`);
  }
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs || DEFAULT_TIMEOUT_MS), 5 * 60 * 1000));
  return new Promise((resolve, reject) => {
    const child = spawn("glab", commandArgs, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        try { child.kill(); } catch {}
        finish(() => reject(new GitLabReviewRuntimeError("GitLab response exceeded the review runtime limit.", {
          status: 413,
          code: "GITLAB_RESPONSE_TOO_LARGE",
          command: commandArgs
        })));
        return target;
      }
      return target + chunk.toString("utf8");
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(() => reject(new GitLabReviewRuntimeError("GitLab review request timed out.", {
        status: 504,
        code: "GITLAB_REVIEW_TIMEOUT",
        command: commandArgs,
        stderr
      })));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish(() => reject(new GitLabReviewRuntimeError(error.message, {
      status: error.code === "ENOENT" ? 503 : 502,
      code: error.code === "ENOENT" ? "GITLAB_CLI_UNAVAILABLE" : "GITLAB_REVIEW_RUNTIME_ERROR",
      command: commandArgs
    }))));
    child.on("close", (exitCode) => finish(() => {
      if (exitCode === 0) resolve({ stdout, stderr, exitCode: 0 });
      else reject(new GitLabReviewRuntimeError(stderr.trim() || stdout.trim() || "GitLab CLI request failed.", {
        status: exitCode === 4 ? 401 : 502,
        code: exitCode === 4 ? "GITLAB_AUTH_REQUIRED" : "GITLAB_REQUEST_FAILED",
        command: commandArgs,
        stderr
      }));
    }));
  });
}

function projectPath(value = {}) {
  const repository = String(value.path_with_namespace || value.fullPath || value.full_path || value.pathWithNamespace || "");
  if (!repository || !repository.includes("/")) {
    throw new GitLabReviewRuntimeError("Unable to determine the GitLab project.", { code: "GITLAB_REPOSITORY_UNKNOWN" });
  }
  return repository;
}

function mergeRequestNumber(value) {
  const direct = Number(value || 0);
  if (direct > 0) return direct;
  const match = String(value || "").match(/\/merge_requests\/(\d+)(?:\D|$)/);
  if (match) return Number(match[1]);
  throw new GitLabReviewRuntimeError("A GitLab merge request IID or URL is required.", {
    status: 400,
    code: "REVIEW_PULL_REQUEST_REQUIRED"
  });
}

function normalizeMetadata(value = {}, repository = "") {
  const refs = value.diff_refs || {};
  return {
    provider: "gitlab",
    repository,
    number: Number(value.iid || 0),
    title: String(value.title || ""),
    body: String(value.description || ""),
    url: String(value.web_url || ""),
    state: String(value.state || "").replace("opened", "open").toLowerCase(),
    isDraft: Boolean(value.draft || value.work_in_progress),
    author: value.author ? {
      login: String(value.author.username || ""),
      name: String(value.author.name || "")
    } : null,
    baseRefName: String(value.target_branch || ""),
    baseSha: String(refs.base_sha || ""),
    startSha: String(refs.start_sha || ""),
    headRefName: String(value.source_branch || ""),
    headSha: String(value.sha || refs.head_sha || ""),
    mergeable: value.has_conflicts ? "conflicting" : String(value.detailed_merge_status || value.merge_status || "").toLowerCase(),
    reviewDecision: "",
    updatedAt: String(value.updated_at || "")
  };
}

function lineCounts(diff = "") {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff).split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function normalizeFile(value = {}) {
  const counts = lineCounts(value.diff);
  return {
    path: String(value.new_path || ""),
    previousPath: String(value.old_path || ""),
    status: value.new_file ? "added" : value.deleted_file ? "deleted" : value.renamed_file ? "renamed" : "modified",
    additions: counts.additions,
    deletions: counts.deletions,
    changes: counts.additions + counts.deletions,
    patch: String(value.diff || "")
  };
}

function normalizeThread(value = {}) {
  const notes = Array.isArray(value.notes) ? value.notes : [];
  const position = notes.find((note) => note.position)?.position || {};
  const resolved = notes.some((note) => note.resolvable) && notes.filter((note) => note.resolvable).every((note) => note.resolved);
  return {
    id: String(value.id || ""),
    isResolved: resolved,
    isOutdated: false,
    path: String(position.new_path || position.old_path || ""),
    line: Number(position.new_line || position.old_line || 0),
    startLine: 0,
    side: position.old_line && !position.new_line ? "left" : "right",
    resolvedBy: String(notes.find((note) => note.resolved_by)?.resolved_by?.username || ""),
    comments: notes.filter((note) => !note.system).map((note) => ({
      id: String(note.id || ""),
      databaseId: Number(note.id || 0),
      body: String(note.body || ""),
      url: String(note.web_url || ""),
      author: String(note.author?.username || ""),
      createdAt: String(note.created_at || ""),
      updatedAt: String(note.updated_at || ""),
      status: note.resolved ? "resolved" : "open"
    }))
  };
}

export function createGitLabReviewRuntime(options = {}) {
  const execute = options.run || runGlab;
  const invoke = async (args, runOptions = {}) => {
    const result = await execute(args, runOptions);
    return typeof result === "string" ? { stdout: result, stderr: "", exitCode: 0 } : result;
  };

  async function getRepository(cwd) {
    return projectPath(parseJson((await invoke(["repo", "view", "--output", "json"], { cwd })).stdout, "project metadata"));
  }

  async function getMetadata(cwd, repository, number) {
    const project = encodeURIComponent(repository);
    const endpoint = `projects/${project}/merge_requests/${number}`;
    return normalizeMetadata(parseJson((await invoke(["api", endpoint], { cwd })).stdout, "merge request metadata"), repository);
  }

  return {
    async getPullRequestMetadata(input = {}) {
      const cwd = input.cwd || process.cwd();
      const repository = String(input.repository || await getRepository(cwd));
      return getMetadata(cwd, repository, mergeRequestNumber(input.pullRequest || input.number));
    },

    async getPullRequest(input = {}) {
      const cwd = input.cwd || process.cwd();
      const repository = String(input.repository || await getRepository(cwd));
      const number = mergeRequestNumber(input.pullRequest || input.number);
      const project = encodeURIComponent(repository);
      const metadata = await getMetadata(cwd, repository, number);
      const [diffsResult, diffResult, discussionsResult] = await Promise.all([
        invoke(["api", `projects/${project}/merge_requests/${number}/diffs?per_page=100`, "--paginate"], { cwd }),
        invoke(["mr", "diff", String(number), "--repo", repository], { cwd }),
        invoke(["api", `projects/${project}/merge_requests/${number}/discussions?per_page=100`, "--paginate"], { cwd })
      ]);
      const files = parsePaginatedJson(diffsResult.stdout, "merge request diffs");
      const discussions = parsePaginatedJson(discussionsResult.stdout, "merge request discussions");
      return {
        metadata,
        files: (Array.isArray(files) ? files : []).map(normalizeFile),
        diff: String(diffResult.stdout || ""),
        threads: (Array.isArray(discussions) ? discussions : []).map(normalizeThread)
      };
    },

    async submitReview(input = {}) {
      const cwd = input.cwd || process.cwd();
      const repository = String(input.repository || await getRepository(cwd));
      const number = mergeRequestNumber(input.number);
      const decision = String(input.decision || "comment").toLowerCase();
      if (!new Set(["approve", "request_changes", "comment"]).has(decision)) {
        throw new GitLabReviewRuntimeError("Unsupported review decision.", { status: 400, code: "REVIEW_DECISION_INVALID" });
      }
      const endpoint = `projects/${encodeURIComponent(repository)}/merge_requests/${number}`;
      for (const comment of input.comments || []) {
        const left = String(comment.side || "right").toLowerCase() === "left";
        await invoke(["api", `${endpoint}/draft_notes`, "--method", "POST"], {
          cwd,
          fields: {
            note: String(comment.body || ""),
            "position[position_type]": "text",
            "position[base_sha]": input.baseSha,
            "position[head_sha]": input.headSha,
            "position[start_sha]": input.startSha,
            "position[new_path]": String(comment.path || ""),
            "position[old_path]": String(comment.path || ""),
            [left ? "position[old_line]" : "position[new_line]"]: String(comment.line || 0)
          }
        });
      }
      const published = parseJson((await invoke(["api", `${endpoint}/draft_notes/bulk_publish`, "--method", "POST"], {
        cwd,
        fields: {
          note: String(input.body || ""),
          reviewer_state: decision === "request_changes" ? "requested_changes" : "reviewed"
        }
      })).stdout, "published review");
      if (decision !== "approve") return published;
      return parseJson((await invoke(["api", `${endpoint}/approve`, "--method", "POST"], {
        cwd,
        fields: { sha: String(input.headSha || "") }
      })).stdout, "merge request approval");
    }
  };
}

export const gitlabReviewRuntime = createGitLabReviewRuntime();
