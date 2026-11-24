// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

export type VlPairingEndpointKind = "lan" | "tailscale" | "wan";

export interface VlPairingEndpoint {
  readonly id: string;
  readonly label: string;
  readonly kind: VlPairingEndpointKind;
  readonly url: string;
  readonly iface?: string;
  readonly priority: number;
  readonly serverRole?: "primary" | "standby";
  readonly nodeId?: string;
}

export interface VlPairingConfig {
  readonly customExternalUrl: string;
}

export interface VlPairingInfo {
  readonly ok: true;
  readonly version: number;
  readonly hostName: string;
  readonly port: number;
  readonly token: string;
  readonly customExternalUrl: string;
  readonly endpoints: ReadonlyArray<VlPairingEndpoint>;
  readonly qrPayload: string;
}

const VIRTUAL_IFACE_RE = /^(vethernet|wsl|docker|vmware|virtualbox|virbr|br-|loopback|isatap|teredo)/i;
const MAX_SPEEDTEST_BYTES = 2 * 1024 * 1024;
const MIN_SPEEDTEST_BYTES = 16 * 1024;
const DEFAULT_SPEEDTEST_BYTES = 512 * 1024;

// Pre-allocated incompressible buffer reused by /api/vl/speedtest/download
const SPEEDTEST_BUFFER = new Uint8Array(NodeCrypto.randomBytes(MAX_SPEEDTEST_BYTES));

export function getSpeedTestPayload(requestedBytes?: number): Uint8Array {
  const finite = Number.isFinite(requestedBytes) ? Math.floor(requestedBytes as number) : DEFAULT_SPEEDTEST_BYTES;
  const clamped = Math.max(MIN_SPEEDTEST_BYTES, Math.min(MAX_SPEEDTEST_BYTES, finite));
  return SPEEDTEST_BUFFER.subarray(0, clamped);
}

function normalizeCustomExternalUrl(raw?: string | null): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      return "";
    }
    const basePath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${basePath}`.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function readPairingConfig(homeDir: string): VlPairingConfig {
  const filePath = NodePath.join(homeDir, "pairing-config.json");
  try {
    if (!NodeFS.existsSync(filePath)) {
      return { customExternalUrl: "" };
    }
    const parsed = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as { customExternalUrl?: unknown };
    return {
      customExternalUrl: normalizeCustomExternalUrl(
        typeof parsed.customExternalUrl === "string" ? parsed.customExternalUrl : "",
      ),
    };
  } catch {
    return { customExternalUrl: "" };
  }
}

export function writePairingConfig(
  homeDir: string,
  patch: { readonly customExternalUrl?: string },
): VlPairingConfig {
  const current = readPairingConfig(homeDir);
  const next: VlPairingConfig = {
    customExternalUrl:
      patch.customExternalUrl !== undefined
        ? normalizeCustomExternalUrl(patch.customExternalUrl)
        : current.customExternalUrl,
  };
  NodeFS.mkdirSync(homeDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(homeDir, "pairing-config.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function isTailscaleIpv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
  return parts.length === 4 && parts[0] === 100 && (parts[1] ?? -1) >= 64 && (parts[1] ?? 999) <= 127;
}

function isPrivateLanIpv4(ip: string): boolean {
  if (ip.startsWith("192.168.") || ip.startsWith("10.")) return true;
  const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
  return parts.length === 4 && parts[0] === 172 && (parts[1] ?? -1) >= 16 && (parts[1] ?? 999) <= 31;
}

function extractPort(hostHeader?: string | null, fallbackPort = 18990): number {
  if (hostHeader) {
    const match = /:(\d{1,5})$/.exec(hostHeader.trim());
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10);
      if (parsed > 0 && parsed <= 65535) return parsed;
    }
  }
  const envPort = Number.parseInt(process.env.VIBELINK_PORT ?? process.env.T3CODE_PORT ?? "", 10);
  if (Number.isFinite(envPort) && envPort > 0 && envPort <= 65535) return envPort;
  return fallbackPort;
}

export function buildPairingInfo(input: {
  readonly homeDir: string;
  readonly token: string;
  readonly hostHeader?: string | null;
  readonly defaultPort?: number;
  readonly extraEndpoints?: ReadonlyArray<VlPairingEndpoint>;
}): VlPairingInfo {
  const port = extractPort(input.hostHeader, input.defaultPort ?? 18990);
  const config = readPairingConfig(input.homeDir);
  const envExternal = normalizeCustomExternalUrl(process.env.VIBELINK_EXTERNAL_URL);
  const externalUrl = config.customExternalUrl || envExternal;

  const discovered: VlPairingEndpoint[] = [];
  const seenUrls = new Set<string>();

  const ifaces = NodeOS.networkInterfaces();
  for (const [ifaceName, addrs] of Object.entries(ifaces)) {
    if (!addrs || VIRTUAL_IFACE_RE.test(ifaceName)) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const ip = addr.address;
      if (ip.startsWith("169.254.")) continue;

      const isTailscale = isTailscaleIpv4(ip) || /tailscale/i.test(ifaceName);
      const isLan = !isTailscale && isPrivateLanIpv4(ip);
      if (!isTailscale && !isLan) continue;

      const url = `http://${ip}:${port}`;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      if (isTailscale) {
        discovered.push({
          id: `ep_tailscale_${ip.replace(/\./g, "_")}`,
          label: "外网 · Tailscale",
          kind: "tailscale",
          url,
          iface: ifaceName,
          priority: 25,
          serverRole: "primary",
        });
      } else if (ip.startsWith("192.168.137.")) {
        discovered.push({
          id: `ep_hotspot_${ip.replace(/\./g, "_")}`,
          label: `内网 · 热点 (${ifaceName})`,
          kind: "lan",
          url,
          iface: ifaceName,
          priority: 20,
          serverRole: "primary",
        });
      } else {
        discovered.push({
          id: `ep_lan_${ip.replace(/\./g, "_")}`,
          label: `内网 · ${ifaceName}`,
          kind: "lan",
          url,
          iface: ifaceName,
          priority: 10,
          serverRole: "primary",
        });
      }
    }
  }

  if (externalUrl && !seenUrls.has(externalUrl)) {
    seenUrls.add(externalUrl);
    discovered.push({
      id: "ep_wan_custom",
      label: "外网 · 自定义公网",
      kind: "wan",
      url: externalUrl,
      priority: 35,
      serverRole: "primary",
    });
  }

  for (const extra of input.extraEndpoints ?? []) {
    if (!extra.url || seenUrls.has(extra.url)) continue;
    seenUrls.add(extra.url);
    discovered.push(extra);
  }

  discovered.sort((a, b) => a.priority - b.priority || a.url.localeCompare(b.url));

  const hostName = NodeOS.hostname();
  const qrPayload = JSON.stringify({
    t: "vl-pair",
    v: 1,
    h: hostName,
    k: input.token,
    e: discovered.map((ep) => ({
      n: ep.label,
      k: ep.kind,
      u: ep.url,
      ...(ep.serverRole ? { r: ep.serverRole } : {}),
      ...(ep.nodeId ? { d: ep.nodeId } : {}),
    })),
  });

  return {
    ok: true,
    version: 1,
    hostName,
    port,
    token: input.token,
    customExternalUrl: externalUrl,
    endpoints: discovered,
    qrPayload,
  };
}
