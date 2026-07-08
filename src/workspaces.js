import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { withAgentReachPath } from "./agentReachRuntime.js";
import { getWorkspace, listWorkspaces, touchWorkspace, upsertWorkspace } from "./db.js";
import { ensureDefaultWorkspaces, resolveAllowedPath } from "./security.js";

const execFileAsync = promisify(execFile);
const ignoredDirs = new Set([".git", "node_modules", ".next", "dist", "build", "target", "coverage", ".agent-mobile-terminal"]);
const gitSummaryCache = new Map();
const gitSummaryCacheStats = { hits: 0, misses: 0, evictions: 0 };
const gitStatusCache = new Map();
const gitStatusCacheStats = { hits: 0, misses: 0, evictions: 0 };
const workspaceTreeCache = new Map();
const workspaceTreeCacheMaxEntries = 128;
const workspaceTreeStats = { budgetHits: 0, cacheHits: 0, cacheMisses: 0, cacheEvictions: 0 };
const workspaceContextFileCache = new Map();
const workspaceContextFileStats = { cacheHits: 0, cacheMisses: 0, cacheEvictions: 0 };
const rustWorkspaceTreeStats = { hits: 0, misses: 0 };
const textExtensions = new Set([
  ".txt",
  ".md",
  ".json",
  ".jsonl",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".html",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".py",
  ".ps1",
  ".sh",
  ".bat",
  ".cmd",
  ".java",
  ".go",
  ".rs",
  ".php",
  ".rb",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".sql"
]);

function lineCount(value) {
  if (!value) return 0;
  return String(value).split(/\r?\n/).filter(Boolean).length;
}

function gitSummaryCacheTtlMs() {
  const value = Number(process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS || 750);
  return Number.isFinite(value) && value >= 0 ? value : 750;
}

function gitCacheMaxEntries() {
  const value = Number(process.env.VIBELINK_GIT_CACHE_MAX_ENTRIES || 128);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 128;
}

function workspaceContextFileCacheMaxEntries() {
  const value = Number(process.env.VIBELINK_WORKSPACE_CONTEXT_FILE_CACHE_MAX_ENTRIES || 256);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 256;
}

function gitSummaryCacheKey(cwd = "") {
  return path.resolve(cwd || "").toLowerCase();
}

function statSignature(targetPath) {
  try {
    const stat = fs.statSync(targetPath);
    return `${Math.trunc(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function resolveGitDir(cwd) {
  const dotGit = path.join(cwd, ".git");
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (stat.isFile()) {
      const content = fs.readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/i.exec(content);
      if (match) return path.resolve(cwd, match[1]);
    }
  } catch {
    // Fall through to the common repository layout.
  }
  return dotGit;
}

function currentGitRefPath(gitDir) {
  try {
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const match = /^ref:\s*(.+)$/i.exec(head);
    return match ? path.join(gitDir, match[1]) : "";
  } catch {
    return "";
  }
}

async function gitChangedFilesSignature(cwd) {
  const status = await git(["--no-optional-locks", "status", "--porcelain=v1"], cwd);
  if (!status.ok) return "";
  const files = parseStatusFiles(status.stdout)
    .map((file) => file.path)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return files.map((filePath) => `${filePath}:${statSignature(path.join(cwd, filePath))}`).join("|");
}

async function gitSummaryCacheSignature(cwd) {
  const gitDir = resolveGitDir(cwd);
  const refPath = currentGitRefPath(gitDir);
  const baseSignature = [
    statSignature(cwd),
    statSignature(path.join(cwd, ".git")),
    statSignature(path.join(gitDir, "HEAD")),
    refPath ? statSignature(refPath) : "",
    statSignature(path.join(gitDir, "index"))
  ].join("|");
  return `${baseSignature}|${await gitChangedFilesSignature(cwd)}`;
}

function cloneGitSummary(summary = {}) {
  return {
    ...summary,
    files: Array.isArray(summary.files) ? summary.files.map((file) => ({ ...file })) : [],
    untrackedPreviewErrors: Array.isArray(summary.untrackedPreviewErrors)
      ? summary.untrackedPreviewErrors.map((item) => ({ ...item }))
      : []
  };
}

function invalidateGitSummaryCache(cwd = "") {
  if (!cwd) {
    gitSummaryCache.clear();
    gitStatusCache.clear();
    return;
  }
  gitSummaryCache.delete(gitSummaryCacheKey(cwd));
  gitStatusCache.delete(gitSummaryCacheKey(cwd));
}

function capGitCache(cache, stats) {
  const maxEntries = gitCacheMaxEntries();
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
    stats.evictions += 1;
  }
}

export function getWorkspaceRuntimeStats() {
  return {
    gitSummaryCache: {
      entries: gitSummaryCache.size,
      hits: gitSummaryCacheStats.hits,
      misses: gitSummaryCacheStats.misses,
      evictions: gitSummaryCacheStats.evictions,
      ttlMs: gitSummaryCacheTtlMs(),
      maxEntries: gitCacheMaxEntries()
    },
    gitStatusCache: {
      entries: gitStatusCache.size,
      hits: gitStatusCacheStats.hits,
      misses: gitStatusCacheStats.misses,
      evictions: gitStatusCacheStats.evictions,
      ttlMs: gitSummaryCacheTtlMs(),
      maxEntries: gitCacheMaxEntries()
    },
    workspaceTree: {
      entries: workspaceTreeCache.size,
      budgetHits: workspaceTreeStats.budgetHits,
      cacheHits: workspaceTreeStats.cacheHits,
      cacheMisses: workspaceTreeStats.cacheMisses,
      cacheEvictions: workspaceTreeStats.cacheEvictions,
      maxEntries: workspaceTreeCacheMaxEntries
    },
    workspaceContextFiles: {
      entries: workspaceContextFileCache.size,
      cacheHits: workspaceContextFileStats.cacheHits,
      cacheMisses: workspaceContextFileStats.cacheMisses,
      cacheEvictions: workspaceContextFileStats.cacheEvictions,
      maxEntries: workspaceContextFileCacheMaxEntries()
    },
    rustWorkspaceTree: {
      enabled: rustWorkspaceTreeEnabled(),
      hits: rustWorkspaceTreeStats.hits,
      misses: rustWorkspaceTreeStats.misses
    }
  };
}

function workspaceOrThrow(id) {
  const workspace = getWorkspace(id);
  if (!workspace) {
    const error = new Error("Workspace not found.");
    error.status = 404;
    throw error;
  }
  return workspace;
}

function cleanPathSegment(value = "", fallback = "worktree") {
  const cleaned = String(value || "")
    .trim()
    .replace(/^refs\/heads\//i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

async function git(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: withAgentReachPath(process.env),
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message,
      exitCode: error.code ?? 1
    };
  }
}

export function ensureWorkspaces(settings) {
  return ensureDefaultWorkspaces(settings);
}

export function getWorkspaces(settings) {
  ensureWorkspaces(settings);
  return listWorkspaces();
}

export function createWorkspace(body = {}, settings = {}) {
  const workspacePath = resolveAllowedPath(body.path || settings.defaultCwd || process.cwd(), settings);
  return upsertWorkspace({
    path: workspacePath,
    allowedRoot: workspacePath,
    title: body.title || path.basename(workspacePath) || workspacePath
  });
}

export function resolveWorkspacePath(id, settings) {
  const workspace = workspaceOrThrow(id);
  return resolveAllowedPath(workspace.path, settings);
}

async function gitRequired(args, cwd, message) {
  const result = await git(args, cwd);
  if (!result.ok) {
    const error = new Error(result.stderr || result.stdout || message || "Git command failed.");
    error.status = 409;
    error.result = result;
    throw error;
  }
  return result;
}

async function gitStdout(args, cwd, message) {
  const result = await gitRequired(args, cwd, message);
  return String(result.stdout || "").trim();
}

async function gitBranchExists(cwd, branchName) {
  const result = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], cwd);
  return result.ok;
}

async function assertCleanWorktree(cwd) {
  const status = await gitStdout(["status", "--porcelain"], cwd, "Failed to inspect git status.");
  if (status) {
    const error = new Error("Commit or stash local changes before creating a permanent worktree.");
    error.status = 409;
    error.details = status;
    throw error;
  }
}

function relativePath(root, value = "") {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\.\.(?:\/|$)/g, "");
}

function safeWorkspaceChild(root, child = "") {
  const target = path.resolve(root, relativePath(root, child));
  const normalizedRoot = path.resolve(root);
  if (target !== normalizedRoot && !target.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}${path.sep}`)) {
    const error = new Error("Path is outside workspace.");
    error.status = 403;
    throw error;
  }
  return target;
}

function isTextFile(filePath, stat) {
  if (stat.size > 512 * 1024) return false;
  return textExtensions.has(path.extname(filePath).toLowerCase());
}

function readTextSample(filePath, stat) {
  if (!isTextFile(filePath, stat)) return "";
  const raw = fs.readFileSync(filePath);
  if (raw.includes(0)) return "";
  return raw.toString("utf8");
}

function workspaceContextFileCacheKey(filePath) {
  return path.resolve(filePath).toLowerCase();
}

function workspaceContextFileSignature(stat) {
  return `${Math.trunc(stat.mtimeMs)}:${Math.trunc(stat.ctimeMs)}:${stat.size}`;
}

function cacheWorkspaceContextFile(filePath, stat, item) {
  workspaceContextFileCache.set(workspaceContextFileCacheKey(filePath), {
    signature: workspaceContextFileSignature(stat),
    item: { ...item }
  });
  while (workspaceContextFileCache.size > workspaceContextFileCacheMaxEntries()) {
    const oldestKey = workspaceContextFileCache.keys().next().value;
    workspaceContextFileCache.delete(oldestKey);
    workspaceContextFileStats.cacheEvictions += 1;
  }
  return item;
}

function workspaceContextForFile(target, rel, stat) {
  const key = workspaceContextFileCacheKey(target);
  const signature = workspaceContextFileSignature(stat);
  const cached = workspaceContextFileCache.get(key);
  if (cached?.signature === signature) {
    workspaceContextFileStats.cacheHits += 1;
    return { ...cached.item };
  }
  workspaceContextFileStats.cacheMisses += 1;

  const content = readTextSample(target, stat);
  if (!content) {
    return cacheWorkspaceContextFile(target, stat, {
      type: "file",
      path: rel,
      text: `<file path="${rel}" size="${stat.size}" binary_or_too_large="true" />`
    });
  }

  return cacheWorkspaceContextFile(target, stat, {
    type: "file",
    path: rel,
    text: `<file path="${rel}">\n${content.slice(0, 12000)}\n</file>`
  });
}

function rootGitignoreDirs(root) {
  try {
    const dirs = new Set();
    const content = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!") || trimmed.includes("*")) continue;
      const pattern = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!pattern || pattern.includes("/")) continue;
      dirs.add(pattern);
    }
    return dirs;
  } catch {
    return new Set();
  }
}

function workspaceTreeCacheKey(dir, root, depth, maxEntries) {
  let gitignoreMtimeMs = 0;
  try {
    gitignoreMtimeMs = fs.statSync(path.join(root, ".gitignore")).mtimeMs;
  } catch {
    gitignoreMtimeMs = 0;
  }
  return JSON.stringify({
    dir: path.resolve(dir),
    root: path.resolve(root),
    depth,
    maxEntries,
    dirVersion: workspaceTreeDirectoryVersion(dir, root, depth),
    gitignoreMtimeMs
  });
}

function workspaceTreeDirectoryVersion(dir, root, depth) {
  const gitignoreDirs = rootGitignoreDirs(root);
  const parts = [];
  const queue = [{ dir, rel: "", depth: 0 }];

  while (queue.length) {
    const current = queue.shift();
    const stat = fs.statSync(current.dir);
    parts.push(`${current.rel}:${stat.mtimeMs}`);
    if (current.depth + 1 >= depth) continue;

    const children = fs
      .readdirSync(current.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => !ignoredDirs.has(entry.name))
      .filter((entry) => !gitignoreDirs.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of children) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      queue.push({ dir: path.join(current.dir, entry.name), rel, depth: current.depth + 1 });
    }
  }

  return parts.join("|");
}

function rustWorkspaceTreeEnabled() {
  return /^(1|true|yes|on)$/i.test(process.env.VIBELINK_RUST_WORKSPACE_TREE || "");
}

function rustWorkspaceTreeCommand() {
  if (process.env.VIBELINK_RUST_BIN) return process.env.VIBELINK_RUST_BIN;
  return path.join(process.cwd(), "apps", "windows", "target", "debug", process.platform === "win32" ? "vibelink.exe" : "vibelink");
}

function rustWorkspaceTreeBaseArgs() {
  if (!process.env.VIBELINK_RUST_BIN_ARGS_JSON) return [];
  try {
    const parsed = JSON.parse(process.env.VIBELINK_RUST_BIN_ARGS_JSON);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function listDirectoryRust(dir, root, depth = 1, maxEntries = 240) {
  if (!rustWorkspaceTreeEnabled()) return null;
  const command = rustWorkspaceTreeCommand();
  if (!fs.existsSync(command)) {
    rustWorkspaceTreeStats.misses += 1;
    return null;
  }
  try {
    const { stdout } = await execFileAsync(command, [
      ...rustWorkspaceTreeBaseArgs(),
      "workspace-tree",
      "--root", root,
      "--dir", path.relative(root, dir),
      "--depth", String(depth),
      "--max-entries", String(maxEntries)
    ], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed.items)) {
      rustWorkspaceTreeStats.hits += 1;
      return parsed.items;
    }
    rustWorkspaceTreeStats.misses += 1;
    return null;
  } catch {
    rustWorkspaceTreeStats.misses += 1;
    return null;
  }
}
function listDirectory(dir, root, depth = 1, maxEntries = 160) {
  const cacheKey = workspaceTreeCacheKey(dir, root, depth, maxEntries);
  const cached = workspaceTreeCache.get(cacheKey);
  if (cached) {
    workspaceTreeStats.cacheHits += 1;
    return cached.map((item) => ({ ...item }));
  }
  workspaceTreeStats.cacheMisses += 1;

  const entries = [];
  const queue = [{ dir, depth: 0 }];
  const gitignoreDirs = rootGitignoreDirs(root);
  let budgetHit = false;

  while (queue.length && entries.length < maxEntries) {
    const current = queue.shift();
    const children = fs
      .readdirSync(current.dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") || entry.name === ".env")
      .filter((entry) => !(entry.isDirectory() && ignoredDirs.has(entry.name)))
      .filter((entry) => !(entry.isDirectory() && gitignoreDirs.has(entry.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of children) {
      if (entries.length >= maxEntries) {
        budgetHit = true;
        break;
      }
      const fullPath = path.join(current.dir, entry.name);
      const stat = fs.statSync(fullPath);
      const rel = path.relative(root, fullPath).replaceAll("\\", "/");
      const item = {
        name: entry.name,
        path: rel,
        type: entry.isDirectory() ? "directory" : "file",
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      };
      entries.push(item);
      if (entry.isDirectory() && current.depth + 1 < depth) queue.push({ dir: fullPath, depth: current.depth + 1 });
    }
  }

  if (entries.length >= maxEntries && queue.length) budgetHit = true;
  if (budgetHit) workspaceTreeStats.budgetHits += 1;
  workspaceTreeCache.set(cacheKey, entries.map((item) => ({ ...item })));
  while (workspaceTreeCache.size > workspaceTreeCacheMaxEntries) {
    const oldestKey = workspaceTreeCache.keys().next().value;
    workspaceTreeCache.delete(oldestKey);
    workspaceTreeStats.cacheEvictions += 1;
  }
  return entries;
}

export async function getWorkspaceTree(id, settings, dir = "") {
  const workspace = workspaceOrThrow(id);
  const root = resolveAllowedPath(workspace.path, settings);
  const target = safeWorkspaceChild(root, dir);
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    const error = new Error("Workspace tree path must be a directory.");
    error.status = 400;
    throw error;
  }
  touchWorkspace(workspace.id);
  const items = (await listDirectoryRust(target, root, 1, 240)) || listDirectory(target, root, 1, 240);
  return {
    ok: true,
    workspace,
    dir: path.relative(root, target).replaceAll("\\", "/"),
    items
  };
}

async function contextForPath(root, itemPath) {
  const target = safeWorkspaceChild(root, itemPath);
  const stat = fs.statSync(target);
  const rel = path.relative(root, target).replaceAll("\\", "/") || ".";

  if (stat.isDirectory()) {
    const entries = (await listDirectoryRust(target, root, 2, 220)) || listDirectory(target, root, 2, 220);
    return {
      type: "directory",
      path: rel,
      text: `<directory path="${rel}">\n${entries.map((item) => `${item.type === "directory" ? "dir " : "file"} ${item.path}`).join("\n")}\n</directory>`
    };
  }

  return workspaceContextForFile(target, rel, stat);
}

export async function getWorkspaceContext(id, settings, body = {}) {
  const workspace = workspaceOrThrow(id);
  const root = resolveAllowedPath(workspace.path, settings);
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 20) : [];
  touchWorkspace(workspace.id);
  const items = [];
  const errors = [];

  for (const itemPath of paths) {
    try {
      items.push(await contextForPath(root, itemPath));
    } catch (error) {
      errors.push({ path: String(itemPath || ""), error: error.message });
    }
  }

  return {
    ok: !errors.length,
    workspace,
    items,
    errors,
    prompt: items.map((item) => item.text).join("\n\n")
  };
}

export async function getWorkspaceFile(id, settings, filePath = "") {
  const workspace = workspaceOrThrow(id);
  const root = resolveAllowedPath(workspace.path, settings);
  const target = safeWorkspaceChild(root, filePath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    const error = new Error("Workspace file path must be a file.");
    error.status = 400;
    throw error;
  }
  touchWorkspace(workspace.id);
  const rel = path.relative(root, target).replaceAll("\\", "/");
  const text = readTextSample(target, stat);
  return {
    ok: true,
    workspace,
    path: rel,
    absolutePath: target,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    text,
    binary: !text
  };
}

export async function openWorkspaceInExplorer(id, settings) {
  const workspace = workspaceOrThrow(id);
  const target = resolveAllowedPath(workspace.path, settings);
  touchWorkspace(workspace.id);

  if (process.platform === "win32") {
    await execFileAsync("explorer.exe", [target], { windowsHide: true });
  } else if (process.platform === "darwin") {
    await execFileAsync("open", [target]);
  } else {
    await execFileAsync("xdg-open", [target]);
  }

  return {
    ok: true,
    workspace,
    path: target
  };
}

export async function createPermanentWorktree(id, settings, body = {}) {
  const workspace = workspaceOrThrow(id);
  const cwd = resolveAllowedPath(workspace.path, settings);
  const repoRoot = await gitStdout(["rev-parse", "--show-toplevel"], cwd, "Workspace is not a git repository.");
  const normalizedRepoRoot = resolveAllowedPath(repoRoot, settings);
  const repoName = cleanPathSegment(path.basename(normalizedRepoRoot), "repo");
  const baseRef = String(body.baseRef || "HEAD").trim() || "HEAD";
  const requestedBranch = String(body.branchName || body.name || "").trim();
  const currentBranch = await gitStdout(["branch", "--show-current"], normalizedRepoRoot, "Failed to read current branch.");
  const fallbackBranch = currentBranch ? `${currentBranch}-worktree` : "worktree";
  const branchName = cleanPathSegment(requestedBranch || fallbackBranch, fallbackBranch);
  const defaultRoot = path.resolve(path.dirname(normalizedRepoRoot), ".vibelink-worktrees");
  const worktreeRoot = body.root ? resolveAllowedPath(body.root, settings) : defaultRoot;
  const targetPath = body.path ? resolveAllowedPath(body.path, settings) : path.resolve(worktreeRoot, repoName, branchName);

  if (targetPath === normalizedRepoRoot || targetPath.toLowerCase().startsWith(`${normalizedRepoRoot.toLowerCase()}${path.sep}`)) {
    const error = new Error("Worktree path must be outside the source repository.");
    error.status = 400;
    throw error;
  }
  if (fs.existsSync(targetPath) && fs.readdirSync(targetPath).length > 0) {
    const error = new Error("Worktree path already exists and is not empty.");
    error.status = 409;
    error.path = targetPath;
    throw error;
  }

  await assertCleanWorktree(normalizedRepoRoot);
  const branchExists = await gitBranchExists(normalizedRepoRoot, branchName);
  const args = branchExists
    ? ["worktree", "add", targetPath, branchName]
    : ["worktree", "add", "-b", branchName, targetPath, baseRef];
  const result = await gitRequired(args, normalizedRepoRoot, "Failed to create git worktree.");
  const title = String(body.title || `${workspace.title || repoName} · ${branchName}`).trim();
  const newWorkspace = upsertWorkspace({
    path: targetPath,
    allowedRoot: targetPath,
    title
  });
  touchWorkspace(workspace.id);
  touchWorkspace(newWorkspace.id);

  return {
    ok: true,
    action: "create-worktree",
    sourceWorkspace: workspace,
    workspace: newWorkspace,
    cwd: normalizedRepoRoot,
    path: targetPath,
    branchName,
    baseRef,
    branchExisted: branchExists,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function parseStatusFiles(stdout = "") {
  return String(stdout || "")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("##"))
    .map((line) => ({
      status: line.slice(0, 2).trim() || "??",
      path: line.slice(3).trim()
    }))
    .filter((file) => file.path);
}

function parseDiffFiles(diff = "") {
  const files = [];
  let current = null;
  for (const line of String(diff || "").split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      current = { oldPath: match[1], path: match[2], status: "M", additions: 0, deletions: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (/^new file mode\b/.test(line)) current.status = "A";
    if (/^deleted file mode\b/.test(line)) current.status = "D";
    if (/^rename from\b/.test(line)) current.status = "R";
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
  }
  return files;
}

function escapeDiffPath(value = "") {
  return String(value || "").replaceAll("\\", "/");
}

function pseudoDiffForUntracked(root, relPath) {
  const target = safeWorkspaceChild(root, relPath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) return "";
  const content = readTextSample(target, stat);
  if (!content) return "";
  const lines = content.split(/\r?\n/).slice(0, 420);
  const pathValue = escapeDiffPath(relPath);
  return [
    `diff --git a/${pathValue} b/${pathValue}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${pathValue}`,
    `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
    ...lines.map((line) => `+${line}`),
    content.split(/\r?\n/).length > lines.length ? "+..." : ""
  ]
    .filter(Boolean)
    .join("\n");
}

async function gitDiffWithHeadFallback(cwd) {
  const result = await git(["diff", "HEAD", "--stat", "--patch", "--find-renames"], cwd);
  if (result.ok || !/bad revision|ambiguous argument|unknown revision/i.test(result.stderr || "")) return result;
  return git(["diff", "--stat", "--patch", "--find-renames"], cwd);
}

async function collectGitChangeSummary(cwd) {
  const [statusResult, diffResult] = await Promise.all([
    git(["status", "--porcelain=v1", "-b"], cwd),
    gitDiffWithHeadFallback(cwd)
  ]);
  const statusLines = statusResult.stdout.split(/\r?\n/).filter(Boolean);
  const branchLine = statusLines.find((line) => line.startsWith("##")) || "";
  const statusFiles = parseStatusFiles(statusResult.stdout);
  const untrackedFiles = statusFiles.filter((file) => file.status === "??").slice(0, 6);
  const untrackedDiff = [];
  const untrackedPreviewErrors = [];

  for (const file of untrackedFiles) {
    try {
      const preview = pseudoDiffForUntracked(cwd, file.path);
      if (preview) untrackedDiff.push(preview);
    } catch (error) {
      untrackedPreviewErrors.push({ path: file.path, error: error.message });
    }
  }

  const diff = [diffResult.stdout || "", ...untrackedDiff].filter(Boolean).join("\n");
  const diffFiles = parseDiffFiles(diff);
  const byPath = new Map(diffFiles.map((file) => [file.path || file.oldPath, file]));
  for (const file of statusFiles) {
    const existing = byPath.get(file.path);
    if (existing) {
      existing.status = file.status === "??" ? "A" : file.status || existing.status;
      continue;
    }
    byPath.set(file.path, { ...file, oldPath: file.path, additions: 0, deletions: 0 });
  }

  return {
    ok: statusResult.ok && diffResult.ok,
    branch: branchLine.replace(/^##\s*/, ""),
    files: [...byPath.values()],
    changedCount: statusFiles.length || byPath.size,
    fileCount: byPath.size,
    lineCount: lineCount(diff),
    diff,
    statusStdout: statusResult.stdout,
    stdout: diffResult.stdout,
    stderr: [statusResult.stderr, diffResult.stderr].filter(Boolean).join("\n"),
    exitCode: statusResult.exitCode || diffResult.exitCode || 0,
    untrackedPreviewErrors
  };
}

async function collectCachedGitChangeSummary(cwd) {
  const ttlMs = gitSummaryCacheTtlMs();
  const key = gitSummaryCacheKey(cwd);
  const signature = await gitSummaryCacheSignature(cwd);
  const cached = gitSummaryCache.get(key);
  if (ttlMs > 0 && cached && cached.signature === signature && cached.expiresAt > Date.now()) {
    gitSummaryCacheStats.hits += 1;
    return cloneGitSummary(cached.summary);
  }

  gitSummaryCacheStats.misses += 1;
  const summary = await collectGitChangeSummary(cwd);
  if (ttlMs > 0) {
    gitSummaryCache.set(key, {
      expiresAt: Date.now() + ttlMs,
      signature: await gitSummaryCacheSignature(cwd),
      summary: cloneGitSummary(summary)
    });
    capGitCache(gitSummaryCache, gitSummaryCacheStats);
  }
  return summary;
}

function gitStatusSummary(stdout = "", result = {}) {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("##")) || "";
  const files = parseStatusFiles(stdout);
  return {
    ok: result.ok,
    branch: branchLine.replace(/^##\s*/, ""),
    files,
    changedCount: files.length,
    stdout,
    stderr: result.stderr || "",
    exitCode: result.exitCode || 0
  };
}

function cloneGitStatusSummary(summary = {}) {
  return {
    ...summary,
    files: Array.isArray(summary.files) ? summary.files.map((file) => ({ ...file })) : []
  };
}

async function collectCachedGitStatus(cwd) {
  const ttlMs = gitSummaryCacheTtlMs();
  const key = gitSummaryCacheKey(cwd);
  const signature = await gitSummaryCacheSignature(cwd);
  const cached = gitStatusCache.get(key);
  if (ttlMs > 0 && cached && cached.signature === signature && cached.expiresAt > Date.now()) {
    gitStatusCacheStats.hits += 1;
    return cloneGitStatusSummary(cached.summary);
  }

  gitStatusCacheStats.misses += 1;
  const result = await git(["status", "--porcelain=v1", "-b"], cwd);
  const summary = gitStatusSummary(result.stdout, result);
  if (ttlMs > 0) {
    gitStatusCache.set(key, {
      expiresAt: Date.now() + ttlMs,
      signature: await gitSummaryCacheSignature(cwd),
      summary: cloneGitStatusSummary(summary)
    });
    capGitCache(gitStatusCache, gitStatusCacheStats);
  }
  return summary;
}

export async function getWorkspaceGitStatus(id, settings) {
  const workspace = workspaceOrThrow(id);
  const cwd = resolveAllowedPath(workspace.path, settings);
  touchWorkspace(workspace.id);
  const summary = await collectCachedGitStatus(cwd);

  return {
    ...summary,
    workspace,
    cwd
  };
}

export async function getWorkspaceGitDiff(id, settings) {
  const workspace = workspaceOrThrow(id);
  const cwd = resolveAllowedPath(workspace.path, settings);
  touchWorkspace(workspace.id);
  const summary = await collectCachedGitChangeSummary(cwd);
  return {
    ...summary,
    workspace,
    cwd
  };
}

function statusForPath(statusFiles = [], relPath = "") {
  const normalized = escapeDiffPath(relPath);
  return statusFiles.find((file) => escapeDiffPath(file.path) === normalized)?.status || "";
}

export async function applyWorkspaceGitFileAction(id, settings, body = {}) {
  const workspace = workspaceOrThrow(id);
  const cwd = resolveAllowedPath(workspace.path, settings);
  const relPath = relativePath(cwd, body.path || "");
  if (!relPath || relPath === ".") {
    const error = new Error("File path is required.");
    error.status = 400;
    throw error;
  }

  const target = safeWorkspaceChild(cwd, relPath);
  const action = String(body.action || "").trim().toLowerCase();
  touchWorkspace(workspace.id);

  if (action === "stage" || action === "accept") {
    const result = await git(["add", "--", relPath], cwd);
    if (!result.ok) {
      const error = new Error(result.stderr || "Failed to stage file.");
      error.status = 409;
      throw error;
    }
  } else if (action === "restore" || action === "reject") {
    const status = await getWorkspaceGitStatus(id, settings);
    const fileStatus = statusForPath(status.files || [], relPath);
    if (fileStatus === "??") {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    } else {
      const result = await git(["restore", "--staged", "--worktree", "--", relPath], cwd);
      if (!result.ok) {
        const error = new Error(result.stderr || "Failed to restore file.");
        error.status = 409;
        throw error;
      }
    }
  } else if (action === "unstage") {
    const result = await git(["restore", "--staged", "--", relPath], cwd);
    if (!result.ok) {
      const error = new Error(result.stderr || "Failed to unstage file.");
      error.status = 409;
      throw error;
    }
  } else {
    const error = new Error("Unsupported git file action.");
    error.status = 400;
    throw error;
  }

  invalidateGitSummaryCache(cwd);
  const summary = await collectCachedGitChangeSummary(cwd);
  return {
    ok: true,
    action,
    path: relPath,
    workspace,
    cwd,
    summary
  };
}

export async function applyWorkspaceGitAction(id, settings, body = {}) {
  const workspace = workspaceOrThrow(id);
  const cwd = resolveAllowedPath(workspace.path, settings);
  const action = String(body.action || "").trim().toLowerCase();
  touchWorkspace(workspace.id);

  let result;
  if (action === "stage-all") {
    result = await git(["add", "-A"], cwd);
  } else if (action === "unstage-all") {
    result = await git(["restore", "--staged", "."], cwd);
  } else if (action === "commit") {
    const message = String(body.message || "").trim();
    if (!message) {
      const error = new Error("Commit message is required.");
      error.status = 400;
      throw error;
    }
    result = await git(["commit", "-m", message], cwd);
  } else if (action === "push") {
    result = await git(["push"], cwd);
  } else if (action === "pull") {
    result = await git(["pull", "--ff-only"], cwd);
  } else if (action === "pr") {
    const title = String(body.title || "").trim();
    const args = ["pr", "create", "--fill"];
    if (title) args.push("--title", title);
    try {
      const { stdout, stderr } = await execFileAsync("gh", args, {
        cwd,
        env: withAgentReachPath(process.env),
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      });
      result = { ok: true, stdout, stderr };
    } catch (error) {
      result = { ok: false, stdout: error.stdout || "", stderr: error.stderr || error.message, exitCode: error.code ?? 1 };
    }
  } else {
    const error = new Error("Unsupported git action.");
    error.status = 400;
    throw error;
  }

  if (!result.ok) {
    const error = new Error(result.stderr || result.stdout || "Git action failed.");
    error.status = 409;
    error.result = result;
    throw error;
  }

  invalidateGitSummaryCache(cwd);
  const summary = await collectCachedGitChangeSummary(cwd);
  return {
    ok: true,
    action,
    workspace,
    cwd,
    stdout: result.stdout,
    stderr: result.stderr,
    summary
  };
}

function parseTestOutput(stdout = "", stderr = "", exitCode = 0) {
  const text = [stdout, stderr].filter(Boolean).join("\n");
  const lines = text.split(/\r?\n/);
  const failed = [];
  for (const line of lines) {
    if (/\b(fail|failed|error|exception)\b/i.test(line)) failed.push(line.trim());
  }
  const passedMatch = text.match(/(\d+)\s+(?:passing|passed|tests?\s+passed)/i);
  const failedMatch = text.match(/(\d+)\s+(?:failing|failed|tests?\s+failed|failures?)/i);
  return {
    ok: exitCode === 0,
    passed: passedMatch ? Number(passedMatch[1]) || 0 : exitCode === 0 ? 1 : 0,
    failed: failedMatch ? Number(failedMatch[1]) || failed.length : exitCode === 0 ? 0 : Math.max(1, failed.length),
    failures: failed.slice(0, 30),
    log: text
  };
}

export async function runWorkspaceCommand(id, settings, body = {}) {
  const workspace = workspaceOrThrow(id);
  const cwd = resolveAllowedPath(workspace.path, settings);
  const command = String(body.command || "").trim();
  if (!command) {
    const error = new Error("Command is required.");
    error.status = 400;
    throw error;
  }
  touchWorkspace(workspace.id);

  const shell = process.platform === "win32" ? "powershell.exe" : "sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
    : ["-lc", command];
  if (typeof body.onOutput === "function") {
    const result = await runWorkspaceCommandStream({ shell, args, cwd, command, body });
    return {
      ...result,
      workspace,
      cwd,
      command,
      test: body.kind === "test" ? parseTestOutput(result.stdout, result.stderr, result.exitCode || 0) : null
    };
  }
  let result;
  try {
    const { stdout, stderr } = await execFileAsync(shell, args, {
      cwd,
      env: withAgentReachPath(process.env),
      windowsHide: true,
      timeout: Math.min(Number(body.timeoutMs || 120000), 300000),
      maxBuffer: 20 * 1024 * 1024
    });
    result = { ok: true, stdout, stderr, exitCode: 0 };
  } catch (error) {
    result = {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message,
      exitCode: error.code ?? 1
    };
  }

  return {
    ...result,
    workspace,
    cwd,
    command,
    test: body.kind === "test" ? parseTestOutput(result.stdout, result.stderr, result.exitCode || 0) : null
  };
}

function runWorkspaceCommandStream({ shell, args, cwd, command, body = {} }) {
  return new Promise((resolve) => {
    const timeoutMs = Math.min(Number(body.timeoutMs || 120000), 300000);
    const signal = body.signal || null;
    if (signal?.aborted) {
      resolve({
        ok: false,
        stdout: "",
        stderr: "Command was stopped before it started.",
        exitCode: -1,
        cancelled: true
      });
      return;
    }
    const child = spawn(shell, args, {
      cwd,
      env: withAgentReachPath(process.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const startedAt = Date.now();
    const onOutput = typeof body.onOutput === "function" ? body.onOutput : null;
    const emit = (stream, data) => {
      const text = data.toString();
      if (stream === "stdout") stdout += text;
      else stderr += text;
      onOutput?.({
        stream,
        text,
        command,
        cwd,
        elapsedMs: Date.now() - startedAt
      });
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abortCommand);
      resolve(result);
    };
    const abortCommand = () => {
      try {
        child.kill();
      } catch {
        // Process may already be gone.
      }
      finish({
        ok: false,
        stdout,
        stderr: stderr || "Command stopped by user.",
        exitCode: -1,
        cancelled: true
      });
    };
    signal?.addEventListener?.("abort", abortCommand, { once: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Process may already be gone.
      }
      finish({
        ok: false,
        stdout,
        stderr: stderr || `Command timed out after ${timeoutMs}ms.`,
        exitCode: -1,
        timedOut: true
      });
    }, timeoutMs);

    child.stdout?.on("data", (data) => emit("stdout", data));
    child.stderr?.on("data", (data) => emit("stderr", data));
    child.on("error", (error) => {
      finish({
        ok: false,
        stdout,
        stderr: stderr || error.message,
        exitCode: -1
      });
    });
    child.on("close", (code, signal) => {
      finish({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code ?? (signal ? -1 : 0),
        signal: signal || ""
      });
    });
  });
}

export async function getTaskChanges(task, settings) {
  if (!task?.cwd) {
    return { ok: false, error: "Task has no workspace directory.", files: [], fileCount: 0, lineCount: 0, diff: "" };
  }

  const cwd = resolveAllowedPath(task.cwd, settings);
  const workspace = upsertWorkspace({ path: cwd, allowedRoot: cwd, title: path.basename(cwd) || cwd });
  const summary = await collectCachedGitChangeSummary(cwd);

  return {
    ...summary,
    taskId: task.id,
    workspace,
    cwd
  };
}
