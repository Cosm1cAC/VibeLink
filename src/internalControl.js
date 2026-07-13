import crypto from "node:crypto";

function isLoopbackAddress(value) {
  const address = String(value || "").replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}

export function internalControlAuthorized(request, configuredToken) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false;

  const expected = Buffer.from(String(configuredToken || ""), "utf8");
  const providedHeader = request?.headers?.["x-vibelink-internal-token"];
  const provided = Buffer.from(typeof providedHeader === "string" ? providedHeader : "", "utf8");
  if (expected.length === 0 || expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

export function originalHostRequest(request) {
  const originalHostHeader = request?.headers?.["x-vibelink-original-host"];
  const originalHost = typeof originalHostHeader === "string" ? originalHostHeader.trim() : "";
  const headers = { ...request.headers };
  if (originalHost && originalHost.length <= 255) headers.host = originalHost;
  return { ...request, headers };
}
