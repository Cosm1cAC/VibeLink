import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { upsertWorkspace } from "../src/db.js";
import { getWorkspaceGitDiff, getWorkspaceGitStatus, getWorkspaceRuntimeStats } from "../src/workspaces.js";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

test("getWorkspaceGitDiff reuses a short-lived git summary cache", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-git-cache-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "VibeLink Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Test\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  fs.appendFileSync(path.join(repo, "README.md"), "change\n", "utf8");

  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "git-cache" });

  try {
    const before = getWorkspaceRuntimeStats().gitSummaryCache;
    const first = await getWorkspaceGitDiff(workspace.id, { allowedRoots: [tempRoot] });
    const second = await getWorkspaceGitDiff(workspace.id, { allowedRoots: [tempRoot] });
    const after = getWorkspaceRuntimeStats().gitSummaryCache;

    assert.equal(first.changedCount, 1);
    assert.equal(second.changedCount, 1);
    assert.equal(after.misses, before.misses + 1);
    assert.equal(after.hits, before.hits + 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("getWorkspaceGitDiff refreshes the cache when the worktree changes", async () => {
  const previousTtl = process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS;
  process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS = "60000";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-git-cache-refresh-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "VibeLink Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Test\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  fs.appendFileSync(path.join(repo, "README.md"), "change\n", "utf8");

  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "git-cache-refresh" });

  try {
    const first = await getWorkspaceGitDiff(workspace.id, { allowedRoots: [tempRoot] });
    fs.writeFileSync(path.join(repo, "SECOND.md"), "second\n", "utf8");
    const second = await getWorkspaceGitDiff(workspace.id, { allowedRoots: [tempRoot] });

    assert.equal(first.changedCount, 1);
    assert.equal(second.changedCount, 2);
    assert.ok(second.files.some((file) => file.path === "SECOND.md"));
  } finally {
    if (previousTtl === undefined) delete process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS;
    else process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS = previousTtl;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("getWorkspaceGitDiff refreshes when a nested tracked file changes", async () => {
  const previousTtl = process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS;
  process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS = "60000";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-git-cache-nested-refresh-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "VibeLink Test"]);
  fs.writeFileSync(path.join(repo, "src", "app.txt"), "one\n", "utf8");
  git(repo, ["add", "src/app.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  fs.writeFileSync(path.join(repo, "src", "app.txt"), "two\n", "utf8");

  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "git-cache-nested-refresh" });

  try {
    const first = await getWorkspaceGitDiff(workspace.id, { allowedRoots: [tempRoot] });
    fs.writeFileSync(path.join(repo, "src", "app.txt"), "three\n", "utf8");
    const second = await getWorkspaceGitDiff(workspace.id, { allowedRoots: [tempRoot] });

    assert.match(first.diff, /\+two/);
    assert.match(second.diff, /\+three/);
    assert.doesNotMatch(second.diff, /\+two/);
  } finally {
    if (previousTtl === undefined) delete process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS;
    else process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS = previousTtl;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("getWorkspaceGitDiff refreshes when tracked file content changes with stable mtime and size", async () => {
  const previousTtl = process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS;
  process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS = "60000";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-git-cache-content-refresh-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "VibeLink Test"]);
  const filePath = path.join(repo, "README.md");
  fs.writeFileSync(filePath, "base\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  fs.writeFileSync(filePath, "one!\n", "utf8");

  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "git-cache-content-refresh" });

  try {
    const first = await getWorkspaceGitDiff(workspace.id, { allowedRoots: [tempRoot] });
    const firstStat = fs.statSync(filePath);
    fs.writeFileSync(filePath, "two?\n", "utf8");
    fs.utimesSync(filePath, firstStat.atime, firstStat.mtime);
    const second = await getWorkspaceGitDiff(workspace.id, { allowedRoots: [tempRoot] });

    assert.match(first.diff, /\+one!/);
    assert.match(second.diff, /\+two\?/);
    assert.doesNotMatch(second.diff, /\+one!/);
  } finally {
    if (previousTtl === undefined) delete process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS;
    else process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS = previousTtl;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("getWorkspaceGitStatus reuses a short-lived git status cache", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-git-status-cache-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "VibeLink Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Test\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  fs.writeFileSync(path.join(repo, "NEW.md"), "new\n", "utf8");

  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "git-status-cache" });

  try {
    const before = getWorkspaceRuntimeStats().gitStatusCache;
    const first = await getWorkspaceGitStatus(workspace.id, { allowedRoots: [tempRoot] });
    const second = await getWorkspaceGitStatus(workspace.id, { allowedRoots: [tempRoot] });
    const after = getWorkspaceRuntimeStats().gitStatusCache;

    assert.equal(first.changedCount, 1);
    assert.equal(second.changedCount, 1);
    assert.equal(after.misses, before.misses + 1);
    assert.equal(after.hits, before.hits + 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("getWorkspaceGitStatus refreshes the cache when the worktree changes", async () => {
  const previousTtl = process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS;
  process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS = "60000";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-git-status-cache-refresh-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "VibeLink Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Test\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  fs.writeFileSync(path.join(repo, "NEW.md"), "new\n", "utf8");

  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "git-status-cache-refresh" });

  try {
    const first = await getWorkspaceGitStatus(workspace.id, { allowedRoots: [tempRoot] });
    fs.writeFileSync(path.join(repo, "SECOND.md"), "second\n", "utf8");
    const second = await getWorkspaceGitStatus(workspace.id, { allowedRoots: [tempRoot] });

    assert.equal(first.changedCount, 1);
    assert.equal(second.changedCount, 2);
    assert.ok(second.files.some((file) => file.path === "SECOND.md"));
  } finally {
    if (previousTtl === undefined) delete process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS;
    else process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS = previousTtl;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("workspace git caches cap retained repository entries", async () => {
  const previousTtl = process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS;
  const previousMaxEntries = process.env.VIBELINK_GIT_CACHE_MAX_ENTRIES;
  process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS = "60000";
  process.env.VIBELINK_GIT_CACHE_MAX_ENTRIES = "8";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-git-cache-cap-"));

  try {
    for (let i = 0; i < 12; i += 1) {
      const repo = path.join(tempRoot, `repo-${String(i).padStart(3, "0")}`);
      fs.mkdirSync(repo, { recursive: true });
      git(repo, ["init", "-b", "main"]);
      const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: `git-cache-cap-${i}` });
      await getWorkspaceGitStatus(workspace.id, { allowedRoots: [tempRoot] });
      await getWorkspaceGitDiff(workspace.id, { allowedRoots: [tempRoot] });
    }
    const stats = getWorkspaceRuntimeStats();

    assert.equal(stats.gitStatusCache.entries <= 8, true);
    assert.equal(stats.gitSummaryCache.entries <= 8, true);
    assert.equal(stats.gitStatusCache.evictions > 0, true);
    assert.equal(stats.gitSummaryCache.evictions > 0, true);
  } finally {
    if (previousTtl === undefined) delete process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS;
    else process.env.VIBELINK_GIT_SUMMARY_CACHE_TTL_MS = previousTtl;
    if (previousMaxEntries === undefined) delete process.env.VIBELINK_GIT_CACHE_MAX_ENTRIES;
    else process.env.VIBELINK_GIT_CACHE_MAX_ENTRIES = previousMaxEntries;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
