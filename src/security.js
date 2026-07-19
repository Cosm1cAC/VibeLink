import fs from "node:fs";
import path from "node:path";
import { rootDir } from "./config.js";
import { createDevice, deleteWorkspaceByPath, findDeviceByToken, listWorkspaces, upsertWorkspace } from "./db.js";

const rateBuckets = new Map();

export function cleanHost(value) {
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

export function isPublicHost(request) {
  const host = cleanHost(request.headers.host || "");
  return Boolean(host && !isLocalHost(host) && !isPrivateIpv4(host));
}

function hostMatches(configuredHost, host) {
  if (!configuredHost || !host) return false;
  if (configuredHost === host) return true;
  if (configuredHost.startsWith("*.")) {
    const suffix = configuredHost.slice(1);
    return host.endsWith(suffix);
  }
  return false;
}

export function requestIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request.socket?.remoteAddress || "";
}

export function requestUserAgent(request) {
  return String(request.headers["user-agent"] || "").slice(0, 500);
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

function comparablePath(value) {
  const resolved = path.resolve(String(value || ""));
  if (process.platform !== "win32") return resolved;

  const suffix = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.resolve(fs.realpathSync.native(existing), ...suffix).toLowerCase();
  } catch {
    return resolved.toLowerCase();
  }
}

export function resolveAllowedPath(value, settings = {}) {
  const resolved = path.resolve(String(value || ""));
  const roots = allowedRoots(settings);
  const comparable = comparablePath(resolved);
  const root = roots.find((candidate) => {
    const comparableRoot = comparablePath(candidate);
    return comparable === comparableRoot || comparable.startsWith(`${comparableRoot}${path.sep}`);
  });
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
  if (configured.some((item) => hostMatches(item, host))) return true;
  if (isLocalHost(host) || isPrivateIpv4(host)) return true;
  return false;
}

export function publicAccessWarnings(request, settings = {}) {
  const host = cleanHost(request.headers.host || "");
  const warnings = [];
  if (host.endsWith(".trycloudflare.com")) {
    warnings.push(
      isHostAllowed(request, settings)
        ? "Public Cloudflare Tunnel host is registered. Keep device tokens and allowed roots narrow."
        : "Public Cloudflare Tunnel host is not registered in Host allowlist."
    );
  }
  if (settings.host === "0.0.0.0") {
    warnings.push("Server listens on all interfaces.");
  }
  if (host && !isLocalHost(host) && !isPrivateIpv4(host) && !isHostAllowed(request, settings)) {
    warnings.push("Public host is blocked until it is explicitly added to Host allowlist.");
  }
  return warnings;
}

export function authenticateRequest(request, url, settings = {}) {
  if (!settings.pairingToken) return { ok: true, method: "open" };

  const token = getBearer(request) || url.searchParams.get("token") || "";
  if (!token) return { ok: false, reason: "missing_token" };

  const device = findDeviceByToken(token);
  if (device) return { ok: true, method: "device", device };

  return { ok: false, reason: "invalid_or_expired_token" };
}

export function pairDevice({ pairingToken, settings, label }) {
  if (settings.pairingToken && pairingToken !== settings.pairingToken) {
    const error = new Error("Pairing token mismatch");
    error.status = 401;
    throw error;
  }
  return createDevice({ label: label || "Browser" });
}

export function pairingTokenLogValue({ settings = {}, devices = [] } = {}) {
  if (!settings.pairingToken) return "[not configured]";
  const hasActiveDevice = devices.some((device) => !device.revokedAt && !device.expired);
  if (settings.allowLegacyPairingTokenLogin || !hasActiveDevice) return settings.pairingToken;
  return "[hidden; use device pairing]";
}

export function checkRateLimit(key, { limit = 30, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return {
    ok: bucket.count <= limit,
    count: bucket.count,
    limit,
    resetAt: new Date(bucket.resetAt).toISOString(),
    retryAfterMs: Math.max(0, bucket.resetAt - now)
  };
}

export function rateLimitKey(request, scope, extra = "") {
  return `${scope}:${requestIp(request)}:${extra}`;
}

export function cloudflareGuide(request, settings = {}) {
  const host = cleanHost(request.headers.host || "");
  const configured = Array.isArray(settings.hostAllowlist) ? settings.hostAllowlist.map(cleanHost) : [];
  const publicHost = Boolean(host && !isLocalHost(host) && !isPrivateIpv4(host));
  const tunnelDetected = host.endsWith(".trycloudflare.com");
  const registered = !publicHost || configured.some((item) => hostMatches(item, host));
  return {
    host,
    publicHost,
    tunnelDetected,
    registered,
    listeningOnAllInterfaces: settings.host === "0.0.0.0",
    allowlist: configured,
    accessRecommended: publicHost,
    warnings: publicAccessWarnings(request, settings),
    steps: [
      "Create or choose a fixed Cloudflare Tunnel hostname.",
      "Add that exact hostname to Host allowlist before exposing the bridge.",
      "Optionally protect the hostname with Cloudflare Access.",
      "Pair each device through a short-lived pairing session and revoke old devices.",
      "Keep allowed roots narrow and review audit logs after remote access."
    ]
  };
}
