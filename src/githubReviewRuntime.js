import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export class GitHubReviewRuntimeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "GitHubReviewRuntimeError";
    this.status = options.status || 502;
    this.code = options.code || "GITHUB_REVIEW_RUNTIME_ERROR";
    this.command = options.command || [];
    this.stderr = options.stderr || "";
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    throw new GitHubReviewRuntimeError(`GitHub returned invalid JSON for ${label}.`, { code: "GITHUB_INVALID_RESPONSE" });
  }
}

function runGh(args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const stdin = options.stdin === undefined ? "" : String(options.stdin);
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs || DEFAULT_TIMEOUT_MS), 5 * 60 * 1000));
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args.map(String), {
      cwd,
      windowsHide: true,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"]
    });
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
        finish(() => reject(new GitHubReviewRuntimeError("GitHub response exceeded the review runtime limit.", {
          status: 413,
          code: "GITHUB_RESPONSE_TOO_LARGE",
          command: args
        })));
        return target;
      }
      return target + chunk.toString("utf8");
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(() => reject(new GitHubReviewRuntimeError("GitHub review request timed out.", {
        status: 504,
        code: "GITHUB_REVIEW_TIMEOUT",
        command: args,
        stderr
      })));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish(() => reject(new GitHubReviewRuntimeError(error.message, {
      code: error.code === "ENOENT" ? "GITHUB_CLI_UNAVAILABLE" : "GITHUB_REVIEW_RUNTIME_ERROR",
      status: error.code === "ENOENT" ? 503 : 502,
      command: args
    }))));
    child.on("close", (exitCode) => finish(() => {
      if (exitCode === 0) resolve({ stdout, stderr, exitCode: 0 });
      else reject(new GitHubReviewRuntimeError(stderr.trim() || stdout.trim() || "GitHub CLI request failed.", {
        status: exitCode === 4 ? 401 : 502,
        code: exitCode === 4 ? "GITHUB_AUTH_REQUIRED" : "GITHUB_REQUEST_FAILED",
        command: args,
        stderr
      }));
    }));
    if (stdin && child.stdin?.writable) child.stdin.end(stdin);
  });
}

function normalizePullRequest(value = {}, repository = "") {
  return {
    provider: "github",
    repository,
    number: Number(value.number || 0),
    title: String(value.title || ""),
    body: String(value.body || ""),
    url: String(value.url || ""),
    state: String(value.state || "").toLowerCase(),
    isDraft: Boolean(value.isDraft),
    author: value.author ? {
      login: String(value.author.login || ""),
      name: String(value.author.name || "")
    } : null,
    baseRefName: String(value.baseRefName || ""),
    baseSha: String(value.baseRefOid || ""),
    headRefName: String(value.headRefName || ""),
    headSha: String(value.headRefOid || ""),
    mergeable: String(value.mergeable || "").toLowerCase(),
    reviewDecision: String(value.reviewDecision || "").toLowerCase(),
    updatedAt: String(value.updatedAt || "")
  };
}

function normalizeFile(file = {}) {
  return {
    path: String(file.filename || ""),
    previousPath: String(file.previous_filename || ""),
    status: String(file.status || ""),
    additions: Number(file.additions || 0),
    deletions: Number(file.deletions || 0),
    changes: Number(file.changes || 0),
    patch: String(file.patch || "")
  };
}

function normalizeThread(thread = {}) {
  return {
    id: String(thread.id || ""),
    isResolved: Boolean(thread.isResolved),
    isOutdated: Boolean(thread.isOutdated),
    path: String(thread.path || ""),
    line: Number(thread.line || thread.originalLine || 0),
    startLine: Number(thread.startLine || thread.originalStartLine || 0),
    side: String(thread.diffSide || "").toLowerCase(),
    resolvedBy: thread.resolvedBy ? String(thread.resolvedBy.login || "") : "",
    comments: (thread.comments?.nodes || []).map((comment) => ({
      id: String(comment.id || ""),
      databaseId: Number(comment.databaseId || 0),
      body: String(comment.body || ""),
      url: String(comment.url || ""),
      author: String(comment.author?.login || ""),
      createdAt: String(comment.createdAt || ""),
      updatedAt: String(comment.updatedAt || ""),
      status: thread.isResolved ? "resolved" : thread.isOutdated ? "outdated" : "open"
    }))
  };
}

const THREAD_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){
    pageInfo{hasNextPage endCursor}
    nodes{id isResolved isOutdated path line originalLine startLine originalStartLine diffSide resolvedBy{login}
      comments(first:100){pageInfo{hasNextPage endCursor} nodes{id databaseId body url createdAt updatedAt author{login}}}}
  }}}
}`;

const THREAD_COMMENTS_QUERY = `query($threadId:ID!,$cursor:String){
  node(id:$threadId){... on PullRequestReviewThread{comments(first:100,after:$cursor){
    pageInfo{hasNextPage endCursor}
    nodes{id databaseId body url createdAt updatedAt author{login}}
  }}}
}`;

function repositoryParts(nameWithOwner) {
  const [owner, name, ...rest] = String(nameWithOwner || "").split("/");
  if (!owner || !name || rest.length) {
    throw new GitHubReviewRuntimeError("Unable to determine the GitHub repository.", { code: "GITHUB_REPOSITORY_UNKNOWN" });
  }
  return { owner, name };
}

export function createGitHubReviewRuntime(options = {}) {
  const execute = options.run || runGh;
  const invoke = async (args, runOptions = {}) => {
    const result = await execute(args, runOptions);
    return typeof result === "string" ? { stdout: result, stderr: "", exitCode: 0 } : result;
  };

  async function getRepository(cwd) {
    const result = await invoke(["repo", "view", "--json", "nameWithOwner"], { cwd });
    return String(parseJson(result.stdout, "repository metadata").nameWithOwner || "");
  }

  async function getMetadata(cwd, pullRequest, repository) {
    const fields = "number,title,body,url,state,isDraft,author,baseRefName,baseRefOid,headRefName,headRefOid,mergeable,reviewDecision,updatedAt";
    const args = ["pr", "view", String(pullRequest), "--json", fields];
    if (repository) args.push("--repo", repository);
    const result = await invoke(args, { cwd });
    return normalizePullRequest(parseJson(result.stdout, "pull request metadata"), repository);
  }

  async function getFiles(cwd, repository, number) {
    const result = await invoke(["api", `repos/${repository}/pulls/${number}/files`, "--paginate", "--slurp"], { cwd });
    const pages = parseJson(result.stdout, "pull request files");
    const files = Array.isArray(pages) ? pages.flatMap((page) => Array.isArray(page) ? page : [page]) : [];
    return files.map(normalizeFile);
  }

  async function getDiff(cwd, pullRequest, repository) {
    const args = ["pr", "diff", String(pullRequest)];
    if (repository) args.push("--repo", repository);
    return String((await invoke(args, { cwd })).stdout || "");
  }

  async function getThreads(cwd, repository, number) {
    const { owner, name } = repositoryParts(repository);
    const threads = [];
    let cursor = "";
    do {
      const args = ["api", "graphql", "-f", `query=${THREAD_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`];
      if (cursor) args.push("-F", `cursor=${cursor}`);
      const result = parseJson((await invoke(args, { cwd })).stdout, "review threads");
      const connection = result.data?.repository?.pullRequest?.reviewThreads;
      if (!connection) throw new GitHubReviewRuntimeError("GitHub did not return review threads.", { code: "GITHUB_INVALID_RESPONSE" });
      for (const thread of connection.nodes || []) {
        let commentCursor = thread.comments?.pageInfo?.hasNextPage
          ? String(thread.comments.pageInfo.endCursor || "")
          : "";
        while (commentCursor) {
          const commentArgs = [
            "api", "graphql",
            "-f", `query=${THREAD_COMMENTS_QUERY}`,
            "-F", `threadId=${thread.id}`,
            "-F", `cursor=${commentCursor}`
          ];
          const commentResult = parseJson((await invoke(commentArgs, { cwd })).stdout, "review thread comments");
          const comments = commentResult.data?.node?.comments;
          if (!comments) throw new GitHubReviewRuntimeError("GitHub did not return review thread comments.", { code: "GITHUB_INVALID_RESPONSE" });
          thread.comments.nodes.push(...(comments.nodes || []));
          commentCursor = comments.pageInfo?.hasNextPage ? String(comments.pageInfo.endCursor || "") : "";
        }
        threads.push(normalizeThread(thread));
      }
      cursor = connection.pageInfo?.hasNextPage ? String(connection.pageInfo.endCursor || "") : "";
    } while (cursor);
    return threads;
  }

  return {
    async getPullRequestMetadata(input = {}) {
      const cwd = input.cwd || process.cwd();
      const repository = String(input.repository || await getRepository(cwd));
      return getMetadata(cwd, input.pullRequest || input.number || "", repository);
    },

    async getPullRequest(input = {}) {
      const cwd = input.cwd || process.cwd();
      const repository = String(input.repository || await getRepository(cwd));
      const metadata = await getMetadata(cwd, input.pullRequest || input.number || "", repository);
      const [files, diff, threads] = await Promise.all([
        getFiles(cwd, repository, metadata.number),
        getDiff(cwd, metadata.number, repository),
        getThreads(cwd, repository, metadata.number)
      ]);
      return { metadata, files, diff, threads };
    },

    async submitReview(input = {}) {
      const cwd = input.cwd || process.cwd();
      const repository = String(input.repository || await getRepository(cwd));
      const number = Number(input.number || 0);
      const event = String(input.decision || "comment").toLowerCase();
      const events = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" };
      if (!events[event]) throw new GitHubReviewRuntimeError("Unsupported review decision.", { status: 400, code: "REVIEW_DECISION_INVALID" });
      const payload = {
        event: events[event],
        body: String(input.body || ""),
        comments: (input.comments || []).map((comment) => ({
          path: String(comment.path || comment.file || ""),
          line: Number(comment.line || 0),
          side: String(comment.side || "RIGHT").toUpperCase(),
          ...(Number(comment.startLine || 0) > 0 ? {
            start_line: Number(comment.startLine),
            start_side: String(comment.startSide || comment.side || "RIGHT").toUpperCase()
          } : {}),
          body: String(comment.body || "")
        }))
      };
      const result = await invoke(["api", `repos/${repository}/pulls/${number}/reviews`, "--method", "POST", "--input", "-"], {
        cwd,
        stdin: JSON.stringify(payload)
      });
      return parseJson(result.stdout, "submitted review");
    }
  };
}

export const githubReviewRuntime = createGitHubReviewRuntime();
