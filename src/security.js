import path from "node:path";
import { rootDir } from "./config.js";
import { createDevice, deleteWorkspaceByPath, findDeviceByToken, listWorkspaces, upsertWorkspace } from "./db.js";

function cleanHost(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function isLocalHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isPrivateIpv4(host) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host);
}

export function getBearer(request) {
  const auth = request.headers.authorization || "";
  const [, token] = auth.match(/^Bearer\s+(.+)$/i) || [];
  return token || "";
}

export function defaultAllowedRoots(settings = {}) {
  return unique([rootDir, settings.defaultCwd]).map((item) => path.resolve(item));
}

export function ensureDefaultWorkspaces(settings = {}) {
  deleteWorkspaceByPath(process.env.USERPROFILE || "");
  deleteWorkspaceByPath(process.env.HOME || "");
  const roots = defaultAllowedRoots(settings);
  for (const root of roots) {
    upsertWorkspace({
      path: root,
      allowedRoot: root,
      title: path.basename(root) || root
    });
  }
  return listWorkspaces();
}

export function allowedRoots(settings = {}) {
  const explicit = Array.isArray(settings.allowedRoots) ? settings.allowedRoots : [];
  const workspaceRoots = listWorkspaces().map((item) => item.allowedRoot || item.path);
  return unique([...explicit, ...workspaceRoots, ...defaultAllowedRoots(settings)]).map((item) => path.resolve(item));
}

export function resolveAllowedPath(value, settings = {}) {
  const resolved = path.resolve(String(value || ""));
  const roots = allowedRoots(settings);
  const root = roots.find((candidate) => resolved === candidate || resolved.toLowerCase().startsWith(`${candidate.toLowerCase()}${path.sep}`));
  if (!root) {
    const error = new Error("Path is outside allowed roots.");
    error.status = 403;
    error.path = resolved;
    throw error;
  }
  return resolved;
}

export function isHostAllowed(request, settings = {}) {
  const host = cleanHost(request.headers.host || "");
  if (!host) return true;

  const configured = Array.isArray(settings.hostAllowlist) ? settings.hostAllowlist.map(cleanHost) : [];
  if (configured.includes(host)) return true;
  if (isLocalHost(host) || isPrivateIpv4(host)) return true;
  if (host.endsWith(".trycloudflare.com") && settings.allowTryCloudflare !== false) return true;
  return false;
}

export function publicAccessWarnings(request, settings = {}) {
  const host = cleanHost(request.headers.host || "");
  const warnings = [];
  if (host.endsWith(".trycloudflare.com")) {
    warnings.push("Public Cloudflare Tunnel is enabled. Use device tokens and keep allowed roots narrow.");
  }
  if (settings.host === "0.0.0.0") {
    warnings.push("Server listens on all interfaces.");
  }
  return warnings;
}

export function authenticateRequest(request, url, settings = {}) {
  if (!settings.pairingToken) return { ok: true, method: "open" };

  const token = getBearer(request) || url.searchParams.get("token") || "";
  if (!token) return { ok: false };

  const device = findDeviceByToken(token);
  if (device) return { ok: true, method: "device", device };

  return { ok: false };
}

export function pairDevice({ pairingToken, settings, label }) {
  if (settings.pairingToken && pairingToken !== settings.pairingToken) {
    const error = new Error("Pairing token mismatch");
    error.status = 401;
    throw error;
  }
  return createDevice({ label: label || "Browser" });
}
