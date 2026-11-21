// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function normalizeHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .split(":")[0] ?? "";
}

export function isLoopbackAddress(remoteAddress?: string | null, hostHeader?: string | null): boolean {
  if (remoteAddress && LOOPBACK_HOSTS.has(remoteAddress.trim().toLowerCase())) {
    return true;
  }
  if (!remoteAddress && hostHeader) {
    return LOOPBACK_HOSTS.has(normalizeHost(hostHeader));
  }
  return false;
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
    NodeFS.writeFileSync(this.tokenPath, `${generated}\n`, "utf8");
    this.token = generated;
  }

  verify(input: {
    readonly authorizationHeader?: string | null;
    readonly tokenHeader?: string | null;
    readonly queryToken?: string | null;
    readonly remoteAddress?: string | null;
    readonly hostHeader?: string | null;
  }): boolean {
    const provided = this.extractProvidedToken(input);
    if (provided !== null) {
      return this.constantTimeEqual(provided, this.token);
    }
    if (process.env.VIBELINK_REQUIRE_LOOPBACK_AUTH === "1") {
      return false;
    }
    return isLoopbackAddress(input.remoteAddress, input.hostHeader);
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
