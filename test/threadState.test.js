import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function tempDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), "vibelink-thread-state-"));
}

function runThreadStateScript(dataDir, script) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, VIBELINK_DATA_DIR: dataDir },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

test("thread state persists favorite and tags across restart", () => {
  const dataDir = tempDataDir();
  try {
    runThreadStateScript(dataDir, `
      const { updateThreadState } = await import("./src/threadState.js");
      updateThreadState("history:codex:persist", { favorite: true, tags: ["work", "urgent"] });
      console.log(JSON.stringify({ ok: true }));
    `);

    const state = runThreadStateScript(dataDir, `
      const { getThreadState } = await import("./src/threadState.js");
      console.log(JSON.stringify(getThreadState().items["history:codex:persist"]));
    `);

    assert.equal(state.favorite, true);
    assert.deepEqual(state.tags, ["work", "urgent"]);
    assert.equal(typeof state.revision, "number");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("thread state patches preserve omitted fields and normalize tag operations", () => {
  const dataDir = tempDataDir();
  try {
    const state = runThreadStateScript(dataDir, `
      const { getThreadState, updateThreadState } = await import("./src/threadState.js");
      updateThreadState("history:codex:merge", { tags: ["work"] });
      const first = getThreadState().items["history:codex:merge"];
      updateThreadState("history:codex:merge", { favorite: true }, { expectedRevision: first.revision });
      const second = getThreadState().items["history:codex:merge"];
      updateThreadState("history:codex:merge", { addTags: ["urgent", "work", ""] }, { expectedRevision: second.revision });
      const third = getThreadState().items["history:codex:merge"];
      updateThreadState("history:codex:merge", { removeTags: ["work"] }, { expectedRevision: third.revision });
      console.log(JSON.stringify(getThreadState().items["history:codex:merge"]));
    `);

    assert.equal(state.favorite, true);
    assert.deepEqual(state.tags, ["urgent"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("thread state rejects ambiguous tag replace and tag operations", () => {
  const dataDir = tempDataDir();
  try {
    const result = runThreadStateScript(dataDir, `
      const { updateThreadState } = await import("./src/threadState.js");
      try {
        updateThreadState("history:codex:ambiguous", { tags: ["replace"], addTags: ["merge"] });
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, status: error.status, message: error.message }));
      }
    `);

    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.message, /tags/i);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("thread state detects same-field stale conflicts and allows disjoint merges", () => {
  const dataDir = tempDataDir();
  try {
    const result = runThreadStateScript(dataDir, `
      const { getThreadState, updateThreadState } = await import("./src/threadState.js");
      updateThreadState("history:codex:conflict", { favorite: false, tags: ["initial"] });
      const base = getThreadState().items["history:codex:conflict"];
      updateThreadState("history:codex:conflict", { favorite: true }, { expectedRevision: base.revision });
      let conflict = null;
      try {
        updateThreadState("history:codex:conflict", { favorite: false }, { expectedRevision: base.revision });
      } catch (error) {
        conflict = {
          status: error.status,
          code: error.code,
          fields: error.conflicts?.[0]?.conflictingFields || []
        };
      }
      updateThreadState("history:codex:conflict", { addTags: ["work"] }, { expectedRevision: base.revision });
      console.log(JSON.stringify({ conflict, item: getThreadState().items["history:codex:conflict"] }));
    `);

    assert.equal(result.conflict.status, 409);
    assert.equal(result.conflict.code, "THREAD_STATE_CONFLICT");
    assert.deepEqual(result.conflict.fields, ["favorite"]);
    assert.equal(result.item.favorite, true);
    assert.deepEqual(result.item.tags, ["initial", "work"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("thread state batch updates are atomic on conflict", () => {
  const dataDir = tempDataDir();
  try {
    const result = runThreadStateScript(dataDir, `
      const { getThreadState, updateThreadState, updateThreadStateBatch } = await import("./src/threadState.js");
      updateThreadState("history:codex:a", { favorite: false });
      updateThreadState("history:codex:b", { favorite: false });
      const baseA = getThreadState().items["history:codex:a"];
      const baseB = getThreadState().items["history:codex:b"];
      updateThreadState("history:codex:b", { favorite: true }, { expectedRevision: baseB.revision });
      let conflict = null;
      try {
        updateThreadStateBatch([
          { key: "history:codex:a", expectedRevision: baseA.revision, patch: { favorite: true } },
          { key: "history:codex:b", expectedRevision: baseB.revision, patch: { favorite: false } }
        ]);
      } catch (error) {
        conflict = { status: error.status, code: error.code };
      }
      const items = getThreadState().items;
      console.log(JSON.stringify({ conflict, a: items["history:codex:a"], b: items["history:codex:b"] }));
    `);

    assert.equal(result.conflict.status, 409);
    assert.equal(result.conflict.code, "THREAD_STATE_CONFLICT");
    assert.equal(result.a.favorite, false);
    assert.equal(result.b.favorite, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
