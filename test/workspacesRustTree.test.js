import assert from "node:assert/strict";
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
