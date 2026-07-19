import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function cargoPath() {
  const lookup = process.platform === "win32"
    ? spawnSync("where.exe", ["cargo"], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-lc", "command -v cargo"], { encoding: "utf8", windowsHide: true });
  const discovered = lookup.status === 0 ? String(lookup.stdout || "").trim().split(/\r?\n/)[0] || "" : "";

  const candidates = process.platform === "win32"
    ? [path.join(os.homedir(), ".cargo", "bin", "cargo.exe")]
    : [path.join(os.homedir(), ".cargo", "bin", "cargo")];
  const cargo = (discovered && fs.existsSync(discovered) ? discovered : "")
    || candidates.find((candidate) => fs.existsSync(candidate))
    || "";
  if (process.platform !== "win32" || !cargo) return cargo;

  const linker = spawnSync("where.exe", ["link.exe"], { encoding: "utf8", windowsHide: true });
  return linker.status === 0 ? cargo : "";
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
