#!/usr/bin/env node
/**
 * Setup whisper.cpp locally.
 *
 * Steps:
 *   1. Clone whisper.cpp at the pinned upstream ref if not present (shallow)
 *   2. cmake build with MSVC or MinGW
 *   3. Copy binaries to tools/whisper-cpp/bin/
 *
 * Usage:
 *   node tools/whisper-cpp/setup.mjs
 *   # or
 *   npm run whisper:setup
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname);
const SOURCE_DIR = path.join(TOOLS_DIR, "source");
const BUILD_DIR = path.join(TOOLS_DIR, "build");
const BIN_DIR = path.join(TOOLS_DIR, "bin");
const MODELS_DIR = path.join(TOOLS_DIR, "models");
const CMAKE_BIN = "cmake";
const DEFAULT_WHISPER_CPP_REPO = "https://github.com/ggerganov/whisper.cpp.git";
const DEFAULT_WHISPER_CPP_REF = "v1.9.1";
const WHISPER_CPP_REPO = process.env.VIBELINK_WHISPER_CPP_REPO || DEFAULT_WHISPER_CPP_REPO;
const WHISPER_CPP_REF = process.env.VIBELINK_WHISPER_CPP_REF || DEFAULT_WHISPER_CPP_REF;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts, shell: true });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function which(bin) {
  try {
    execSync(`where ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isDirectoryEmpty(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

function gitOutput(args, opts = {}) {
  return execSync(["git", ...args].join(" "), {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function ensureWhisperSource() {
  const sourceExists = fs.existsSync(SOURCE_DIR);
  const sourceIsEmpty = sourceExists && isDirectoryEmpty(SOURCE_DIR);

  if (!sourceExists || sourceIsEmpty) {
    console.log(`Cloning whisper.cpp ${WHISPER_CPP_REF}...`);
    await run("git", [
      "clone",
      "--depth", "1",
      "--no-checkout",
      WHISPER_CPP_REPO,
      SOURCE_DIR
    ]);
    await checkoutPinnedRef();
    console.log("Clone complete.\n");
    return;
  }

  if (!fs.existsSync(path.join(SOURCE_DIR, ".git"))) {
    throw new Error(
      `Source directory exists but is not a Git checkout: ${SOURCE_DIR}\n` +
      "Remove or move it, then rerun setup so the pinned upstream ref can be cloned."
    );
  }

  const dirty = gitOutput(["status", "--porcelain"], { cwd: SOURCE_DIR });
  if (dirty) {
    throw new Error(
      `Source checkout has local changes: ${SOURCE_DIR}\n` +
      "Commit, stash, or remove them before rerunning setup."
    );
  }

  console.log(`Updating whisper.cpp source to ${WHISPER_CPP_REF}...`);
  await checkoutPinnedRef();
}

async function checkoutPinnedRef() {
  await run("git", ["fetch", "--depth", "1", "origin", WHISPER_CPP_REF], { cwd: SOURCE_DIR });
  await run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: SOURCE_DIR });
  const commit = gitOutput(["rev-parse", "--short", "HEAD"], { cwd: SOURCE_DIR });
  console.log(`Source ready at ${WHISPER_CPP_REF} (${commit}).\n`);
}

async function main() {
  console.log("=== Whisper.cpp Setup ===\n");
  console.log(`Upstream: ${WHISPER_CPP_REPO}`);
  console.log(`Pinned ref: ${WHISPER_CPP_REF}\n`);

  // Step 0: Check prerequisites
  if (!which("cmake")) {
    console.error("ERROR: cmake not found. Install it first:\n  choco install cmake\n  (or download from https://cmake.org/download/)");
    process.exit(1);
  }

  // Check MSVC (cl.exe) or MinGW
  const hasMsvc = which("cl.exe");
  const hasGcc = which("gcc");
  if (!hasMsvc && !hasGcc) {
    console.error("ERROR: No C++ compiler found. Install Visual Studio Build Tools:\n  Download from: https://visualstudio.microsoft.com/visual-cpp-build-tools/\n  Run installer, select 'Desktop development with C++' workload");
    process.exit(1);
  }

  // Step 1: Clone or update whisper.cpp at the pinned upstream ref.
  await ensureWhisperSource();

  // Step 2: Create output directories
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  // Step 3: CMake configure
  console.log("Running cmake configure...");
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const generatorFlag = hasMsvc ? [] : ["-G", "MinGW Makefiles"];
  await run(CMAKE_BIN, ["-S", SOURCE_DIR, "-B", BUILD_DIR, ...generatorFlag]);
  console.log("Configure complete.\n");

  // Step 4: Build
  console.log("Building whisper.cpp (this may take 5-15 minutes)...");
  await run(CMAKE_BIN, ["--build", BUILD_DIR, "--config", "Release", "--parallel"]);
  console.log("Build complete.\n");

  // Step 5: Copy binaries
  console.log("Copying binaries...");
  const buildReleaseDir = path.join(BUILD_DIR, "bin", "Release");
  const buildBinDir = path.join(BUILD_DIR, "bin");
  const candidates = [buildReleaseDir, buildBinDir, BUILD_DIR];

  let copied = 0;
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".exe") || file.endsWith(".dll")) {
        const src = path.join(dir, file);
        const dst = path.join(BIN_DIR, file);
        try { fs.copyFileSync(src, dst); } catch {}
      }
    }
  }

  // Also copy ggml model files if they're in the build dir
  for (const dir of [buildReleaseDir, buildBinDir, BUILD_DIR, path.join(SOURCE_DIR, "models")]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.startsWith("ggml-") && file.endsWith(".bin")) {
        const src = path.join(dir, file);
        const dst = path.join(MODELS_DIR, file);
        try {
          fs.copyFileSync(src, dst);
          console.log(`  Model: ${file}`);
        } catch {}
      }
    }
  }

  const binCount = fs.readdirSync(BIN_DIR).filter((f) => f.endsWith(".exe")).length;
  console.log(`\nDone! ${binCount} binaries in ${BIN_DIR}`);
  console.log(`Models directory: ${MODELS_DIR}`);
  console.log("\nNext step: download a model with:");
  console.log("  node tools/whisper-cpp/download-model.mjs");
  console.log("  # or: npm run whisper:model");
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
