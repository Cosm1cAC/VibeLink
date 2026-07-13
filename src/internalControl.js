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
  const headers = { ...request.headers };
  for (const [source, target, maxLength] of [
    ["x-vibelink-original-host", "host", 255],
    ["x-vibelink-original-user-agent", "user-agent", 512],
    ["x-vibelink-original-forwarded-for", "x-forwarded-for", 1024]
  ]) {
    const raw = request?.headers?.[source];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value && value.length <= maxLength) headers[target] = value;
  }
  return { ...request, headers };
}
