import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const defaultRun = (command, args, options = {}) => spawnSync(command, args, {
  encoding: "utf8",
  windowsHide: true,
  ...options
});

export function probeCargo({
  platform = process.platform,
  homeDir = os.homedir(),
  cwd = process.cwd(),
  fileExists = fs.existsSync,
  run = defaultRun
} = {}) {
  const lookup = platform === "win32"
    ? run("where.exe", ["cargo"])
    : run("sh", ["-lc", "command -v cargo"]);
  const discovered = lookup.status === 0 ? String(lookup.stdout || "").trim().split(/\r?\n/)[0] || "" : "";

  const candidates = platform === "win32"
    ? [path.join(homeDir, ".cargo", "bin", "cargo.exe")]
    : [path.join(homeDir, ".cargo", "bin", "cargo")];
  const cargo = (discovered && fileExists(discovered) ? discovered : "")
    || candidates.find((candidate) => fileExists(candidate))
    || "";
  if (!cargo) {
    return { available: false, path: "", reason: "executable_not_found", commandStatus: lookup.status };
  }

  const metadata = run(cargo, [
    "metadata",
    "--format-version",
    "1",
    "--no-deps",
    "--manifest-path",
    "apps/windows/Cargo.toml"
  ], { cwd });
  if (metadata.status !== 0) {
    return { available: false, path: cargo, reason: "metadata_failed", commandStatus: metadata.status };
  }

  return { available: true, path: cargo, reason: "available", commandStatus: metadata.status };
}

export function cargoPath() {
  const result = probeCargo();
  return result.available ? result.path : "";
}

export function cargoPathOrSkip(testContext, { env = process.env, probeOptions } = {}) {
  const result = probeCargo(probeOptions);
  if (result.available) return result.path;
  const diagnostic = JSON.stringify(result);
  if (env.CI && env.VIBELINK_ALLOW_MISSING_CARGO !== "1") {
    throw new Error(`Cargo is required in CI: ${diagnostic}`);
  }
  testContext.skip(`cargo is not available: ${diagnostic}`);
  return "";
}

export function rustBinaryIsCurrent(binaryPath, sourceRoot) {
  if (!fs.existsSync(binaryPath)) return false;
  const binaryMtime = fs.statSync(binaryPath).mtimeMs;
  const pending = [sourceRoot];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const item = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(item);
      else if (entry.isFile() && entry.name.endsWith(".rs") && fs.statSync(item).mtimeMs > binaryMtime) return false;
    }
  }
  return true;
}
