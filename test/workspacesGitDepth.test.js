import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  applyWorkspaceGitAction,
  applyWorkspaceGitFileAction,
  createWorkspace
} from "../src/workspaces.js";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function createRepository(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "VibeLink Test"]);
  return { tempRoot, repo };
}

test("workspace git actions create and switch branches and round-trip a stash", async () => {
  const { tempRoot, repo } = createRepository("vibelink-git-depth-");
  fs.writeFileSync(path.join(repo, "notes.txt"), "base\n", "utf8");
  git(repo, ["add", "notes.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  const settings = { defaultCwd: repo, allowedRoots: [tempRoot] };
  const workspace = createWorkspace({ path: repo, title: "Git depth" }, settings);

  try {
    await applyWorkspaceGitAction(workspace.id, settings, {
      action: "branch-create",
      branchName: "feature/mobile",
      baseRef: "HEAD"
    });
    assert.equal(git(repo, ["branch", "--show-current"]), "feature/mobile");

    fs.writeFileSync(path.join(repo, "notes.txt"), "changed\n", "utf8");
    await applyWorkspaceGitAction(workspace.id, settings, {
      action: "stash-push",
      message: "android workspace"
    });
    assert.equal(git(repo, ["status", "--porcelain"]), "");
    assert.match(git(repo, ["stash", "list"]), /android workspace/);

    await applyWorkspaceGitAction(workspace.id, settings, {
      action: "branch-switch",
      branchName: "main"
    });
    assert.equal(git(repo, ["branch", "--show-current"]), "main");

    await applyWorkspaceGitAction(workspace.id, settings, {
      action: "branch-switch",
      branchName: "feature/mobile"
    });
    await applyWorkspaceGitAction(workspace.id, settings, { action: "stash-pop" });
    assert.equal(fs.readFileSync(path.join(repo, "notes.txt"), "utf8").replaceAll("\r\n", "\n"), "changed\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("workspace git file actions stage one unified diff hunk", async () => {
  const { tempRoot, repo } = createRepository("vibelink-git-hunk-");
  const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  fs.writeFileSync(path.join(repo, "notes.txt"), original, "utf8");
  git(repo, ["add", "notes.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  const changedLines = original.trimEnd().split("\n");
  changedLines[0] = "LINE ONE";
  changedLines[19] = "LINE TWENTY";
  fs.writeFileSync(path.join(repo, "notes.txt"), changedLines.join("\n") + "\n", "utf8");
  const settings = { defaultCwd: repo, allowedRoots: [tempRoot] };
  const workspace = createWorkspace({ path: repo, title: "Git hunk" }, settings);
  const patch = [
    "diff --git a/notes.txt b/notes.txt",
    "--- a/notes.txt",
    "+++ b/notes.txt",
    "@@ -1 +1 @@",
    "-line 1",
    "+LINE ONE",
    ""
  ].join("\n");

  try {
    await applyWorkspaceGitFileAction(workspace.id, settings, {
      action: "stage-hunk",
      path: "notes.txt",
      patch
    });
    const staged = git(repo, ["diff", "--cached", "--", "notes.txt"]);
    const unstaged = git(repo, ["diff", "--", "notes.txt"]);
    assert.match(staged, /\+LINE ONE/);
    assert.doesNotMatch(staged, /LINE TWENTY/);
    assert.match(unstaged, /\+LINE TWENTY/);
    assert.doesNotMatch(unstaged, /\+LINE ONE/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("workspace git file actions resolve a conflict with the selected side", async () => {
  const { tempRoot, repo } = createRepository("vibelink-git-conflict-");
  fs.writeFileSync(path.join(repo, "notes.txt"), "base\n", "utf8");
  git(repo, ["add", "notes.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["switch", "-c", "feature"]);
  fs.writeFileSync(path.join(repo, "notes.txt"), "feature\n", "utf8");
  git(repo, ["commit", "-am", "feature change"]);
  git(repo, ["switch", "main"]);
  fs.writeFileSync(path.join(repo, "notes.txt"), "main\n", "utf8");
  git(repo, ["commit", "-am", "main change"]);
  assert.throws(() => git(repo, ["merge", "feature"]));
  const settings = { defaultCwd: repo, allowedRoots: [tempRoot] };
  const workspace = createWorkspace({ path: repo, title: "Git conflict" }, settings);

  try {
    await applyWorkspaceGitFileAction(workspace.id, settings, {
      action: "use-theirs",
      path: "notes.txt"
    });
    assert.equal(fs.readFileSync(path.join(repo, "notes.txt"), "utf8").replaceAll("\r\n", "\n"), "feature\n");
    assert.equal(git(repo, ["diff", "--name-only", "--diff-filter=U"]), "");
    assert.match(git(repo, ["diff", "--cached", "--", "notes.txt"]), /\+feature/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
