import fs from "node:fs";
import path from "node:path";

import { rustBinaryIsCurrent } from "../../test/rustTestSupport.js";

const rebuildCommand = "cargo build --release --manifest-path apps/windows/Cargo.toml";

function binaryName(platform) {
  return platform === "win32" ? "vibelink.exe" : "vibelink";
}

function samePath(left, right, platform) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function candidatePaths(rootDir, platform) {
  const binary = binaryName(platform);
  return {
    release: path.join(rootDir, "apps", "windows", "target", "release", binary),
    debug: path.join(rootDir, "apps", "windows", "target", "debug", binary)
  };
}

function profileFor(command, rootDir, platform) {
  const candidates = candidatePaths(rootDir, platform);
  if (samePath(command, candidates.release, platform)) return "release";
  if (samePath(command, candidates.debug, platform)) return "debug";
  return "custom";
}

export function resolveEventStoreRustCommand({
  rootDir,
  platform = process.platform,
  explicitCommand = "",
  envCommand = "",
  performanceGate = true,
  exists = fs.existsSync,
  isCurrent = rustBinaryIsCurrent
}) {
  const root = path.resolve(rootDir);
  const sourceRoot = path.join(root, "apps", "windows", "src");
  const candidates = candidatePaths(root, platform);
  const explicit = Boolean(explicitCommand || envCommand);
  const command = path.resolve(explicitCommand || envCommand || (exists(candidates.release) ? candidates.release : candidates.debug));
  const profile = profileFor(command, root, platform);

  if (!exists(command)) {
    throw new Error(
      `Rust event-store sidecar command is missing: ${command}\n` +
      `Build it first with: ${rebuildCommand}`
    );
  }

  if ((profile === "release" || profile === "debug") && !isCurrent(command, sourceRoot)) {
    throw new Error(
      `stale Rust event-store binary: ${command}\n` +
      "The canary refuses to use a target binary older than apps/windows/src.\n" +
      `Rebuild it first with: ${rebuildCommand}`
    );
  }

  if (performanceGate && profile === "debug") {
    throw new Error(
      `debug Rust event-store binary is not valid for release performance canaries: ${command}\n` +
      `Build release first with: ${rebuildCommand}\n` +
      "For a functional-only debug check, pass --functional-only."
    );
  }

  return { command, profile, explicit };
}

export function eventStoreRustArgs(env = process.env) {
  if (!env.VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON) return ["event-store-sidecar"];
  try {
    const parsed = JSON.parse(env.VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON);
    return Array.isArray(parsed) ? parsed.map(String) : ["event-store-sidecar"];
  } catch {
    return ["event-store-sidecar"];
  }
}

export function explicitReleaseCommand(rootDir, platform = process.platform) {
  return candidatePaths(path.resolve(rootDir), platform).release;
}
