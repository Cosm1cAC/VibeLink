import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function homeDir(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function appDataDir(env = process.env) {
  return env.APPDATA || path.join(homeDir(env), "AppData", "Roaming");
}

function pathKey(env = process.env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
}

function existingDirs(items = []) {
  return items.filter((item) => {
    try {
      return item && fs.existsSync(item) && fs.statSync(item).isDirectory();
    } catch {
      return false;
    }
  });
}

export function agentReachPathEntries(env = process.env) {
  const home = homeDir(env);
  const candidates = process.platform === "win32"
    ? [
        path.join(home, ".agent-reach-venv", "Scripts"),
        path.join(home, ".local", "bin"),
        path.join(home, ".agent-reach", "tools", "ffmpeg"),
        path.join(appDataDir(env), "npm")
      ]
    : [
        path.join(home, ".agent-reach-venv", "bin"),
        path.join(home, ".local", "bin"),
        path.join(home, ".agent-reach", "tools", "ffmpeg")
      ];
  return existingDirs(candidates);
}

export function withAgentReachPath(env = process.env) {
  const key = pathKey(env);
  const currentPath = env[key] || env.PATH || "";
  const parts = String(currentPath || "").split(path.delimiter).filter(Boolean);
  const seen = new Set(parts.map((part) => path.resolve(part).toLowerCase()));
  const prefix = [];

  for (const entry of agentReachPathEntries(env)) {
    const normalized = path.resolve(entry).toLowerCase();
    if (seen.has(normalized)) continue;
    prefix.push(entry);
    seen.add(normalized);
  }

  const mergedPath = [...prefix, ...parts].join(path.delimiter);
  return {
    ...env,
    [key]: mergedPath,
    PATH: mergedPath
  };
}

export function agentReachInstallInfo(env = process.env) {
  return {
    pathEntries: agentReachPathEntries(env),
    venvScripts: process.platform === "win32"
      ? path.join(homeDir(env), ".agent-reach-venv", "Scripts")
      : path.join(homeDir(env), ".agent-reach-venv", "bin"),
    npmBin: process.platform === "win32" ? path.join(appDataDir(env), "npm") : ""
  };
}
