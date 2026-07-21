#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const archive = argValue("--archive");
if (!archive) fail("Missing --archive.");
if (!fs.existsSync(archive)) fail(`Archive not found: ${archive}`);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-rust-only-smoke-"));
try {
  const extract = path.join(tempRoot, "extract");
  fs.mkdirSync(extract, { recursive: true });
  const expand = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${extract.replace(/'/g, "''")}' -Force`
  ], { encoding: "utf8" });
  if (expand.status !== 0) {
    fail(expand.stderr || expand.stdout || "Failed to expand rust-only archive.");
  }

  const forbidden = ["runtime/node.exe", "src/", "node_modules/", "package.json"];
  const entries = [];
  const walk = (dir, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.posix.join(prefix, entry.name);
      entries.push(rel.replace(/\\/g, "/"));
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(extract);

  const violations = forbidden.filter((needle) => entries.some((entry) => entry === needle || entry.startsWith(`${needle}/`)));
  if (violations.length) {
    fail(`Rust-only package still contains forbidden entries: ${violations.join(", ")}`);
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

