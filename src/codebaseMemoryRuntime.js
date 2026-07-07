import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEBASE_MEMORY_SERVER_ID = "codebase-memory-mcp";
export const CODEBASE_MEMORY_COMMAND = "codebase-memory-mcp";

function homeDir(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function localAppDataDir(env = process.env) {
  return env.LOCALAPPDATA || path.join(homeDir(env), "AppData", "Local");
}

function pathKey(env = process.env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
}

function executableName(platform = process.platform) {
  return platform === "win32" ? `${CODEBASE_MEMORY_COMMAND}.exe` : CODEBASE_MEMORY_COMMAND;
}

function isFile(value, fsLike = fs) {
  try {
    return Boolean(value && fsLike.existsSync(value) && fsLike.statSync(value).isFile());
  } catch {
    return false;
  }
}

function isDirectory(value, fsLike = fs) {
  try {
    return Boolean(value && fsLike.existsSync(value) && fsLike.statSync(value).isDirectory());
  } catch {
    return false;
  }
}

function uniqueResolved(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item) return false;
    const key = path.resolve(item).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function codebaseMemoryPathEntries({ env = process.env, platform = process.platform, fsLike = fs } = {}) {
  const home = homeDir(env);
  const candidates = platform === "win32"
    ? [
        path.join(localAppDataDir(env), "Programs", CODEBASE_MEMORY_SERVER_ID),
        path.join(home, ".local", "bin")
      ]
    : [
        path.join(home, ".local", "bin"),
        path.join(home, ".cargo", "bin"),
        "/usr/local/bin",
        "/opt/homebrew/bin"
      ];

  return uniqueResolved(candidates).filter((item) => isDirectory(item, fsLike));
}

export function withCodebaseMemoryPath(env = process.env, options = {}) {
  const key = pathKey(env);
  const currentPath = env[key] || env.PATH || "";
  const parts = String(currentPath || "").split(path.delimiter).filter(Boolean);
  const seen = new Set(parts.map((part) => path.resolve(part).toLowerCase()));
  const prefix = [];

  for (const entry of codebaseMemoryPathEntries({ env, ...options })) {
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

export function codebaseMemoryCommandCandidates({ env = process.env, platform = process.platform } = {}) {
  const home = homeDir(env);
  const name = executableName(platform);
  const explicit = String(env.CODEBASE_MEMORY_MCP_COMMAND || env.CBM_COMMAND || "").trim();
  const candidates = explicit ? [explicit] : [];

  if (platform === "win32") {
    candidates.push(
      path.join(localAppDataDir(env), "Programs", CODEBASE_MEMORY_SERVER_ID, name),
      path.join(home, ".local", "bin", name)
    );
  } else {
    candidates.push(
      path.join(home, ".local", "bin", name),
      path.join(home, ".cargo", "bin", name),
      path.join("/usr/local/bin", name),
      path.join("/opt/homebrew/bin", name)
    );
  }

  return uniqueResolved(candidates);
}

export function codebaseMemoryServerConfig({ env = process.env, platform = process.platform, fsLike = fs } = {}) {
  const explicit = String(env.CODEBASE_MEMORY_MCP_COMMAND || env.CBM_COMMAND || "").trim();
  if (explicit) return serverConfig(explicit);

  const command = codebaseMemoryCommandCandidates({ env, platform }).find((candidate) => isFile(candidate, fsLike));
  return command ? serverConfig(command) : null;
}

export function mergeCodebaseMemoryServer(settings = {}, server = codebaseMemoryServerConfig()) {
  if (!server) return settings;
  const servers = Array.isArray(settings.mcp?.servers) ? settings.mcp.servers : [];
  const hasExisting = servers.some((item) => item?.id === CODEBASE_MEMORY_SERVER_ID || item?.name === CODEBASE_MEMORY_SERVER_ID);
  if (hasExisting) return settings;
  return {
    ...settings,
    mcp: {
      ...(settings.mcp || {}),
      servers: [...servers, server]
    }
  };
}

export function codebaseMemoryInstallInfo(options = {}) {
  const server = codebaseMemoryServerConfig(options);
  return {
    available: Boolean(server),
    server,
    pathEntries: codebaseMemoryPathEntries(options),
    candidates: codebaseMemoryCommandCandidates(options)
  };
}

function serverConfig(command) {
  return {
    id: CODEBASE_MEMORY_SERVER_ID,
    name: CODEBASE_MEMORY_SERVER_ID,
    type: "stdio",
    enabled: true,
    command,
    args: []
  };
}
