import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { applyWorkspaceWorktreeAction, createPermanentWorktree, createWorkspace, listWorkspaceWorktrees } from "../src/workspaces.js";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

test("createPermanentWorktree creates a git worktree and registers a workspace", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-worktree-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "VibeLink Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);

  const settings = {
    defaultCwd: repo,
    allowedRoots: [tempRoot]
  };
  const sourceWorkspace = createWorkspace({ path: repo, title: "Repo" }, settings);
  const result = await createPermanentWorktree(sourceWorkspace.id, settings, {
    branchName: "feature/worktree",
    title: "Repo feature worktree"
  });

  assert.equal(result.ok, true);
  assert.equal(result.branchName, "feature-worktree");
  assert.equal(result.workspace.title, "Repo feature worktree");
  assert.equal(fs.existsSync(path.join(result.path, ".git")), true);
  assert.equal(git(result.path, ["branch", "--show-current"]), "feature-worktree");
  assert.match(result.path.replaceAll("\\", "/"), /\.vibelink-worktrees\/repo\/feature-worktree$/);
});

test("worktree lifecycle lists, locks, unlocks, removes, and prunes worktrees", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-worktree-lifecycle-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "VibeLink Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["worktree", "add", "-b", "feature/lifecycle", linked]);

  const settings = { defaultCwd: repo, allowedRoots: [tempRoot] };
  const workspace = createWorkspace({ path: repo, title: "Repo lifecycle" }, settings);
  let worktrees = await listWorkspaceWorktrees(workspace.id, settings);
  assert.equal(worktrees.worktrees.length, 2);
  const canonicalLinked = fs.realpathSync.native(linked);
  assert.equal(worktrees.worktrees.find((item) => item.path === canonicalLinked).branch, "feature/lifecycle");
  assert.equal(worktrees.worktrees[0].isMain, true);

  await applyWorkspaceWorktreeAction(workspace.id, settings, { action: "lock", path: linked, reason: "active review" });
  worktrees = await listWorkspaceWorktrees(workspace.id, settings);
  assert.equal(worktrees.worktrees.find((item) => item.path === canonicalLinked).locked, true);

  await applyWorkspaceWorktreeAction(workspace.id, settings, { action: "unlock", path: linked });
  const removed = await applyWorkspaceWorktreeAction(workspace.id, settings, { action: "remove", path: linked });
  assert.equal(removed.action, "remove");
  assert.equal(fs.existsSync(linked), false);

  const pruned = await applyWorkspaceWorktreeAction(workspace.id, settings, { action: "prune", expire: "now" });
  assert.equal(pruned.action, "prune");
  await assert.rejects(
    applyWorkspaceWorktreeAction(workspace.id, settings, { action: "remove", path: repo }),
    (error) => error.status === 409 && error.code === "WORKTREE_MAIN_PROTECTED"
  );
});
