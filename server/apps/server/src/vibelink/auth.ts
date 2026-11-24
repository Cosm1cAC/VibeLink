// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);
const PROXY_FORWARD_HEADERS = [
  "x-forwarded-for",
  "cf-connecting-ip",
  "x-real-ip",
  "forwarded",
  "true-client-ip",
] as const;

function normalizeHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const endIdx = trimmed.indexOf("]");
    if (endIdx > 1) return trimmed.slice(1, endIdx);
  }
  return trimmed.split(":")[0] ?? "";
}

function isLocalOrLanHost(host: string): boolean {
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.startsWith("192.168.") || host.startsWith("10.")) return true;
  const parts = host.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  if (parts[0] === 172 && (parts[1] ?? -1) >= 16 && (parts[1] ?? 999) <= 31) return true;
  if (parts[0] === 100 && (parts[1] ?? -1) >= 64 && (parts[1] ?? 999) <= 127) return true;
  return false;
}

function hasProxyForwardingHeader(
  headers?: Record<string, string | ReadonlyArray<string> | undefined>,
): boolean {
  if (!headers) return false;
  for (const name of PROXY_FORWARD_HEADERS) {
    const val = headers[name];
    if (typeof val === "string" && val.trim().length > 0) return true;
    if (Array.isArray(val) && val.some((v) => typeof v === "string" && v.trim().length > 0)) {
      return true;
    }
  }
  return false;
}

export function isLoopbackAddress(
  remoteAddress?: string | null,
  hostHeader?: string | null,
  headers?: Record<string, string | ReadonlyArray<string> | undefined>,
): boolean {
  if (!remoteAddress || !LOOPBACK_HOSTS.has(remoteAddress.trim().toLowerCase())) {
    return false;
  }
  if (hasProxyForwardingHeader(headers)) {
    return false;
  }
  if (hostHeader && !isLocalOrLanHost(normalizeHost(hostHeader))) {
    return false;
  }
  return true;
}

export class VibeLinkAuth {
  readonly tokenPath: string;
  readonly token: string;

  constructor(homeDir: string) {
    this.tokenPath = NodePath.join(homeDir, "auth-token.txt");
    const envToken = process.env.VIBELINK_TOKEN?.trim();
    if (envToken) {
      this.token = envToken;
      return;
    }
    NodeFS.mkdirSync(homeDir, { recursive: true });
    if (NodeFS.existsSync(this.tokenPath)) {
      const existing = NodeFS.readFileSync(this.tokenPath, "utf8").trim();
      if (existing.length >= 16) {
        this.token = existing;
        return;
      }
    }
    const generated = `vl_${NodeCrypto.randomBytes(24).toString("hex")}`;
    NodeFS.writeFileSync(this.tokenPath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
    this.token = generated;
  }

  verify(input: {
    readonly authorizationHeader?: string | null;
    readonly tokenHeader?: string | null;
    readonly queryToken?: string | null;
    readonly remoteAddress?: string | null;
    readonly hostHeader?: string | null;
    readonly headers?: Record<string, string | ReadonlyArray<string> | undefined>;
  }): boolean {
    const provided = this.extractProvidedToken(input);
    if (provided !== null) {
      return this.constantTimeEqual(provided, this.token);
    }
    if (process.env.VIBELINK_REQUIRE_LOOPBACK_AUTH === "1") {
      return false;
    }
    return isLoopbackAddress(input.remoteAddress, input.hostHeader, input.headers);
  }

  extractToken(input: {
    readonly authorizationHeader?: string | null;
    readonly tokenHeader?: string | null;
    readonly queryToken?: string | null;
  }): string | null {
    return this.extractProvidedToken(input);
  }

  isOwnerToken(candidate: string): boolean {
    return this.constantTimeEqual(candidate, this.token);
  }

  private extractProvidedToken(input: {
    readonly authorizationHeader?: string | null;
    readonly tokenHeader?: string | null;
    readonly queryToken?: string | null;
  }): string | null {
    const authHeader = input.authorizationHeader?.trim();
    if (authHeader) {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader);
      if (match?.[1]) return match[1].trim();
    }
    const headerToken = input.tokenHeader?.trim();
    if (headerToken) return headerToken;
    const queryToken = input.queryToken?.trim();
    if (queryToken) return queryToken;
    return null;
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return NodeCrypto.timingSafeEqual(bufA, bufB);
  }
}
