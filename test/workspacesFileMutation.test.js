import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { upsertWorkspace } from "../src/db.js";
import { getWorkspaceFile, mutateWorkspaceFile, mutateWorkspaceFilesBatch, previewWorkspaceFile } from "../src/workspaces.js";

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

test("workspace file revisions reject a stale second-device write", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-file-conflict-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "notes.md"), "base\n", "utf8");
  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "files" });
  const settings = { allowedRoots: [tempRoot] };

  try {
    const deviceA = await getWorkspaceFile(workspace.id, settings, "notes.md");
    const deviceB = await getWorkspaceFile(workspace.id, settings, "notes.md");

    assert.equal(typeof deviceA.revision, "string");
    assert.equal(deviceA.revision, deviceB.revision);
    assert.match(deviceA.etag, /^"vibelink:workspace-file:/);

    const written = await mutateWorkspaceFile(workspace.id, settings, {
      action: "write",
      path: "notes.md",
      text: "from device A\n",
      expectedRevision: deviceA.revision
    });
    assert.notEqual(written.revision, deviceA.revision);

    await assert.rejects(
      () => mutateWorkspaceFile(workspace.id, settings, {
        action: "write",
        path: "notes.md",
        text: "from device B\n",
        expectedRevision: deviceB.revision
      }),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, "WORKSPACE_FILE_CONFLICT");
        assert.equal(error.expectedRevision, deviceB.revision);
        assert.equal(error.actualRevision, written.revision);
        assert.equal(error.current.text, "from device A\n");
        return true;
      }
    );
    assert.equal(fs.readFileSync(path.join(repo, "notes.md"), "utf8"), "from device A\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("workspace create-only mutations do not overwrite a file created by another device", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-file-create-conflict-"));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "files" });
  const settings = { allowedRoots: [tempRoot] };

  try {
    await mutateWorkspaceFile(workspace.id, settings, {
      action: "write",
      path: "new.md",
      text: "from device A\n",
      requireAbsent: true
    });
    await assert.rejects(
      () => mutateWorkspaceFile(workspace.id, settings, {
        action: "write",
        path: "new.md",
        text: "from device B\n",
        requireAbsent: true
      }),
      (error) => error.status === 409 && error.code === "WORKSPACE_FILE_CONFLICT"
    );
    assert.equal(fs.readFileSync(path.join(repo, "new.md"), "utf8"), "from device A\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("large UTF-8 workspace files can be read losslessly with bounded byte cursors", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-file-page-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const content = "你abc\n".repeat(120_000);
  fs.writeFileSync(path.join(repo, "large.txt"), content, "utf8");
  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "large files" });
  const settings = { allowedRoots: [tempRoot] };

  let offset = 0;
  let reconstructed = "";
  do {
    const page = await getWorkspaceFile(workspace.id, settings, "large.txt", { offset, limit: 64 * 1024 });
    assert.equal(page.binary, false);
    assert.ok(page.bytesRead <= 64 * 1024);
    reconstructed += page.text;
    offset = page.nextOffset;
    if (page.eof) break;
  } while (true);

  assert.equal(reconstructed, content);
  assert.equal(offset, Buffer.byteLength(content));
});

test("workspace files expose the shared rich artifact preview", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-preview-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "report.pdf"), "%PDF-1.7\n1 0 obj<</Type /Page>>stream\nBT (Workspace PDF) Tj ET\nendstream\nendobj");
  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "preview" });

  const result = await previewWorkspaceFile(workspace.id, { allowedRoots: [tempRoot] }, "report.pdf");
  assert.equal(result.preview.kind, "pdf");
  assert.match(result.preview.document.text, /Workspace PDF/);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
});

test("atomic workspace batches report every conflict without applying valid siblings", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-batch-conflict-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "a.md"), "current a\n");
  fs.writeFileSync(path.join(repo, "b.md"), "current b\n");
  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "batch" });
  const settings = { allowedRoots: [tempRoot] };

  await assert.rejects(
    mutateWorkspaceFilesBatch(workspace.id, settings, {
      mode: "atomic",
      operations: [
        { action: "write", path: "a.md", text: "next a\n", expectedRevision: "stale-a" },
        { action: "write", path: "b.md", text: "next b\n", expectedRevision: "stale-b" },
        { action: "write", path: "c.md", text: "new c\n", requireAbsent: true }
      ]
    }),
    (error) => error.status === 409 && error.code === "WORKSPACE_BATCH_CONFLICT" && error.conflicts.length === 2
  );
  assert.equal(fs.readFileSync(path.join(repo, "a.md"), "utf8"), "current a\n");
  assert.equal(fs.readFileSync(path.join(repo, "b.md"), "utf8"), "current b\n");
  assert.equal(fs.existsSync(path.join(repo, "c.md")), false);
});

test("best-effort workspace batches return per-operation conflicts and successes", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-batch-best-effort-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "a.md"), "current\n");
  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "batch" });

  const result = await mutateWorkspaceFilesBatch(workspace.id, { allowedRoots: [tempRoot] }, {
    mode: "best-effort",
    operations: [
      { action: "write", path: "a.md", text: "stale\n", expectedRevision: "stale" },
      { action: "write", path: "b.md", text: "created\n", requireAbsent: true }
    ]
  });
  assert.equal(result.ok, false);
  assert.equal(result.items[0].code, "WORKSPACE_FILE_CONFLICT");
  assert.equal(result.items[1].ok, true);
  assert.equal(fs.readFileSync(path.join(repo, "b.md"), "utf8"), "created\n");
});

test("atomic workspace batches apply mixed write, rename, and delete operations", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-workspace-batch-atomic-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "rename.md"), "rename\n");
  fs.writeFileSync(path.join(repo, "delete.md"), "delete\n");
  const workspace = upsertWorkspace({ path: repo, allowedRoot: repo, title: "batch" });
  const settings = { allowedRoots: [tempRoot] };
  const renameRevision = (await getWorkspaceFile(workspace.id, settings, "rename.md")).revision;
  const deleteRevision = (await getWorkspaceFile(workspace.id, settings, "delete.md")).revision;

  const result = await mutateWorkspaceFilesBatch(workspace.id, settings, {
    mode: "atomic",
    operations: [
      { action: "write", path: "created.md", text: "created\n", requireAbsent: true },
      { action: "rename", path: "rename.md", nextPath: "renamed.md", expectedRevision: renameRevision },
      { action: "delete", path: "delete.md", expectedRevision: deleteRevision }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(repo, "created.md"), "utf8"), "created\n");
  assert.equal(fs.readFileSync(path.join(repo, "renamed.md"), "utf8"), "rename\n");
  assert.equal(fs.existsSync(path.join(repo, "delete.md")), false);
});
