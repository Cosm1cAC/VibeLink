import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { upsertWorkspace } from "../src/db.js";
import { getWorkspaceFile, mutateWorkspaceFile } from "../src/workspaces.js";

test("mutateWorkspaceFile writes, renames, and deletes text files inside a workspace", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-file-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "files" });
  const settings = { allowedRoots: [tempRoot] };

  try {
    const written = await mutateWorkspaceFile(workspace.id, settings, {
      action: "write",
      path: "src/notes.md",
      text: "# Notes\nShip it.\n"
    });
    assert.equal(written.ok, true);
    assert.equal(written.path, "src/notes.md");
    assert.equal(fs.readFileSync(path.join(repo, "src", "notes.md"), "utf8"), "# Notes\nShip it.\n");

    const renamed = await mutateWorkspaceFile(workspace.id, settings, {
      action: "rename",
      path: "src/notes.md",
      nextPath: "docs/notes.md"
    });
    assert.equal(renamed.path, "docs/notes.md");
    assert.equal(fs.existsSync(path.join(repo, "src", "notes.md")), false);
    assert.equal((await getWorkspaceFile(workspace.id, settings, "docs/notes.md")).text, "# Notes\nShip it.\n");

    const deleted = await mutateWorkspaceFile(workspace.id, settings, {
      action: "delete",
      path: "docs/notes.md"
    });
    assert.equal(deleted.ok, true);
    assert.equal(fs.existsSync(path.join(repo, "docs", "notes.md")), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("mutateWorkspaceFile rejects path escapes and overwrite renames", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-file-guard-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "a.md"), "a\n", "utf8");
  fs.writeFileSync(path.join(repo, "b.md"), "b\n", "utf8");
  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "files" });
  const settings = { allowedRoots: [tempRoot] };

  try {
    await assert.rejects(
      () => mutateWorkspaceFile(workspace.id, settings, { action: "write", path: "../escape.md", text: "no\n" }),
      /Path is outside workspace|Workspace file path is required/
    );
    await assert.rejects(
      () => mutateWorkspaceFile(workspace.id, settings, { action: "rename", path: "a.md", nextPath: "b.md" }),
      /already exists/
    );
    assert.equal(fs.readFileSync(path.join(repo, "a.md"), "utf8"), "a\n");
    assert.equal(fs.readFileSync(path.join(repo, "b.md"), "utf8"), "b\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
