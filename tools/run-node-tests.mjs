#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = path.resolve(import.meta.dirname, "..");
const testDir = path.join(rootDir, "test");
const files = fs.readdirSync(testDir)
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => path.join(testDir, file));

if (!files.length) {
  console.error("No Node test files were found.");
  process.exitCode = 1;
} else {
  for (const file of files) {
    console.log(`\n=== ${path.relative(rootDir, file)} ===`);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibelink-node-test-"));
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", file], {
      cwd: rootDir,
      stdio: "inherit",
      env: { ...process.env, VIBELINK_DATA_DIR: dataDir },
      windowsHide: true
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (result.error) {
      console.error(result.error.message);
      process.exitCode = 1;
      break;
    }
    if (result.status !== 0) {
      process.exitCode = result.status || 1;
      break;
    }
  }
}
