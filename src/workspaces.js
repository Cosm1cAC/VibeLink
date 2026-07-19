import crypto from "node:crypto";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { withAgentReachPath } from "./agentReachRuntime.js";
import { parseTestOutput } from "./testAdapters.js";
import { deleteWorkspaceByPath, getWorkspace, listWorkspaces, touchWorkspace, upsertWorkspace } from "./db.js";
import { getExecutionHostFacade } from "./executionHostClient.js";
import { ensureDefaultWorkspaces, resolveAllowedPath } from "./security.js";
import { createWorkspaceTreeSidecarClient } from "./workspaceTreeSidecarClient.js";

const execFileAsync = promisify(execFile);
const ignoredDirs = new Set([".git", "node_modules", ".next", "dist", "build", "target", "coverage", ".agent-mobile-terminal"]);
const gitSummaryCache = new Map();
const gitSummaryCacheStats = { hits: 0, misses: 0, evictions: 0 };
const gitStatusCache = new Map();
const gitStatusCacheStats = { hits: 0, misses: 0, evictions: 0 };
const workspaceTreeCache = new Map();
const workspaceTreeStats = { budgetHits: 0, cacheHits: 0, cacheMisses: 0, cacheEvictions: 0 };
const rustWorkspaceTreeCache = new Map();
let rustWorkspaceTreeSidecar = null;
let rustWorkspaceTreeSidecarKey = "";
let rustWorkspaceTreeSidecarReady = null;
let rustWorkspaceTreeLastClientStats = { terminated: true, pending: 0 };
const workspaceContextFileCache = new Map();
const workspaceContextFileStats = { cacheHits: 0, cacheMisses: 0, cacheEvictions: 0 };
const rustWorkspaceTreeStats = {
  hits: 0,
  misses: 0,
  fallbacks: 0,
  failures: 0,
  budgetHits: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheEvictions: 0,
  lastSignature: "",
  lastError: ""
};
const rustWorkspaceTreeSessionStats = {
  starts: 0,
  failures: 0,
  fallbacks: 0,
  ready: false,
  lastError: ""
};
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

function workspaceTreeCacheMaxEntries() {
  const value = Number(process.env.VIBELINK_WORKSPACE_TREE_CACHE_MAX_ENTRIES || 128);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 128;
}

function gitSummaryCacheKey(cwd = "") {
  return path.resolve(cwd || "").toLowerCase();
}

function fileContentSignature(targetPath, stat) {
  if (!stat.isFile()) return "";
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(targetPath)).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

function statSignature(targetPath, { contentHash = false } = {}) {
  try {
    const stat = fs.statSync(targetPath);
    const base = `${Math.trunc(stat.mtimeMs)}:${Math.trunc(stat.ctimeMs)}:${stat.size}`;
    return contentHash ? `${base}:${fileContentSignature(targetPath, stat)}` : base;
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
  return files.map((filePath) => `${filePath}:${statSignature(path.join(cwd, filePath), { contentHash: true })}`).join("|");
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
  const rustTreeMode = rustWorkspaceTreeMode();
  const rustTreeCommand = rustWorkspaceTreeCommand();
  const rustTreeEnabled = rustTreeMode !== "off";
  const sessionMode = rustWorkspaceTreeSessionMode();
  const sessionClientStats = rustWorkspaceTreeSidecar?.stats() || rustWorkspaceTreeLastClientStats;
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
      maxEntries: workspaceTreeCacheMaxEntries()
    },
    workspaceContextFiles: {
      entries: workspaceContextFileCache.size,
      cacheHits: workspaceContextFileStats.cacheHits,
      cacheMisses: workspaceContextFileStats.cacheMisses,
      cacheEvictions: workspaceContextFileStats.cacheEvictions,
      maxEntries: workspaceContextFileCacheMaxEntries()
    },
    rustWorkspaceTree: {
      enabled: rustTreeEnabled,
      mode: rustTreeMode,
      auto: rustTreeMode === "auto",
      command: rustTreeEnabled ? rustTreeCommand : "",
      available: rustTreeEnabled && rustWorkspaceTreeCommandAvailable(rustTreeCommand),
      hits: rustWorkspaceTreeStats.hits,
      misses: rustWorkspaceTreeStats.misses,
      fallbacks: rustWorkspaceTreeStats.fallbacks,
      failures: rustWorkspaceTreeStats.failures,
      budgetHits: rustWorkspaceTreeStats.budgetHits,
      cacheHits: rustWorkspaceTreeStats.cacheHits,
      cacheMisses: rustWorkspaceTreeStats.cacheMisses,
      cacheEvictions: rustWorkspaceTreeStats.cacheEvictions,
      entries: rustWorkspaceTreeCache.size,
      maxEntries: workspaceTreeCacheMaxEntries(),
      lastSignature: rustWorkspaceTreeStats.lastSignature,
      lastError: rustWorkspaceTreeStats.lastError,
      session: {
        enabled: rustTreeEnabled && sessionMode !== "off",
        mode: sessionMode,
        active: Boolean(rustWorkspaceTreeSidecar),
        ready: rustWorkspaceTreeSessionStats.ready,
        starts: rustWorkspaceTreeSessionStats.starts,
        failures: rustWorkspaceTreeSessionStats.failures,
        fallbacks: rustWorkspaceTreeSessionStats.fallbacks,
        lastError: rustWorkspaceTreeSessionStats.lastError,
        client: { ...sessionClientStats }
      }
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

async function gitWithInput(args, cwd, input = "") {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: withAgentReachPath(process.env),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ ok: false, stdout, stderr: stderr || error.message, exitCode: 1 });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.end(input);
  });
}

function unifiedPatchForPath(patchValue, relPath) {
  const patch = String(patchValue || "");
  if (!patch.trim()) {
    const error = new Error("Git hunk patch is required.");
    error.status = 400;
    throw error;
  }
  if (Buffer.byteLength(patch, "utf8") > 512 * 1024) {
    const error = new Error("Git hunk patch is too large.");
    error.status = 413;
    throw error;
  }
  const normalizedPath = relPath.replaceAll("\\", "/");
  const plainHeader = `diff --git a/${normalizedPath} b/${normalizedPath}`;
  const quotedHeader = `diff --git ${JSON.stringify(`a/${normalizedPath}`)} ${JSON.stringify(`b/${normalizedPath}`)}`;
  const diffHeaders = patch.split(/\r?\n/).filter((line) => line.startsWith("diff --git "));
  if (diffHeaders.length !== 1 || ![plainHeader, quotedHeader].includes(diffHeaders[0])) {
    const error = new Error("Git hunk patch must target exactly the requested file.");
    error.status = 400;
    throw error;
  }
  return patch.endsWith("\n") ? patch : `${patch}\n`;
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

function workspaceMutationPath(root, value = "", field = "path") {
  const raw = String(value || "").replaceAll("\\", "/").trim();
  if (!raw || raw === ".") {
    const error = new Error(`Workspace file ${field} is required.`);
    error.status = 400;
    throw error;
  }
  if (path.isAbsolute(raw) || /(^|\/)\.\.(\/|$)/.test(raw)) {
    const error = new Error("Path is outside workspace.");
    error.status = 403;
    throw error;
  }
  return safeWorkspaceChild(root, raw);
}

function invalidateWorkspaceCaches(root = "") {
  workspaceTreeCache.clear();
  rustWorkspaceTreeCache.clear();
  workspaceContextFileCache.clear();
  invalidateGitSummaryCache(root);
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

function workspaceContextFileSignature(filePath, stat) {
  const metadata = `${Math.trunc(stat.mtimeMs)}:${Math.trunc(stat.ctimeMs)}:${stat.size}`;
  return isTextFile(filePath, stat) ? `${metadata}:${fileContentSignature(filePath, stat)}` : metadata;
}

function cacheWorkspaceContextFile(filePath, stat, item) {
  workspaceContextFileCache.set(workspaceContextFileCacheKey(filePath), {
    signature: workspaceContextFileSignature(filePath, stat),
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
  const signature = workspaceContextFileSignature(target, stat);
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

function workspaceGitignoreBasenameMatches(pattern, name) {
  if (!pattern.includes("*")) return pattern === name;
  if (pattern === "*") return true;

  let remaining = name;
  const parts = pattern.split("*");
  let firstPart = true;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) {
      firstPart = false;
      continue;
    }
    if (firstPart && !pattern.startsWith("*")) {
      if (!remaining.startsWith(part)) return false;
      remaining = remaining.slice(part.length);
    } else if (index === parts.length - 1 && !pattern.endsWith("*")) {
      return remaining.endsWith(part);
    } else {
      const matchIndex = remaining.indexOf(part);
      if (matchIndex < 0) return false;
      remaining = remaining.slice(matchIndex + part.length);
    }
    firstPart = false;
  }
  return pattern.endsWith("*") || remaining.length === 0;
}

function workspaceGitignorePathMatches(pattern, itemPath) {
  const patternParts = pattern.split("/");
  const pathParts = itemPath.split("/");
  return patternParts.length === pathParts.length
    && patternParts.every((part, index) => workspaceGitignoreBasenameMatches(part, pathParts[index]));
}

function workspaceGitignoreRulesForDir(root, dir) {
  try {
    const rules = [];
    const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    const base = path.relative(root, dir).replaceAll("\\", "/");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const negated = trimmed.startsWith("!");
      const body = (negated ? trimmed.slice(1) : trimmed).trim();
      if (!body) continue;
      const directoryOnly = body.endsWith("/");
      const anchored = body.startsWith("/");
      const rawPattern = body.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!rawPattern) continue;
      const matchPath = anchored || rawPattern.includes("/");
      const pattern = matchPath && base ? `${base}/${rawPattern}` : rawPattern;
      rules.push({ pattern, matchPath, directoryOnly, negated });
    }
    return rules;
  } catch {
    return [];
  }
}

function workspaceGitignoreRulesForAncestors(root, dir) {
  const relative = path.relative(root, dir);
  if (!relative) return [];
  const parts = relative.split(path.sep).filter(Boolean);
  const rules = [...workspaceGitignoreRulesForDir(root, root)];
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    rules.push(...workspaceGitignoreRulesForDir(root, current));
  }
  return rules;
}

function isWorkspacePathIgnored(rules, name, itemPath, isDirectory) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    const matches = rule.matchPath
      ? workspaceGitignorePathMatches(rule.pattern, itemPath)
      : workspaceGitignoreBasenameMatches(rule.pattern, name);
    if (matches) ignored = !rule.negated;
  }
  return ignored;
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
    dirVersion: workspaceTreeDirectoryVersion(dir, root, depth, maxEntries),
    gitignoreMtimeMs
  });
}

function workspaceTreeDirectoryVersion(dir, root, depth, maxEntries) {
  const parts = [];
  const queue = [{ dir, depth: 0, ignoreRules: workspaceGitignoreRulesForAncestors(root, dir) }];
  let entriesSeen = 0;

  while (queue.length && entriesSeen < maxEntries) {
    const current = queue.shift();
    const stat = fs.statSync(current.dir);
    const currentPath = path.relative(root, current.dir).replaceAll("\\", "/");
    const ignoreRules = [...current.ignoreRules, ...workspaceGitignoreRulesForDir(root, current.dir)];
    parts.push(`${currentPath}:d:${stat.mtimeMs}:${stat.size}`);
    parts.push(`${currentPath}/.gitignore:${statSignature(path.join(current.dir, ".gitignore"), { contentHash: true })}`);

    const children = fs
      .readdirSync(current.dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") || entry.name === ".env")
      .filter((entry) => !(entry.isDirectory() && ignoredDirs.has(entry.name)))
      .filter((entry) => {
        const itemPath = path.relative(root, path.join(current.dir, entry.name)).replaceAll("\\", "/");
        return !isWorkspacePathIgnored(ignoreRules, entry.name, itemPath, entry.isDirectory());
      })
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of children) {
      if (entriesSeen >= maxEntries) break;
      const fullPath = path.join(current.dir, entry.name);
      const rel = path.relative(root, fullPath).replaceAll("\\", "/");
      const entryStat = fs.statSync(fullPath);
      parts.push(`${rel}:${entry.isDirectory() ? "d" : "f"}:${entryStat.mtimeMs}:${entryStat.size}`);
      entriesSeen += 1;
      if (entry.isDirectory() && current.depth + 1 < depth) {
        queue.push({ dir: fullPath, depth: current.depth + 1, ignoreRules });
      }
    }
  }

  return parts.join("|");
}

function rustWorkspaceTreeMode() {
  const value = String(process.env.VIBELINK_RUST_WORKSPACE_TREE || "").trim();
  if (/^auto$/i.test(value)) return "auto";
  if (/^(1|true|yes|on)$/i.test(value)) return "manual";
  return "off";
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

function rustWorkspaceTreeCommandAvailable(command) {
  return Boolean(command && fs.existsSync(command));
}

function rustWorkspaceTreeErrorMessage(error) {
  const detail = String(error?.stderr || error?.stdout || error?.message || error || "unknown error").trim();
  return detail.length > 500 ? `${detail.slice(0, 500)}...` : detail;
}

function recordRustWorkspaceTreeFallback(message) {
  rustWorkspaceTreeStats.misses += 1;
  rustWorkspaceTreeStats.fallbacks += 1;
  rustWorkspaceTreeStats.failures += 1;
  rustWorkspaceTreeStats.lastError = message;
}

function rustWorkspaceTreeSessionMode() {
  const value = String(process.env.VIBELINK_RUST_WORKSPACE_TREE_SESSION || "").trim();
  if (/^auto$/i.test(value)) return "auto";
  if (/^(1|true|yes|on)$/i.test(value)) return "manual";
  return "off";
}

function rustWorkspaceTreeSessionTimeoutMs() {
  const command = path.basename(String(process.env.VIBELINK_RUST_BIN || "")).toLowerCase();
  const fallback = command === "cargo" || command === "cargo.exe" ? 120000 : 10000;
  const value = Number(process.env.VIBELINK_RUST_WORKSPACE_TREE_SESSION_TIMEOUT_MS || fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function recordRustWorkspaceTreeBudgetFallback(message) {
  rustWorkspaceTreeStats.misses += 1;
  rustWorkspaceTreeStats.fallbacks += 1;
  rustWorkspaceTreeStats.lastError = message;
}

function rustWorkspaceTreeCacheKey(dir, root, depth, maxEntries, command, baseArgs) {
  return JSON.stringify({
    command,
    baseArgs,
    session: rustWorkspaceTreeSessionMode(),
    tree: workspaceTreeCacheKey(dir, root, depth, maxEntries)
  });
}

export async function closeRustWorkspaceTreeSidecar() {
  const client = rustWorkspaceTreeSidecar;
  rustWorkspaceTreeSidecar = null;
  rustWorkspaceTreeSidecarKey = "";
  rustWorkspaceTreeSidecarReady = null;
  rustWorkspaceTreeSessionStats.ready = false;
  if (!client) return { closed: false };
  await client.close();
  rustWorkspaceTreeLastClientStats = client.stats();
  return { closed: true };
}

async function ensureRustWorkspaceTreeSidecar(command, baseArgs) {
  const key = JSON.stringify({ command, baseArgs });
  if (rustWorkspaceTreeSidecar && rustWorkspaceTreeSidecarKey === key && rustWorkspaceTreeSessionStats.ready) {
    return rustWorkspaceTreeSidecar;
  }
  if (rustWorkspaceTreeSidecarReady && rustWorkspaceTreeSidecarKey === key) {
    return rustWorkspaceTreeSidecarReady;
  }
  if (rustWorkspaceTreeSidecar) await closeRustWorkspaceTreeSidecar();

  const client = createWorkspaceTreeSidecarClient({
    command,
    args: [...baseArgs, "workspace-tree-sidecar"],
    timeoutMs: rustWorkspaceTreeSessionTimeoutMs()
  });
  rustWorkspaceTreeSidecar = client;
  rustWorkspaceTreeSidecarKey = key;
  rustWorkspaceTreeSessionStats.starts += 1;
  rustWorkspaceTreeSessionStats.ready = false;
  const ready = (async () => {
    const health = await client.health();
    if (!health?.ok || health.implementation !== "rust" || health.protocolVersion !== 1) {
      throw new Error("Workspace tree Rust sidecar health check failed.");
    }
    if (rustWorkspaceTreeSidecar !== client || rustWorkspaceTreeSidecarKey !== key) {
      throw new Error("Workspace tree Rust sidecar was superseded during startup.");
    }
    rustWorkspaceTreeSessionStats.ready = true;
    rustWorkspaceTreeSessionStats.lastError = "";
    return client;
  })();
  rustWorkspaceTreeSidecarReady = ready;
  try {
    return await ready;
  } finally {
    if (rustWorkspaceTreeSidecarReady === ready) rustWorkspaceTreeSidecarReady = null;
  }
}

async function scanWithRustWorkspaceTreeSidecar(command, baseArgs, options) {
  try {
    const client = await ensureRustWorkspaceTreeSidecar(command, baseArgs);
    return await client.scan(options);
  } catch (error) {
    const message = rustWorkspaceTreeErrorMessage(error);
    rustWorkspaceTreeSessionStats.failures += 1;
    rustWorkspaceTreeSessionStats.fallbacks += 1;
    rustWorkspaceTreeSessionStats.lastError = message;
    await closeRustWorkspaceTreeSidecar().catch(() => {});
    return null;
  }
}

function cloneWorkspaceTreeItems(items = []) {
  return items.map((item) => ({ ...item }));
}

function orderWorkspaceTreeItemsLikeNode(items, dir, root) {
  const startPath = path.relative(root, dir).replaceAll("\\", "/");
  const byParent = new Map();
  const itemPaths = new Set();
  for (const rawItem of items) {
    const normalizedPath = typeof rawItem?.path === "string" ? rawItem.path.replace(/^(\.\/)+/, "") : "";
    const item = rawItem && { ...rawItem, path: normalizedPath };
    if (
      !item
      || !item.path
      || item.path.startsWith("/")
      || item.path.split("/").includes("..")
      || typeof item.name !== "string"
      || !["directory", "file"].includes(item.type)
      || item.path.split("/").at(-1) !== item.name
      || itemPaths.has(item.path)
    ) return null;
    itemPaths.add(item.path);
    const separator = item.path.lastIndexOf("/");
    const parentPath = separator >= 0 ? item.path.slice(0, separator) : "";
    const siblings = byParent.get(parentPath) || [];
    siblings.push({ ...item });
    byParent.set(parentPath, siblings);
  }

  const ordered = [];
  const queue = [startPath];
  const visitedParents = new Set();
  while (queue.length) {
    const parentPath = queue.shift();
    if (visitedParents.has(parentPath)) return null;
    visitedParents.add(parentPath);
    const children = byParent.get(parentPath) || [];
    children.sort((left, right) => (
      Number(right.type === "directory") - Number(left.type === "directory")
      || left.name.localeCompare(right.name)
    ));
    for (const item of children) {
      ordered.push(item);
      if (item.type === "directory") queue.push(item.path);
    }
  }
  return ordered.length === items.length ? ordered : null;
}

function cacheRustWorkspaceTree(cacheKey, signature, items) {
  if (!signature) return;
  rustWorkspaceTreeCache.set(cacheKey, {
    signature,
    items: cloneWorkspaceTreeItems(items)
  });
  while (rustWorkspaceTreeCache.size > workspaceTreeCacheMaxEntries()) {
    const oldestKey = rustWorkspaceTreeCache.keys().next().value;
    rustWorkspaceTreeCache.delete(oldestKey);
    rustWorkspaceTreeStats.cacheEvictions += 1;
  }
}

async function listDirectoryRust(dir, root, depth = 1, maxEntries = 240) {
  const mode = rustWorkspaceTreeMode();
  if (mode === "off") return null;
  const command = rustWorkspaceTreeCommand();
  if (!rustWorkspaceTreeCommandAvailable(command)) {
    if (mode === "manual") {
      recordRustWorkspaceTreeFallback(`Rust workspace-tree command not found: ${command}`);
    } else {
      rustWorkspaceTreeStats.misses += 1;
      rustWorkspaceTreeStats.lastError = "";
    }
    return null;
  }
  const baseArgs = rustWorkspaceTreeBaseArgs();
  const cacheKey = rustWorkspaceTreeCacheKey(dir, root, depth, maxEntries, command, baseArgs);
  const cached = rustWorkspaceTreeCache.get(cacheKey);
  if (cached) {
    rustWorkspaceTreeStats.cacheHits += 1;
    rustWorkspaceTreeStats.lastSignature = cached.signature;
    rustWorkspaceTreeStats.lastError = "";
    return cloneWorkspaceTreeItems(cached.items);
  }
  rustWorkspaceTreeStats.cacheMisses += 1;
  try {
    const relativeDir = path.relative(root, dir) || ".";
    let parsed = null;
    if (rustWorkspaceTreeSessionMode() !== "off") {
      parsed = await scanWithRustWorkspaceTreeSidecar(command, baseArgs, {
        root,
        dir: relativeDir,
        depth,
        maxEntries
      });
    }
    if (!parsed) {
      const { stdout } = await execFileAsync(command, [
        ...baseArgs,
        "workspace-tree",
        "--root", root,
        "--dir", relativeDir,
        "--depth", String(depth),
        "--max-entries", String(maxEntries)
      ], {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      });
      parsed = JSON.parse(stdout);
    }
    if (Array.isArray(parsed.items)) {
      if (parsed.truncated) {
        rustWorkspaceTreeStats.budgetHits += 1;
        recordRustWorkspaceTreeBudgetFallback("Rust workspace-tree reached its entry budget; using Node ordering and selection.");
        return null;
      }
      const orderedItems = orderWorkspaceTreeItemsLikeNode(parsed.items, dir, root);
      if (!orderedItems) {
        recordRustWorkspaceTreeFallback("Rust workspace-tree returned items outside the requested traversal.");
        return null;
      }
      rustWorkspaceTreeStats.hits += 1;
      if (typeof parsed.signature === "string") rustWorkspaceTreeStats.lastSignature = parsed.signature;
      rustWorkspaceTreeStats.lastError = "";
      cacheRustWorkspaceTree(cacheKey, parsed.signature, orderedItems);
      return cloneWorkspaceTreeItems(orderedItems);
    }
    recordRustWorkspaceTreeFallback("Rust workspace-tree returned invalid payload.");
    return null;
  } catch (error) {
    recordRustWorkspaceTreeFallback(`Rust workspace-tree failed: ${rustWorkspaceTreeErrorMessage(error)}`);
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
  const queue = [{ dir, depth: 0, ignoreRules: workspaceGitignoreRulesForAncestors(root, dir) }];
  let budgetHit = false;

  while (queue.length && entries.length < maxEntries) {
    const current = queue.shift();
    const ignoreRules = [...current.ignoreRules, ...workspaceGitignoreRulesForDir(root, current.dir)];
    const children = fs
      .readdirSync(current.dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") || entry.name === ".env")
      .filter((entry) => !(entry.isDirectory() && ignoredDirs.has(entry.name)))
      .filter((entry) => {
        const itemPath = path.relative(root, path.join(current.dir, entry.name)).replaceAll("\\", "/");
        return !isWorkspacePathIgnored(ignoreRules, entry.name, itemPath, entry.isDirectory());
      })
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
      if (entry.isDirectory() && current.depth + 1 < depth) {
        queue.push({ dir: fullPath, depth: current.depth + 1, ignoreRules });
      }
    }
  }

  if (entries.length >= maxEntries && queue.length) budgetHit = true;
  if (budgetHit) workspaceTreeStats.budgetHits += 1;
  workspaceTreeCache.set(cacheKey, entries.map((item) => ({ ...item })));
  while (workspaceTreeCache.size > workspaceTreeCacheMaxEntries()) {
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

async function workspaceFileRevision(target) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(target);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function workspaceFileEtag(revision) {
  return `"vibelink:workspace-file:${revision}"`;
}

async function assertWorkspaceFileRevision(id, settings, filePath, target, expectedRevision, requireAbsent = false) {
  if (!requireAbsent && (expectedRevision === undefined || expectedRevision === null || expectedRevision === "")) return;
  const exists = fs.existsSync(target) && fs.statSync(target).isFile();
  const current = exists ? await getWorkspaceFile(id, settings, filePath) : null;
  const actualRevision = current?.revision || null;
  if (requireAbsent && !exists) return;
  if (String(expectedRevision) === String(actualRevision || "")) return;

  const error = new Error("Workspace file changed on another device.");
  error.status = 409;
  error.code = "WORKSPACE_FILE_CONFLICT";
  error.expectedRevision = expectedRevision === undefined || expectedRevision === null ? null : String(expectedRevision);
  error.actualRevision = actualRevision;
  error.current = current;
  throw error;
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
  const revision = await workspaceFileRevision(target);
  return {
    ok: true,
    workspace,
    path: rel,
    absolutePath: target,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    revision,
    etag: workspaceFileEtag(revision),
    text,
    binary: !text
  };
}

export async function mutateWorkspaceFile(id, settings, body = {}) {
  const workspace = workspaceOrThrow(id);
  const root = resolveAllowedPath(workspace.path, settings);
  const action = String(body.action || "write").trim().toLowerCase();
  const target = workspaceMutationPath(root, body.path || "", "path");
  touchWorkspace(workspace.id);

  await assertWorkspaceFileRevision(id, settings, body.path || "", target, body.expectedRevision, body.requireAbsent === true);

  if (action === "write") {
    const text = typeof body.text === "string" ? body.text : "";
    if (Buffer.byteLength(text, "utf8") > 1024 * 1024) {
      const error = new Error("Workspace file text is too large.");
      error.status = 413;
      throw error;
    }
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) {
      const error = new Error("Workspace file path must be a file.");
      error.status = 400;
      throw error;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
    invalidateWorkspaceCaches(root);
    const rel = path.relative(root, target).replaceAll("\\", "/");
    return {
      ...(await getWorkspaceFile(id, settings, rel)),
      action
    };
  }

  if (action === "delete") {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      const error = new Error("Workspace file path must be a file.");
      error.status = 400;
      throw error;
    }
    fs.unlinkSync(target);
    invalidateWorkspaceCaches(root);
    return {
      ok: true,
      action,
      workspace,
      path: path.relative(root, target).replaceAll("\\", "/")
    };
  }

  if (action === "rename") {
    const nextTarget = workspaceMutationPath(root, body.nextPath || "", "nextPath");
    if (!fs.existsSync(target)) {
      const error = new Error("Workspace file path does not exist.");
      error.status = 404;
      throw error;
    }
    if (fs.existsSync(nextTarget)) {
      const error = new Error("Workspace destination already exists.");
      error.status = 409;
      throw error;
    }
    fs.mkdirSync(path.dirname(nextTarget), { recursive: true });
    fs.renameSync(target, nextTarget);
    invalidateWorkspaceCaches(root);
    const rel = path.relative(root, nextTarget).replaceAll("\\", "/");
    return {
      ...(await getWorkspaceFile(id, settings, rel)),
      action,
      previousPath: path.relative(root, target).replaceAll("\\", "/")
    };
  }

  const error = new Error("Unsupported workspace file action.");
  error.status = 400;
  throw error;
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
  } else if (action === "use-ours" || action === "use-theirs") {
    const side = action === "use-ours" ? "--ours" : "--theirs";
    const checkout = await git(["checkout", side, "--", relPath], cwd);
    if (!checkout.ok) {
      const error = new Error(checkout.stderr || "Failed to select the conflict side.");
      error.status = 409;
      throw error;
    }
    const staged = await git(["add", "--", relPath], cwd);
    if (!staged.ok) {
      const error = new Error(staged.stderr || "Failed to mark the conflict as resolved.");
      error.status = 409;
      throw error;
    }
  } else if (action === "mark-resolved") {
    const result = await git(["add", "--", relPath], cwd);
    if (!result.ok) {
      const error = new Error(result.stderr || "Failed to mark the conflict as resolved.");
      error.status = 409;
      throw error;
    }
  } else if (action === "stage-hunk" || action === "unstage-hunk") {
    const patch = unifiedPatchForPath(body.patch, relPath);
    const args = ["apply", "--cached", "--unidiff-zero"];
    if (action === "unstage-hunk") args.push("--reverse");
    args.push("-");
    const result = await gitWithInput(args, cwd, patch);
    if (!result.ok) {
      const error = new Error(result.stderr || "Failed to apply git hunk.");
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
  } else if (action === "branch-create" || action === "branch-switch") {
    const branchName = String(body.branchName || "").trim();
    if (!branchName) {
      const error = new Error("Branch name is required.");
      error.status = 400;
      throw error;
    }
    const validBranch = await git(["check-ref-format", "--branch", branchName], cwd);
    if (!validBranch.ok) {
      const error = new Error(validBranch.stderr || "Invalid branch name.");
      error.status = 400;
      throw error;
    }
    if (action === "branch-create") {
      const baseRef = String(body.baseRef || "HEAD").trim() || "HEAD";
      const resolvedBase = await git(["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], cwd);
      if (!resolvedBase.ok) {
        const error = new Error(resolvedBase.stderr || "Base ref was not found.");
        error.status = 400;
        throw error;
      }
      result = await git(["switch", "-c", branchName, resolvedBase.stdout.trim()], cwd);
    } else {
      result = await git(["switch", branchName], cwd);
    }
  } else if (action === "stash-push") {
    const args = ["stash", "push", "-u"];
    const message = String(body.message || "").trim();
    if (message) args.push("-m", message);
    result = await git(args, cwd);
  } else if (action === "stash-pop") {
    result = await git(["stash", "pop"], cwd);
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
  const inherited = withAgentReachPath(process.env);
  const facade = body.executionHost || getExecutionHostFacade();
  const result = await facade.runCommand({
    executionId: body.executionId,
    shell,
    args,
    cwd,
    env: { PATH: inherited.PATH || inherited.Path || "" },
    timeoutMs: Math.min(Number(body.timeoutMs || 120000), 300000),
    signal: body.signal || null,
    onExecutionStart: body.onExecutionStart || null,
    onHostEvent: body.onHostEvent || null,
    onHostAck: body.onHostAck || null,
    onSnapshot: body.onSnapshot || null,
    onOutput: typeof body.onOutput === "function"
      ? (chunk) => body.onOutput({ ...chunk, command, cwd })
      : null
  });

  return {
    ...result,
    workspace,
    cwd,
    command,
    test: body.kind === "test" ? parseTestOutput({
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode || 0
    }) : null
  };
}

function parseWorktreeList(stdout = "") {
  const entries = [];
  let current = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = {
        path: path.resolve(value),
        headSha: "",
        branch: "",
        detached: false,
        bare: false,
        locked: false,
        lockReason: "",
        prunable: false,
        pruneReason: ""
      };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.headSha = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") {
      current.locked = true;
      current.lockReason = value;
    } else if (key === "prunable") {
      current.prunable = true;
      current.pruneReason = value;
    }
  }
  if (current) entries.push(current);
  return entries.map((entry, index) => ({ ...entry, isMain: index === 0 }));
}

function sameResolvedPath(left, right) {
  const normalize = (value) => {
    let resolved = path.resolve(value);
    try { resolved = fs.realpathSync.native(resolved); } catch {}
    return resolved.replace(/[\\/]+$/, "").toLowerCase();
  };
  return normalize(left) === normalize(right);
}

export async function listWorkspaceWorktrees(id, settings) {
  const workspace = workspaceOrThrow(id);
  const cwd = resolveAllowedPath(workspace.path, settings);
  const result = await gitRequired(["worktree", "list", "--porcelain"], cwd, "Failed to list git worktrees.");
  const registered = new Map(listWorkspaces().map((item) => [path.resolve(item.path).toLowerCase(), item]));
  const worktrees = parseWorktreeList(result.stdout).map((item) => ({
    ...item,
    workspace: registered.get(item.path.toLowerCase()) || null
  }));
  touchWorkspace(workspace.id);
  return { ok: true, workspaceId: workspace.id, worktrees };
}

export async function applyWorkspaceWorktreeAction(id, settings, body = {}) {
  const workspace = workspaceOrThrow(id);
  const cwd = resolveAllowedPath(workspace.path, settings);
  const action = String(body.action || "").trim().toLowerCase();
  if (!new Set(["remove", "prune", "lock", "unlock"]).has(action)) {
    const error = new Error("Worktree action must be remove, prune, lock, or unlock.");
    error.status = 400;
    error.code = "WORKTREE_ACTION_INVALID";
    throw error;
  }

  if (action === "prune") {
    const expire = String(body.expire || "").trim().slice(0, 100);
    const args = ["worktree", "prune", "--verbose"];
    if (expire) args.push("--expire", expire);
    const result = await gitRequired(args, cwd, "Failed to prune git worktrees.");
    touchWorkspace(workspace.id);
    return { ok: true, action, stdout: result.stdout, stderr: result.stderr };
  }

  if (!body.path) {
    const error = new Error(`Worktree path is required for ${action}.`);
    error.status = 400;
    error.code = "WORKTREE_PATH_REQUIRED";
    throw error;
  }
  const targetPath = resolveAllowedPath(body.path, settings);
  const listed = await listWorkspaceWorktrees(id, settings);
  const target = listed.worktrees.find((item) => sameResolvedPath(item.path, targetPath));
  if (!target) {
    const error = new Error("Path is not a worktree of this repository.");
    error.status = 404;
    error.code = "WORKTREE_NOT_FOUND";
    throw error;
  }
  if (target.isMain && action === "remove") {
    const error = new Error("The main worktree cannot be removed.");
    error.status = 409;
    error.code = "WORKTREE_MAIN_PROTECTED";
    throw error;
  }

  const args = ["worktree", action];
  if (action === "remove" && body.force === true) args.push("--force");
  if (action === "lock") {
    const reason = String(body.reason || "").trim().slice(0, 500);
    if (reason) args.push("--reason", reason);
  }
  args.push(target.path);
  const result = await gitRequired(args, cwd, `Failed to ${action} git worktree.`);
  if (action === "remove") deleteWorkspaceByPath(target.path);
  touchWorkspace(workspace.id);
  return {
    ok: true,
    action,
    path: target.path,
    stdout: result.stdout,
    stderr: result.stderr,
    worktrees: (await listWorkspaceWorktrees(id, settings)).worktrees
  };
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
