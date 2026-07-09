import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getWorkspaceContext, getWorkspaceRuntimeStats, getWorkspaceTree } from "../src/workspaces.js";
import { upsertWorkspace } from "../src/db.js";

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

function writeRustScannerStub(dir) {
  const scanner = path.join(dir, "rust-scanner-stub.mjs");
  fs.writeFileSync(
    scanner,
    `const dirIndex = process.argv.indexOf("--dir");\n` +
      `const dir = dirIndex >= 0 ? process.argv[dirIndex + 1] || "" : "";\n` +
      `const itemPath = dir ? dir + "/from-rust.txt" : "from-rust.txt";\n` +
      `process.stdout.write(JSON.stringify({ ok: true, dir, items: [{ name: "from-rust.txt", path: itemPath, type: "file", size: 9, updatedAt: "2026-01-01T00:00:00.000Z" }] }));\n`,
    "utf8"
  );
  return scanner;
}

function writeRustScannerBudgetStub(dir) {
  const scanner = path.join(dir, "rust-scanner-budget-stub.mjs");
  fs.writeFileSync(
    scanner,
    `process.stdout.write(JSON.stringify({ ok: true, dir: "", truncated: true, items: [{ name: "one.txt", path: "one.txt", type: "file", size: 1, updatedAt: "2026-01-01T00:00:00.000Z" }] }));\n`,
    "utf8"
  );
  return scanner;
}

function cargoPath() {
  if (process.platform === "win32") {
    const result = spawnSync("where.exe", ["cargo"], { encoding: "utf8", windowsHide: true });
    return result.status === 0 ? String(result.stdout || "").split(/\r?\n/).find(Boolean) || "" : "";
  }
  const result = spawnSync("sh", ["-lc", "command -v cargo"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout || "").trim().split(/\r?\n/)[0] || "" : "";
}

test("getWorkspaceTree uses Rust scanner when explicitly enabled", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "main.rs"), "fn main() {}", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  const scanner = writeRustScannerStub(fixture);
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_BIN = process.execPath;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([scanner]);

  try {
    const before = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const result = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const after = getWorkspaceRuntimeStats().rustWorkspaceTree;

    assert.equal(result.ok, true);
    assert.deepEqual(result.items.map((item) => item.name), ["from-rust.txt"]);
    assert.equal(after.hits, before.hits + 1);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceTree falls back to Node scanner when Rust scanner fails", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-fallback-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "target"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "tmp-cache"), { recursive: true });
  fs.writeFileSync(path.join(fixture, ".gitignore"), "tmp-cache/\n", "utf8");
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");
  fs.writeFileSync(path.join(fixture, "target", "noise.txt"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "tmp-cache", "noise.txt"), "ignored", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-fallback" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_BIN = path.join(fixture, "missing-scanner.exe");

  try {
    const result = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    assert.equal(result.ok, true);
    assert.deepEqual(result.items.map((item) => item.name), ["src", "README.md"]);
    assert.equal(result.items.some((item) => item.path.startsWith("tmp-cache")), false);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceTree tracks Rust scanner budget hits", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-budget-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-budget" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  const scanner = writeRustScannerBudgetStub(fixture);
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_BIN = process.execPath;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([scanner]);

  try {
    const before = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const result = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const after = getWorkspaceRuntimeStats().rustWorkspaceTree;

    assert.equal(result.ok, true);
    assert.deepEqual(result.items.map((item) => item.name), ["one.txt"]);
    assert.equal(after.budgetHits, before.budgetHits + 1);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceContext uses Rust scanner for directory samples when enabled", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-context-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "src", "local.txt"), "node fallback", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-context" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  const scanner = writeRustScannerStub(fixture);
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_BIN = process.execPath;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([scanner]);

  try {
    const result = await getWorkspaceContext(workspace.id, { allowedRoots: [fixture] }, { paths: ["src"] });
    assert.equal(result.ok, true);
    assert.match(result.prompt, /file src\/from-rust\.txt/);
    assert.doesNotMatch(result.prompt, /file src\/local\.txt/);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceContext applies nested gitignore rules through real Rust scanner", async (t) => {
  const cargo = cargoPath();
  if (!cargo) t.skip("cargo is not available");

  const fixture = path.join(os.tmpdir(), `vibelink-rust-context-real-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "src", "private"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "src", ".gitignore"), "generated.tmp\n*.log\n!keep.log\nprivate/\n", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "README.md"), "hello", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "generated.tmp"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "debug.log"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "keep.log"), "kept", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "private", "note.txt"), "ignored", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-context-real" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_BIN = cargo;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([
    "run",
    "--quiet",
    "--manifest-path",
    path.join(process.cwd(), "apps", "windows", "Cargo.toml"),
    "--"
  ]);

  try {
    const result = await getWorkspaceContext(workspace.id, { allowedRoots: [fixture] }, { paths: ["src"] });
    assert.equal(result.ok, true);
    assert.match(result.prompt, /file src\/README\.md/);
    assert.match(result.prompt, /file src\/keep\.log/);
    assert.doesNotMatch(result.prompt, /generated\.tmp/);
    assert.doesNotMatch(result.prompt, /debug\.log/);
    assert.doesNotMatch(result.prompt, /private\/note\.txt/);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceContext refreshes Node scanner cache when nested directory changes", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-tree-cache-nested-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "src", "nested"), { recursive: true });

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "tree-cache-nested" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  delete process.env.VIBELINK_RUST_WORKSPACE_TREE;

  try {
    const first = await getWorkspaceContext(workspace.id, { allowedRoots: [fixture] }, { paths: ["src"] });
    fs.writeFileSync(path.join(fixture, "src", "nested", "added.txt"), "fresh", "utf8");
    const second = await getWorkspaceContext(workspace.id, { allowedRoots: [fixture] }, { paths: ["src"] });

    assert.equal(first.ok, true);
    assert.doesNotMatch(first.prompt, /file src\/nested\/added\.txt/);
    assert.match(second.prompt, /file src\/nested\/added\.txt/);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceTree tracks Node scanner budget hits", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-tree-budget-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  for (let i = 0; i < 260; i += 1) {
    fs.writeFileSync(path.join(fixture, `file-${String(i).padStart(3, "0")}.txt`), "x", "utf8");
  }

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "tree-budget" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  delete process.env.VIBELINK_RUST_WORKSPACE_TREE;

  try {
    const before = getWorkspaceRuntimeStats().workspaceTree;
    const result = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const after = getWorkspaceRuntimeStats().workspaceTree;

    assert.equal(result.ok, true);
    assert.equal(result.items.length, 240);
    assert.equal(after.budgetHits, before.budgetHits + 1);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceTree reuses unchanged Node scanner results", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-tree-cache-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "tree-cache" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  delete process.env.VIBELINK_RUST_WORKSPACE_TREE;

  try {
    const before = getWorkspaceRuntimeStats().workspaceTree;
    const first = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const second = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const after = getWorkspaceRuntimeStats().workspaceTree;

    assert.equal(first.ok, true);
    assert.deepEqual(second.items, first.items);
    assert.equal(after.cacheHits, before.cacheHits + 1);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceContext caches unchanged file samples and refreshes on change", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-context-file-cache-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "context-file-cache" });

  try {
    const before = getWorkspaceRuntimeStats().workspaceContextFiles;
    const first = await getWorkspaceContext(workspace.id, { allowedRoots: [fixture] }, { paths: ["README.md"] });
    const second = await getWorkspaceContext(workspace.id, { allowedRoots: [fixture] }, { paths: ["README.md"] });
    fs.writeFileSync(path.join(fixture, "README.md"), "fresh", "utf8");
    const third = await getWorkspaceContext(workspace.id, { allowedRoots: [fixture] }, { paths: ["README.md"] });
    const after = getWorkspaceRuntimeStats().workspaceContextFiles;

    assert.equal(first.ok, true);
    assert.match(second.prompt, /hello/);
    assert.match(third.prompt, /fresh/);
    assert.equal(after.cacheHits, before.cacheHits + 1);
    assert.equal(after.cacheMisses >= before.cacheMisses + 2, true);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("workspace context file cache honors runtime max entries", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-context-file-cache-cap-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(path.join(fixture, `file-${i}.md`), `hello-${i}`, "utf8");
  }

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "context-file-cache-cap" });
  const previousMaxEntries = process.env.VIBELINK_WORKSPACE_CONTEXT_FILE_CACHE_MAX_ENTRIES;
  process.env.VIBELINK_WORKSPACE_CONTEXT_FILE_CACHE_MAX_ENTRIES = "3";

  try {
    const before = getWorkspaceRuntimeStats().workspaceContextFiles;
    for (let i = 0; i < 6; i += 1) {
      await getWorkspaceContext(workspace.id, { allowedRoots: [fixture] }, { paths: [`file-${i}.md`] });
    }
    const after = getWorkspaceRuntimeStats().workspaceContextFiles;

    assert.equal(after.maxEntries, 3);
    assert.equal(after.entries <= 3, true);
    assert.equal(after.cacheEvictions > before.cacheEvictions, true);
  } finally {
    restoreEnv("VIBELINK_WORKSPACE_CONTEXT_FILE_CACHE_MAX_ENTRIES", previousMaxEntries);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceTree caps Node scanner cache entries", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-tree-cache-cap-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    const dir = path.join(fixture, `dir-${String(i).padStart(3, "0")}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "hello", "utf8");
  }

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "tree-cache-cap" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousMaxEntries = process.env.VIBELINK_WORKSPACE_TREE_CACHE_MAX_ENTRIES;
  delete process.env.VIBELINK_RUST_WORKSPACE_TREE;
  process.env.VIBELINK_WORKSPACE_TREE_CACHE_MAX_ENTRIES = "8";

  try {
    for (let i = 0; i < 12; i += 1) {
      await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, `dir-${String(i).padStart(3, "0")}`);
    }
    const stats = getWorkspaceRuntimeStats().workspaceTree;

    assert.equal(stats.maxEntries, 8);
    assert.equal(stats.entries <= 8, true);
    assert.equal(stats.cacheEvictions > 0, true);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_WORKSPACE_TREE_CACHE_MAX_ENTRIES", previousMaxEntries);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
