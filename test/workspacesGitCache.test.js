import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { upsertWorkspace } from "../src/db.js";
import { getWorkspaceGitDiff, getWorkspaceRuntimeStats } from "../src/workspaces.js";

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
