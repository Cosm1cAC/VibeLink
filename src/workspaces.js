import fs from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getWorkspace, listWorkspaces, touchWorkspace, upsertWorkspace } from "./db.js";
import { ensureDefaultWorkspaces, resolveAllowedPath } from "./security.js";

const execFileAsync = promisify(execFile);
const ignoredDirs = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".agent-mobile-terminal"]);
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

function workspaceOrThrow(id) {
  const workspace = getWorkspace(id);
  if (!workspace) {
    const error = new Error("Workspace not found.");
    error.status = 404;
    throw error;
  }
  return workspace;
}

async function git(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
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

function listDirectory(dir, root, depth = 1, maxEntries = 160) {
  const entries = [];
  const queue = [{ dir, depth: 0 }];

  while (queue.length && entries.length < maxEntries) {
    const current = queue.shift();
    const children = fs
      .readdirSync(current.dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") || entry.name === ".env")
      .filter((entry) => !(entry.isDirectory() && ignoredDirs.has(entry.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of children) {
      if (entries.length >= maxEntries) break;
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
  return {
    ok: true,
    workspace,
    dir: path.relative(root, target).replaceAll("\\", "/"),
    items: listDirectory(target, root, 1, 240)
  };
}

function contextForPath(root, itemPath) {
  const target = safeWorkspaceChild(root, itemPath);
  const stat = fs.statSync(target);
  const rel = path.relative(root, target).replaceAll("\\", "/") || ".";

  if (stat.isDirectory()) {
    const entries = listDirectory(target, root, 2, 220);
    return {
      type: "directory",
      path: rel,
      text: `<directory path="${rel}">\n${entries.map((item) => `${item.type === "directory" ? "dir " : "file"} ${item.path}`).join("\n")}\n</directory>`
    };
  }

  const content = readTextSample(target, stat);
  if (!content) {
    return {
      type: "file",
      path: rel,
      text: `<file path="${rel}" size="${stat.size}" binary_or_too_large="true" />`
    };
  }

  return {
    type: "file",
    path: rel,
    text: `<file path="${rel}">\n${content.slice(0, 12000)}\n</file>`
  };
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
      items.push(contextForPath(root, itemPath));
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

export async function getWorkspaceGitStatus(id, settings) {
  const workspace = workspaceOrThrow(id);
  const cwd = resolveAllowedPath(workspace.path, settings);
  touchWorkspace(workspace.id);
  const result = await git(["status", "--porcelain=v1", "-b"], cwd);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("##")) || "";
  const files = parseStatusFiles(result.stdout);

  return {
    ok: result.ok,
    workspace,
    branch: branchLine.replace(/^##\s*/, ""),
    files,
    changedCount: files.length,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode || 0
  };
}

export async function getWorkspaceGitDiff(id, settings) {
  const workspace = workspaceOrThrow(id);
  const cwd = resolveAllowedPath(workspace.path, settings);
  touchWorkspace(workspace.id);
  const summary = await collectGitChangeSummary(cwd);
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

  const summary = await collectGitChangeSummary(cwd);
  return {
    ok: true,
    action,
    path: relPath,
    workspace,
    cwd,
    summary
  };
}

export async function getTaskChanges(task, settings) {
  if (!task?.cwd) {
    return { ok: false, error: "Task has no workspace directory.", files: [], fileCount: 0, lineCount: 0, diff: "" };
  }

  const cwd = resolveAllowedPath(task.cwd, settings);
  const workspace = upsertWorkspace({ path: cwd, allowedRoot: cwd, title: path.basename(cwd) || cwd });
  const summary = await collectGitChangeSummary(cwd);

  return {
    ...summary,
    taskId: task.id,
    workspace,
    cwd
  };
}
