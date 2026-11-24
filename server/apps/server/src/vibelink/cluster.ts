// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { VibeLinkAccountStore, VlReplicationSnapshot } from "./accounts.ts";

export type VlClusterRole = "primary" | "standby";

export interface VlClusterConfig {
  readonly role: VlClusterRole;
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly peerUrl: string;
  readonly primaryTailscaleUrl: string;
  readonly primaryPublicUrl: string;
  readonly standbyTailscaleUrl: string;
  readonly standbyPublicUrl: string;
  readonly clusterSecret: string;
  readonly syncIntervalMs: number;
}

export interface VlClusterNodeEndpoint {
  readonly id: string;
  readonly label: string;
  readonly kind: "lan" | "tailscale" | "wan";
  readonly url: string;
  readonly serverRole: VlClusterRole;
  readonly nodeId: string;
  readonly priority: number;
}

export interface VlClusterStatusPayload {
  readonly ok: true;
  readonly role: VlClusterRole;
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly peerUrl: string;
  readonly primaryTailscaleUrl: string;
  readonly primaryPublicUrl: string;
  readonly standbyTailscaleUrl: string;
  readonly standbyPublicUrl: string;
  readonly syncIntervalMs: number;
  readonly syncRevision: number;
  readonly standbyDirty: boolean;
  readonly lastSyncAt: number | null;
  readonly lastSyncOk: boolean | null;
  readonly lastSyncError: string | null;
  readonly peerStatus: {
    readonly reachable: boolean;
    readonly role?: VlClusterRole;
    readonly nodeId?: string;
    readonly nodeLabel?: string;
    readonly syncRevision?: number;
    readonly standbyDirty?: boolean;
    readonly latencyMs?: number | null;
  } | null;
  readonly endpoints: ReadonlyArray<VlClusterNodeEndpoint>;
}

const VIRTUAL_IFACE_RE = /^(vethernet|wsl|docker|vmware|virtualbox|virbr|br-|loopback|isatap|teredo)/i;

function normalizeHttpUrl(raw?: string | null): string {
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

function isTailscaleIp(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
  return parts.length === 4 && parts[0] === 100 && (parts[1] ?? -1) >= 64 && (parts[1] ?? 999) <= 127;
}

function isPrivateLanIp(ip: string): boolean {
  if (ip.startsWith("192.168.") || ip.startsWith("10.")) return true;
  const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
  return parts.length === 4 && parts[0] === 172 && (parts[1] ?? -1) >= 16 && (parts[1] ?? 999) <= 31;
}

function classifyUrlKind(url: string): "lan" | "tailscale" | "wan" {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (isTailscaleIp(host) || host.endsWith(".ts.net")) return "tailscale";
    if (isPrivateLanIp(host) || host === "localhost" || host === "127.0.0.1") return "lan";
    return "wan";
  } catch {
    return "wan";
  }
}

export class VibeLinkClusterManager {
  readonly homeDir: string;
  readonly configPath: string;
  readonly accounts: VibeLinkAccountStore;
  private config: VlClusterConfig;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private lastSyncAt: number | null = null;
  private lastSyncOk: boolean | null = null;
  private lastSyncError: string | null = null;
  private lastPeerStatus: VlClusterStatusPayload["peerStatus"] = null;

  constructor(homeDir: string, accounts: VibeLinkAccountStore) {
    this.homeDir = homeDir;
    this.configPath = NodePath.join(homeDir, "cluster-config.json");
    this.accounts = accounts;
    this.config = this.loadConfig();
    this.accounts.setEncryptionSecret(this.config.clusterSecret);
    this.accounts.setStandbyMode(this.config.role === "standby");
  }

  private loadConfig(): VlClusterConfig {
    let fileCfg: Partial<VlClusterConfig> = {};
    try {
      if (NodeFS.existsSync(this.configPath)) {
        fileCfg = JSON.parse(NodeFS.readFileSync(this.configPath, "utf8")) as Partial<VlClusterConfig>;
      }
    } catch {
      fileCfg = {};
    }

    const envRole = process.env.VIBELINK_CLUSTER_ROLE?.trim().toLowerCase();
    const role: VlClusterRole =
      envRole === "standby" || envRole === "primary"
        ? envRole
        : fileCfg.role === "standby"
          ? "standby"
          : "primary";

    const defaultNodeId = role === "primary" ? "pc-primary" : "macmini-standby";
    const defaultNodeLabel = role === "primary" ? "本机 PC 主服" : "Mac mini 备服";
    const defaultPeerUrl = "";

    const existingSecret =
      process.env.VIBELINK_CLUSTER_SECRET?.trim() ||
      (typeof fileCfg.clusterSecret === "string" && fileCfg.clusterSecret.trim().length >= 16
        ? fileCfg.clusterSecret.trim()
        : "");

    const resolved: VlClusterConfig = {
      role,
      nodeId:
        process.env.VIBELINK_CLUSTER_NODE_ID?.trim() ||
        (typeof fileCfg.nodeId === "string" && fileCfg.nodeId.trim()) ||
        defaultNodeId,
      nodeLabel:
        process.env.VIBELINK_CLUSTER_NODE_LABEL?.trim() ||
        (typeof fileCfg.nodeLabel === "string" && fileCfg.nodeLabel.trim()) ||
        defaultNodeLabel,
      peerUrl:
        process.env.VIBELINK_CLUSTER_PEER_URL !== undefined
          ? normalizeHttpUrl(process.env.VIBELINK_CLUSTER_PEER_URL)
          : typeof fileCfg.peerUrl === "string"
            ? normalizeHttpUrl(fileCfg.peerUrl)
            : defaultPeerUrl,
      primaryTailscaleUrl:
        process.env.VIBELINK_PRIMARY_TAILSCALE_URL !== undefined
          ? normalizeHttpUrl(process.env.VIBELINK_PRIMARY_TAILSCALE_URL)
          : typeof fileCfg.primaryTailscaleUrl === "string"
            ? normalizeHttpUrl(fileCfg.primaryTailscaleUrl)
            : "",
      primaryPublicUrl:
        process.env.VIBELINK_PRIMARY_PUBLIC_URL !== undefined
          ? normalizeHttpUrl(process.env.VIBELINK_PRIMARY_PUBLIC_URL)
          : typeof fileCfg.primaryPublicUrl === "string"
            ? normalizeHttpUrl(fileCfg.primaryPublicUrl)
            : "",
      standbyTailscaleUrl:
        process.env.VIBELINK_STANDBY_TAILSCALE_URL !== undefined
          ? normalizeHttpUrl(process.env.VIBELINK_STANDBY_TAILSCALE_URL)
          : typeof fileCfg.standbyTailscaleUrl === "string"
            ? normalizeHttpUrl(fileCfg.standbyTailscaleUrl)
            : "",
      standbyPublicUrl:
        process.env.VIBELINK_STANDBY_PUBLIC_URL !== undefined
          ? normalizeHttpUrl(process.env.VIBELINK_STANDBY_PUBLIC_URL)
          : typeof fileCfg.standbyPublicUrl === "string"
            ? normalizeHttpUrl(fileCfg.standbyPublicUrl)
            : "",
      clusterSecret: existingSecret || NodeCrypto.randomBytes(32).toString("hex"),
      syncIntervalMs:
        typeof fileCfg.syncIntervalMs === "number" && Number.isFinite(fileCfg.syncIntervalMs)
          ? Math.max(5_000, Math.floor(fileCfg.syncIntervalMs))
          : 30_000,
    };

    if (!NodeFS.existsSync(this.configPath) && process.env.VIBELINK_DISABLE_CLUSTER_SYNC !== "1") {
      this.saveConfig(resolved);
    }

    return resolved;
  }

  private saveConfig(cfg: VlClusterConfig): void {
    try {
      NodeFS.mkdirSync(this.homeDir, { recursive: true });
      NodeFS.writeFileSync(this.configPath, `${JSON.stringify(cfg, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // ignore fs errors in restricted envs
    }
  }

  getConfig(): VlClusterConfig {
    return this.config;
  }

  getRole(): VlClusterRole {
    return this.config.role;
  }

  updateConfig(patch: {
    readonly role?: VlClusterRole;
    readonly nodeId?: string;
    readonly nodeLabel?: string;
    readonly peerUrl?: string;
    readonly primaryTailscaleUrl?: string;
    readonly primaryPublicUrl?: string;
    readonly standbyTailscaleUrl?: string;
    readonly standbyPublicUrl?: string;
    readonly syncIntervalMs?: number;
  }): VlClusterConfig {
    const next: VlClusterConfig = {
      ...this.config,
      ...(patch.role === "primary" || patch.role === "standby" ? { role: patch.role } : {}),
      ...(typeof patch.nodeId === "string" && patch.nodeId.trim()
        ? { nodeId: patch.nodeId.trim() }
        : {}),
      ...(typeof patch.nodeLabel === "string" && patch.nodeLabel.trim()
        ? { nodeLabel: patch.nodeLabel.trim() }
        : {}),
      ...(typeof patch.peerUrl === "string" ? { peerUrl: normalizeHttpUrl(patch.peerUrl) } : {}),
      ...(typeof patch.primaryTailscaleUrl === "string"
        ? { primaryTailscaleUrl: normalizeHttpUrl(patch.primaryTailscaleUrl) }
        : {}),
      ...(typeof patch.primaryPublicUrl === "string"
        ? { primaryPublicUrl: normalizeHttpUrl(patch.primaryPublicUrl) }
        : {}),
      ...(typeof patch.standbyTailscaleUrl === "string"
        ? { standbyTailscaleUrl: normalizeHttpUrl(patch.standbyTailscaleUrl) }
        : {}),
      ...(typeof patch.standbyPublicUrl === "string"
        ? { standbyPublicUrl: normalizeHttpUrl(patch.standbyPublicUrl) }
        : {}),
      ...(typeof patch.syncIntervalMs === "number" && Number.isFinite(patch.syncIntervalMs)
        ? { syncIntervalMs: Math.max(5_000, Math.floor(patch.syncIntervalMs)) }
        : {}),
    };
    this.config = next;
    this.accounts.setStandbyMode(next.role === "standby");
    this.saveConfig(next);
    return next;
  }

  verifyClusterSecret(candidate?: string | null): boolean {
    const provided = (candidate ?? "").trim();
    if (!provided) return false;
    const expected = this.config.clusterSecret;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return NodeCrypto.timingSafeEqual(a, b);
  }

  getPublicSummary(): {
    readonly role: VlClusterRole;
    readonly nodeId: string;
    readonly nodeLabel: string;
    readonly syncRevision: number;
    readonly standbyDirty: boolean;
  } {
    return {
      role: this.config.role,
      nodeId: this.config.nodeId,
      nodeLabel: this.config.nodeLabel,
      syncRevision: this.accounts.getSyncRevision(),
      standbyDirty: this.accounts.isStandbyDirty(),
    };
  }

  getClusterEndpoints(hostHeader?: string | null): VlClusterNodeEndpoint[] {
    const endpoints: VlClusterNodeEndpoint[] = [];
    const seen = new Set<string>();
    const add = (ep: VlClusterNodeEndpoint) => {
      if (!ep.url || seen.has(ep.url)) return;
      seen.add(ep.url);
      endpoints.push(ep);
    };

    const portMatch = hostHeader ? /:(\d{1,5})$/.exec(hostHeader.trim()) : null;
    const port = portMatch?.[1]
      ? Number.parseInt(portMatch[1], 10)
      : Number.parseInt(process.env.VIBELINK_PORT ?? "18990", 10) || 18990;

    if (this.config.role === "primary") {
      const ifaces = NodeOS.networkInterfaces();
      for (const [ifaceName, addrs] of Object.entries(ifaces)) {
        if (!addrs || VIRTUAL_IFACE_RE.test(ifaceName)) continue;
        for (const addr of addrs) {
          if (addr.family !== "IPv4" || addr.internal) continue;
          const ip = addr.address;
          if (ip.startsWith("169.254.") || isTailscaleIp(ip) || !isPrivateLanIp(ip)) continue;
          add({
            id: `ep_primary_lan_${ip.replace(/\./g, "_")}`,
            label: `主服 · 内网 (${ifaceName})`,
            kind: "lan",
            url: `http://${ip}:${port}`,
            serverRole: "primary",
            nodeId: this.config.nodeId,
            priority: 10,
          });
        }
      }
    }

    if (this.config.primaryTailscaleUrl) {
      add({
        id: "ep_primary_tailscale",
        label: "主服 · Tailscale",
        kind: classifyUrlKind(this.config.primaryTailscaleUrl),
        url: this.config.primaryTailscaleUrl,
        serverRole: "primary",
        nodeId: "pc-primary",
        priority: 25,
      });
    }

    if (this.config.primaryPublicUrl) {
      add({
        id: "ep_primary_wan",
        label: "主服 · 公网域名",
        kind: classifyUrlKind(this.config.primaryPublicUrl),
        url: this.config.primaryPublicUrl,
        serverRole: "primary",
        nodeId: "pc-primary",
        priority: 35,
      });
    }

    if (this.config.standbyTailscaleUrl) {
      add({
        id: "ep_standby_tailscale",
        label: "备服 (Mac mini) · Tailscale",
        kind: classifyUrlKind(this.config.standbyTailscaleUrl),
        url: this.config.standbyTailscaleUrl,
        serverRole: "standby",
        nodeId: "macmini-standby",
        priority: 60,
      });
    }

    if (this.config.standbyPublicUrl) {
      add({
        id: "ep_standby_wan",
        label: "备服 (Mac mini) · 公网域名",
        kind: classifyUrlKind(this.config.standbyPublicUrl),
        url: this.config.standbyPublicUrl,
        serverRole: "standby",
        nodeId: "macmini-standby",
        priority: 70,
      });
    }

    return endpoints.sort((a, b) => a.priority - b.priority || a.url.localeCompare(b.url));
  }

  getStatusPayload(hostHeader?: string | null): VlClusterStatusPayload {
    return {
      ok: true,
      role: this.config.role,
      nodeId: this.config.nodeId,
      nodeLabel: this.config.nodeLabel,
      peerUrl: this.config.peerUrl,
      primaryTailscaleUrl: this.config.primaryTailscaleUrl,
      primaryPublicUrl: this.config.primaryPublicUrl,
      standbyTailscaleUrl: this.config.standbyTailscaleUrl,
      standbyPublicUrl: this.config.standbyPublicUrl,
      syncIntervalMs: this.config.syncIntervalMs,
      syncRevision: this.accounts.getSyncRevision(),
      standbyDirty: this.accounts.isStandbyDirty(),
      lastSyncAt: this.lastSyncAt,
      lastSyncOk: this.lastSyncOk,
      lastSyncError: this.lastSyncError,
      peerStatus: this.lastPeerStatus,
      endpoints: this.getClusterEndpoints(hostHeader),
    };
  }

  schedulePushToStandby(): void {
    if (process.env.VIBELINK_DISABLE_CLUSTER_SYNC === "1") return;
    if (this.config.role !== "primary" || !this.config.peerUrl) return;
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
    }
    this.pushDebounceTimer = setTimeout(() => {
      this.pushDebounceTimer = null;
      void this.syncWithPeerNow({ force: false }).catch(() => {});
    }, 1500);
  }

  startBackgroundLoop(): void {
    if (process.env.VIBELINK_DISABLE_CLUSTER_SYNC === "1") return;
    if (!this.config.peerUrl) return;
    if (this.syncTimer) return;

    setTimeout(() => {
      void this.syncWithPeerNow({ force: false }).catch(() => {});
    }, 2000);

    this.syncTimer = setInterval(() => {
      void this.syncWithPeerNow({ force: false }).catch(() => {});
    }, this.config.syncIntervalMs);
  }

  stop(): void {
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
      this.pushDebounceTimer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async syncWithPeerNow(options: { readonly force?: boolean } = {}): Promise<{
    ok: boolean;
    action: string;
    syncRevision: number;
    mergedRows?: number;
    error?: string;
  }> {
    if (!this.config.peerUrl) {
      return {
        ok: false,
        action: "no_peer",
        syncRevision: this.accounts.getSyncRevision(),
        error: "未配置对端节点地址 (peerUrl)",
      };
    }
    if (this.syncing) {
      return {
        ok: true,
        action: "already_syncing",
        syncRevision: this.accounts.getSyncRevision(),
      };
    }

    this.syncing = true;
    const peerBase = this.config.peerUrl;
    const headers = {
      "Content-Type": "application/json",
      "X-VibeLink-Cluster-Secret": this.config.clusterSecret,
    };

    try {
      const started = Date.now();
      const statusResp = await fetch(`${peerBase}/api/vl/cluster/status`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(4000),
      });
      if (!statusResp.ok) {
        throw new Error(`Peer status HTTP ${statusResp.status}`);
      }
      const peerJson = (await statusResp.json()) as {
        role?: VlClusterRole;
        nodeId?: string;
        nodeLabel?: string;
        syncRevision?: number;
        standbyDirty?: boolean;
      };
      this.lastPeerStatus = {
        reachable: true,
        ...(peerJson.role ? { role: peerJson.role } : {}),
        ...(peerJson.nodeId ? { nodeId: peerJson.nodeId } : {}),
        ...(peerJson.nodeLabel ? { nodeLabel: peerJson.nodeLabel } : {}),
        ...(typeof peerJson.syncRevision === "number" ? { syncRevision: peerJson.syncRevision } : {}),
        ...(typeof peerJson.standbyDirty === "boolean" ? { standbyDirty: peerJson.standbyDirty } : {}),
        latencyMs: Math.max(1, Date.now() - started),
      };

      if (this.config.role === "primary") {
        let mergedRows = 0;
        if (peerJson.standbyDirty) {
          const snapResp = await fetch(`${peerBase}/api/vl/cluster/snapshot`, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(6000),
          });
          if (snapResp.ok) {
            const snapBody = (await snapResp.json()) as { snapshot?: VlReplicationSnapshot };
            if (snapBody.snapshot) {
              const merged = this.accounts.mergeStandbyFailoverSnapshot(snapBody.snapshot);
              mergedRows = merged.mergedRows;
            }
          }
        }

        const localSnapshot = this.accounts.exportReplicationSnapshot();
        const pushResp = await fetch(`${peerBase}/api/vl/cluster/replicate`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            force: Boolean(options.force || peerJson.standbyDirty),
            snapshot: localSnapshot,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!pushResp.ok) {
          throw new Error(`Peer replicate HTTP ${pushResp.status}`);
        }

        const pushRes = (await pushResp.json()) as { syncRevision?: number };
        if (typeof pushRes.syncRevision === "number") {
          this.lastPeerStatus = {
            ...this.lastPeerStatus,
            syncRevision: pushRes.syncRevision,
            standbyDirty: false,
          };
        }
        this.lastSyncAt = Date.now();
        this.lastSyncOk = true;
        this.lastSyncError = null;
        return {
          ok: true,
          action: mergedRows > 0 ? "merged_and_pushed" : "pushed",
          syncRevision: localSnapshot.syncRevision,
          mergedRows,
        };
      }

      // Standby role: pull from primary if standby is not holding unmerged dirty writes
      const snapResp = await fetch(`${peerBase}/api/vl/cluster/snapshot`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(6000),
      });
      if (!snapResp.ok) {
        throw new Error(`Primary snapshot HTTP ${snapResp.status}`);
      }
      const snapBody = (await snapResp.json()) as { snapshot?: VlReplicationSnapshot };
      if (!snapBody.snapshot) {
        throw new Error("Primary snapshot payload empty");
      }

      if (this.accounts.isStandbyDirty()) {
        // Trigger primary sync which knows how to merge standby dirty deltas safely
        await fetch(`${peerBase}/api/vl/cluster/replicate-request`, {
          method: "POST",
          headers,
          body: JSON.stringify({ standbySnapshot: this.accounts.exportReplicationSnapshot() }),
          signal: AbortSignal.timeout(8000),
        }).catch(() => {});
      }

      const applied = this.accounts.applyReplicationSnapshot(snapBody.snapshot, {
        force: Boolean(options.force),
      });
      this.lastSyncAt = Date.now();
      this.lastSyncOk = true;
      this.lastSyncError = null;
      return {
        ok: true,
        action: applied.applied ? "pulled" : "up_to_date",
        syncRevision: applied.syncRevision,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastPeerStatus = { reachable: false };
      this.lastSyncAt = Date.now();
      this.lastSyncOk = false;
      this.lastSyncError = msg;
      return {
        ok: false,
        action: "error",
        syncRevision: this.accounts.getSyncRevision(),
        error: msg,
      };
    } finally {
      this.syncing = false;
    }
  }

  async proxyWriteToPrimaryIfOnline(input: {
    readonly method: string;
    readonly pathAndQuery: string;
    readonly headers: Record<string, string | ReadonlyArray<string> | undefined>;
    readonly bodyText?: string;
  }): Promise<
    | { readonly proxied: true; readonly status: number; readonly json: unknown }
    | { readonly proxied: false }
  > {
    if (this.config.role !== "standby" || !this.config.peerUrl) {
      return { proxied: false };
    }
    const forwardHeaders: Record<string, string> = {};
    const auth = input.headers.authorization;
    if (typeof auth === "string" && auth) forwardHeaders.authorization = auth;
    const xTok = input.headers["x-vibelink-token"];
    if (typeof xTok === "string" && xTok) forwardHeaders["x-vibelink-token"] = xTok;
    if (input.bodyText !== undefined && input.method !== "GET") {
      forwardHeaders["content-type"] = "application/json";
    }

    try {
      const res = await fetch(`${this.config.peerUrl}${input.pathAndQuery}`, {
        method: input.method,
        headers: forwardHeaders,
        ...(input.method !== "GET" && input.bodyText ? { body: input.bodyText } : {}),
        signal: AbortSignal.timeout(3000),
      });
      const text = await res.text();
      let parsed: unknown = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }
      // Pull fresh state shortly after forwarding write to Primary
      setTimeout(() => {
        void this.syncWithPeerNow({ force: false }).catch(() => {});
      }, 250);
      return { proxied: true, status: res.status, json: parsed };
    } catch {
      return { proxied: false };
    }
  }
}
