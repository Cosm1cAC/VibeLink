import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  closeRustWorkspaceTreeSidecar,
  getWorkspaceContext,
  getWorkspaceRuntimeStats,
  getWorkspaceTree
} from "../src/workspaces.js";
import { cargoPath } from "./rustTestSupport.js";
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

function writeRustScannerSignatureStub(dir) {
  const scanner = path.join(dir, "rust-scanner-signature-stub.mjs");
  fs.writeFileSync(
    scanner,
    `process.stdout.write(JSON.stringify({ ok: true, dir: "", signature: "sig-from-rust", items: [{ name: "one.txt", path: "one.txt", type: "file", size: 1, updatedAt: "2026-01-01T00:00:00.000Z" }] }));\n`,
    "utf8"
  );
  return scanner;
}

function writeRustScannerCacheStub(dir) {
  const scanner = path.join(dir, "rust-scanner-cache-stub.mjs");
  const log = path.join(dir, "rust-scanner-cache-calls.log");
  fs.writeFileSync(
    scanner,
    `import fs from "node:fs";\n` +
      `fs.appendFileSync(${JSON.stringify(log)}, "scan\\n", "utf8");\n` +
      `process.stdout.write(JSON.stringify({ ok: true, dir: "", signature: "stable-signature", items: [{ name: "cached.txt", path: "cached.txt", type: "file", size: 1, updatedAt: "2026-01-01T00:00:00.000Z" }] }));\n`,
    "utf8"
  );
  return { scanner, log };
}

function writeRustScannerInvalidJsonStub(dir) {
  const scanner = path.join(dir, "rust-scanner-invalid-json-stub.mjs");
  fs.writeFileSync(scanner, `process.stdout.write("not-json");\n`, "utf8");
  return scanner;
}

function writeRustScannerInvalidItemsStub(dir) {
  const scanner = path.join(dir, "rust-scanner-invalid-items-stub.mjs");
  fs.writeFileSync(
    scanner,
    `process.stdout.write(JSON.stringify({ items: [{ name: "escape.txt", path: "../escape.txt", type: "file", size: 1, updatedAt: "2026-01-01T00:00:00.000Z" }] }));\n`,
    "utf8"
  );
  return scanner;
}

test("getWorkspaceContext preserves Node and Rust scanner parity for supported ignore rules", async (t) => {
  const cargo = cargoPath();
  if (!cargo) t.skip("cargo is not available");

  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-parity-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "docs"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "src", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "src", "generated"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "src", "private"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "src", "target"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "src", "tmp-cache"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "src", ".gitignore"),
    "generated.tmp\n*.log\n!keep.log\nprivate/\ntmp-cache/\ngenerated/*.tmp\n!generated/keep.tmp\n",
    "utf8"
  );
  fs.writeFileSync(path.join(fixture, "src", ".env"), "VISIBLE=1", "utf8");
  fs.writeFileSync(path.join(fixture, "src", ".hidden"), "hidden", "utf8");
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");
  fs.writeFileSync(path.join(fixture, "docs", "guide.md"), "guide", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "node_modules", "noise.js"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "target", "noise.txt"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "tmp-cache", "noise.txt"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "app.rs"), "fn main() {}", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "generated.tmp"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "debug.log"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "keep.log"), "kept", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "private", "note.txt"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "generated", "noise.tmp"), "ignored", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "generated", "keep.tmp"), "kept", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "generated", "note.txt"), "kept", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-parity" });
  const settings = { allowedRoots: [fixture] };
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;

  try {
    delete process.env.VIBELINK_RUST_WORKSPACE_TREE;
    const nodeResult = await getWorkspaceContext(workspace.id, settings, { paths: ["src"] });

    process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
    process.env.VIBELINK_RUST_BIN = cargo;
    process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([
      "run",
      "--quiet",
      "--manifest-path",
      path.join(process.cwd(), "apps", "windows", "Cargo.toml"),
      "--"
    ]);
    const rustResult = await getWorkspaceContext(workspace.id, settings, { paths: ["src"] });

    assert.equal(rustResult.prompt, nodeResult.prompt);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceTree preserves Windows Node metadata parity", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows filesystem metadata semantics only");
    return;
  }
  const cargo = cargoPath();
  if (!cargo) {
    t.skip("cargo is not available");
    return;
  }

  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-metadata-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "nested"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "sample.txt"), "metadata parity", "utf8");
  fs.writeFileSync(path.join(fixture, "main.py"), "main", "utf8");
  fs.writeFileSync(path.join(fixture, "main_debug.py"), "debug", "utf8");
  fs.writeFileSync(path.join(fixture, "README.md"), "readme", "utf8");
  fs.writeFileSync(path.join(fixture, "README_en.md"), "readme en", "utf8");
  fs.writeFileSync(path.join(fixture, "nested", "README.md"), "nested readme", "utf8");
  fs.writeFileSync(path.join(fixture, "nested", "README_en.md"), "nested readme en", "utf8");
  const timestampSeconds = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000 + 0.1236;
  fs.utimesSync(path.join(fixture, "sample.txt"), timestampSeconds, timestampSeconds);
  fs.utimesSync(path.join(fixture, "nested"), timestampSeconds, timestampSeconds);

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-metadata" });
  const settings = { allowedRoots: [fixture] };
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;

  try {
    delete process.env.VIBELINK_RUST_WORKSPACE_TREE;
    const nodeResult = await getWorkspaceTree(workspace.id, settings);

    process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
    process.env.VIBELINK_RUST_BIN = cargo;
    process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([
      "run",
      "--quiet",
      "--manifest-path",
      path.join(process.cwd(), "apps", "windows", "Cargo.toml"),
      "--"
    ]);
    const rustResult = await getWorkspaceTree(workspace.id, settings);

    assert.deepEqual(rustResult.items, nodeResult.items);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("workspace routes reuse one persistent Rust scanner sidecar", async (t) => {
  const cargo = cargoPath();
  if (!cargo) {
    t.skip("cargo is not available");
    return;
  }
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-session-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "docs"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "readme", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "index.js"), "export {};", "utf8");
  fs.writeFileSync(path.join(fixture, "docs", "guide.md"), "guide", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-session" });
  const settings = { allowedRoots: [fixture] };
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousSession = process.env.VIBELINK_RUST_WORKSPACE_TREE_SESSION;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_WORKSPACE_TREE_SESSION = "1";
  process.env.VIBELINK_RUST_BIN = cargo;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([
    "run", "--quiet", "--manifest-path", path.join(process.cwd(), "apps", "windows", "Cargo.toml"), "--"
  ]);

  try {
    const before = getWorkspaceRuntimeStats().rustWorkspaceTree;
    await getWorkspaceTree(workspace.id, settings);
    await getWorkspaceContext(workspace.id, settings, { paths: ["src", "docs"] });
    const after = getWorkspaceRuntimeStats().rustWorkspaceTree;

    assert.equal(after.session.enabled, true);
    assert.equal(after.session.active, true);
    assert.equal(after.session.ready, true);
    assert.equal(after.session.starts, before.session.starts + 1);
    assert.equal(after.session.failures, before.session.failures);
    assert.equal(after.session.fallbacks, before.session.fallbacks);
    assert.equal(after.hits, before.hits + 3);
    assert.equal(after.session.client.pending, 0);
    assert.equal(after.session.client.requests >= 4, true);

    const drain = await closeRustWorkspaceTreeSidecar();
    assert.equal(drain.closed, true);
    const closed = getWorkspaceRuntimeStats().rustWorkspaceTree.session;
    assert.equal(closed.active, false);
    assert.equal(closed.client.terminated, true);
  } finally {
    await closeRustWorkspaceTreeSidecar();
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE_SESSION", previousSession);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceContext Rust scanner inherits gitignore rules from intermediate directories", async (t) => {
  const cargo = cargoPath();
  if (!cargo) t.skip("cargo is not available");

  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-parent-ignore-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "src", ".gitignore"), "secret.txt\n", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "nested", "keep.txt"), "kept", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "nested", "secret.txt"), "ignored", "utf8");

  const workspace = upsertWorkspace({
    path: fixture,
    allowedRoot: fixture,
    title: "rust-tree-parent-ignore"
  });
  const settings = { allowedRoots: [fixture] };
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;

  try {
    delete process.env.VIBELINK_RUST_WORKSPACE_TREE;
    const nodeResult = await getWorkspaceContext(workspace.id, settings, { paths: ["src/nested"] });

    process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
    process.env.VIBELINK_RUST_BIN = cargo;
    process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([
      "run",
      "--quiet",
      "--manifest-path",
      path.join(process.cwd(), "apps", "windows", "Cargo.toml"),
      "--"
    ]);
    const rustResult = await getWorkspaceContext(workspace.id, settings, { paths: ["src/nested"] });

    assert.equal(rustResult.prompt, nodeResult.prompt);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceContext refreshes Rust cache when nested gitignore content changes", async (t) => {
  const cargo = cargoPath();
  if (!cargo) t.skip("cargo is not available");

  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-gitignore-refresh-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "src", ".gitignore"), "secret.txt\n", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "keep.txt"), "kept", "utf8");
  fs.writeFileSync(path.join(fixture, "src", "secret.txt"), "initially ignored", "utf8");

  const workspace = upsertWorkspace({
    path: fixture,
    allowedRoot: fixture,
    title: "rust-tree-gitignore-refresh"
  });
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
    const before = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const first = await getWorkspaceContext(workspace.id, { allowedRoots: [fixture] }, { paths: ["src"] });
    fs.writeFileSync(path.join(fixture, "src", ".gitignore"), "public.txt\n", "utf8");
    const second = await getWorkspaceContext(workspace.id, { allowedRoots: [fixture] }, { paths: ["src"] });
    const after = getWorkspaceRuntimeStats().rustWorkspaceTree;

    assert.doesNotMatch(first.prompt, /secret\.txt/);
    assert.match(second.prompt, /secret\.txt/);
    assert.equal(after.cacheMisses >= before.cacheMisses + 2, true);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

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

test("getWorkspaceTree auto mode uses Rust scanner when command exists", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-auto-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "node fallback", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-auto" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  const scanner = writeRustScannerStub(fixture);
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "auto";
  process.env.VIBELINK_RUST_BIN = process.execPath;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([scanner]);

  try {
    const before = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const result = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const after = getWorkspaceRuntimeStats().rustWorkspaceTree;

    assert.equal(result.ok, true);
    assert.deepEqual(result.items.map((item) => item.name), ["from-rust.txt"]);
    assert.equal(after.mode, "auto");
    assert.equal(after.auto, true);
    assert.equal(after.available, true);
    assert.equal(after.hits, before.hits + 1);
    assert.equal(after.lastError, "");
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceTree auto mode skips missing Rust scanner without marking failure", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-auto-missing-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-auto-missing" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "auto";
  process.env.VIBELINK_RUST_BIN = path.join(fixture, "missing-scanner.exe");
  delete process.env.VIBELINK_RUST_BIN_ARGS_JSON;

  try {
    const before = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const result = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const after = getWorkspaceRuntimeStats().rustWorkspaceTree;

    assert.equal(result.ok, true);
    assert.deepEqual(result.items.map((item) => item.name), ["src", "README.md"]);
    assert.equal(after.mode, "auto");
    assert.equal(after.auto, true);
    assert.equal(after.available, false);
    assert.equal(after.misses, before.misses + 1);
    assert.equal(after.fallbacks, before.fallbacks);
    assert.equal(after.failures, before.failures);
    assert.equal(after.lastError, "");
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
    const before = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const result = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const after = getWorkspaceRuntimeStats().rustWorkspaceTree;
    assert.equal(result.ok, true);
    assert.deepEqual(result.items.map((item) => item.name), ["src", "README.md"]);
    assert.equal(result.items.some((item) => item.path.startsWith("tmp-cache")), false);
    assert.equal(after.mode, "manual");
    assert.equal(after.available, false);
    assert.equal(after.fallbacks, before.fallbacks + 1);
    assert.equal(after.failures, before.failures + 1);
    assert.match(after.lastError, /not found/i);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceTree records Rust scanner output failures", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-invalid-json-${process.pid}`);
  const helperDir = path.join(os.tmpdir(), `vibelink-rust-tree-invalid-json-helper-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(helperDir, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(helperDir, { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-invalid-json" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  const scanner = writeRustScannerInvalidJsonStub(helperDir);
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_BIN = process.execPath;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([scanner]);

  try {
    const before = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const result = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const after = getWorkspaceRuntimeStats().rustWorkspaceTree;

    assert.equal(result.ok, true);
    assert.deepEqual(result.items.map((item) => item.name), ["README.md"]);
    assert.equal(after.fallbacks, before.fallbacks + 1);
    assert.equal(after.failures, before.failures + 1);
    assert.match(after.lastError, /workspace-tree failed/i);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(helperDir, { recursive: true, force: true });
  }
});

test("workspace routes fall back from a failed session to the one-shot Rust scanner", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-session-fallback-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-session-fallback" });
  const scanner = writeRustScannerStub(fixture);
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousSession = process.env.VIBELINK_RUST_WORKSPACE_TREE_SESSION;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_WORKSPACE_TREE_SESSION = "1";
  process.env.VIBELINK_RUST_BIN = process.execPath;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([scanner]);

  try {
    const before = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const result = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const after = getWorkspaceRuntimeStats().rustWorkspaceTree;

    assert.deepEqual(result.items.map((item) => item.name), ["from-rust.txt"]);
    assert.equal(after.session.starts, before.session.starts + 1);
    assert.equal(after.session.failures, before.session.failures + 1);
    assert.equal(after.session.fallbacks, before.session.fallbacks + 1);
    assert.equal(after.session.active, false);
    assert.equal(after.hits, before.hits + 1);
    assert.equal(after.fallbacks, before.fallbacks);
  } finally {
    await closeRustWorkspaceTreeSidecar();
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE_SESSION", previousSession);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceTree rejects Rust items outside the requested traversal", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-invalid-items-${process.pid}`);
  const helperDir = path.join(os.tmpdir(), `vibelink-rust-tree-invalid-items-helper-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(helperDir, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(helperDir, { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-invalid-items" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  const scanner = writeRustScannerInvalidItemsStub(helperDir);
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_BIN = process.execPath;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([scanner]);

  try {
    const before = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const result = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const after = getWorkspaceRuntimeStats().rustWorkspaceTree;

    assert.deepEqual(result.items.map((item) => item.name), ["README.md"]);
    assert.equal(after.fallbacks, before.fallbacks + 1);
    assert.equal(after.failures, before.failures + 1);
    assert.match(after.lastError, /outside the requested traversal/i);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(helperDir, { recursive: true, force: true });
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
    assert.deepEqual(result.items.map((item) => item.name), ["README.md", "rust-scanner-budget-stub.mjs"]);
    assert.equal(after.budgetHits, before.budgetHits + 1);
    assert.equal(after.fallbacks, before.fallbacks + 1);
    assert.equal(after.failures, before.failures);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceTree records Rust scanner metadata signature", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-signature-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-signature" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  const scanner = writeRustScannerSignatureStub(fixture);
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_BIN = process.execPath;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([scanner]);

  try {
    const result = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const stats = getWorkspaceRuntimeStats().rustWorkspaceTree;

    assert.equal(result.ok, true);
    assert.equal(stats.lastSignature, "sig-from-rust");
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("getWorkspaceTree reuses unchanged Rust scanner results by signature", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-cache-${process.pid}`);
  const helperDir = path.join(os.tmpdir(), `vibelink-rust-tree-cache-helper-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(helperDir, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(helperDir, { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-cache" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  const { scanner, log } = writeRustScannerCacheStub(helperDir);
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_BIN = process.execPath;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([scanner]);

  try {
    const before = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const first = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const second = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const after = getWorkspaceRuntimeStats().rustWorkspaceTree;
    const calls = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.equal(first.ok, true);
    assert.deepEqual(second.items, first.items);
    assert.equal(calls.length, 1);
    assert.equal(after.cacheHits, before.cacheHits + 1);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(helperDir, { recursive: true, force: true });
  }
});

test("getWorkspaceTree refreshes Rust scanner cache when metadata changes", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-rust-tree-cache-refresh-${process.pid}`);
  const helperDir = path.join(os.tmpdir(), `vibelink-rust-tree-cache-refresh-helper-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(helperDir, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(helperDir, { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "rust-tree-cache-refresh" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  const previousBin = process.env.VIBELINK_RUST_BIN;
  const previousArgs = process.env.VIBELINK_RUST_BIN_ARGS_JSON;
  const { scanner, log } = writeRustScannerCacheStub(helperDir);
  process.env.VIBELINK_RUST_WORKSPACE_TREE = "1";
  process.env.VIBELINK_RUST_BIN = process.execPath;
  process.env.VIBELINK_RUST_BIN_ARGS_JSON = JSON.stringify([scanner]);

  try {
    await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    fs.writeFileSync(path.join(fixture, "README.md"), "hello with more bytes", "utf8");
    await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const calls = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean);

    assert.equal(calls.length, 2);
  } finally {
    restoreEnv("VIBELINK_RUST_WORKSPACE_TREE", previousFlag);
    restoreEnv("VIBELINK_RUST_BIN", previousBin);
    restoreEnv("VIBELINK_RUST_BIN_ARGS_JSON", previousArgs);
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(helperDir, { recursive: true, force: true });
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

test("getWorkspaceTree refreshes Node scanner cache when file metadata changes", async () => {
  const fixture = path.join(os.tmpdir(), `vibelink-tree-cache-file-refresh-${process.pid}`);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, "README.md"), "hello", "utf8");

  const workspace = upsertWorkspace({ path: fixture, allowedRoot: fixture, title: "tree-cache-file-refresh" });
  const previousFlag = process.env.VIBELINK_RUST_WORKSPACE_TREE;
  delete process.env.VIBELINK_RUST_WORKSPACE_TREE;

  try {
    const first = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    fs.writeFileSync(path.join(fixture, "README.md"), "hello with more bytes", "utf8");
    const second = await getWorkspaceTree(workspace.id, { allowedRoots: [fixture] }, "");
    const firstReadme = first.items.find((item) => item.path === "README.md");
    const secondReadme = second.items.find((item) => item.path === "README.md");

    assert.equal(first.ok, true);
    assert.equal(firstReadme.size, 5);
    assert.equal(secondReadme.size, 21);
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
