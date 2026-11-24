// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { VibeLinkPluginManager } from "./plugins/pluginManager.ts";
import { VibeLinkError } from "./types.ts";

export interface VlDeviceCapabilities {
  readonly root: boolean;
  readonly shizukuInstalled: boolean;
  readonly shizukuRunning: boolean;
  readonly shizukuGranted: boolean;
  readonly accessibilityEnabled: boolean;
  readonly vpnPrepared: boolean;
  readonly vpnRunning: boolean;
  readonly otherVpnActive: boolean;
  readonly foregroundService: boolean;
  readonly batteryOptimizationIgnored: boolean;
  readonly activeProxyMode: "off" | "vpn_tun" | "vpn_http" | "system_proxy" | "mihomo";
  readonly activeProxyUrl: string | null;
  readonly systemHttpProxy: string | null;
  readonly activeEndpointUrl: string | null;
  readonly mihomoAvailable?: boolean;
  readonly mihomoRunning?: boolean;
  readonly mihomoVersion?: string | null;
  readonly mihomoActiveNode?: string | null;
  readonly mihomoTailscaleLoginUrl?: string | null;
  readonly mihomoHasConfig?: boolean;
}

export interface VlConnectedDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly model: string;
  readonly manufacturer: string;
  readonly androidVersion: string;
  readonly sdkInt: number;
  readonly appVersion: string;
  readonly online: boolean;
  readonly connectedAt: number;
  readonly lastSeenAt: number;
  readonly remoteAddress: string | null;
  readonly capabilities: VlDeviceCapabilities;
}

export interface VlDeviceCommandResult {
  readonly callId: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly durationMs: number;
}

interface PendingRpc {
  readonly callId: string;
  readonly command: string;
  readonly resolve: (value: VlDeviceCommandResult) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface DeviceRecord {
  device: VlConnectedDevice;
  connectionId: string | null;
  send: ((payload: unknown) => boolean) | null;
  pending: Map<string, PendingRpc>;
}

export const DEFAULT_DEVICE_CAPABILITIES: VlDeviceCapabilities = {
  root: false,
  shizukuInstalled: false,
  shizukuRunning: false,
  shizukuGranted: false,
  accessibilityEnabled: false,
  vpnPrepared: false,
  vpnRunning: false,
  otherVpnActive: false,
  foregroundService: false,
  batteryOptimizationIgnored: false,
  activeProxyMode: "off",
  activeProxyUrl: null,
  systemHttpProxy: null,
  activeEndpointUrl: null,
  mihomoAvailable: false,
  mihomoRunning: false,
  mihomoVersion: null,
  mihomoActiveNode: null,
  mihomoTailscaleLoginUrl: null,
  mihomoHasConfig: false,
};

function sanitizeCapabilities(raw?: Partial<VlDeviceCapabilities> | null): VlDeviceCapabilities {
  const modeRaw = raw?.activeProxyMode;
  const activeProxyMode =
    modeRaw === "vpn_tun" || modeRaw === "vpn_http" || modeRaw === "system_proxy" || modeRaw === "mihomo"
      ? modeRaw
      : "off";
  return {
    root: Boolean(raw?.root),
    shizukuInstalled: Boolean(raw?.shizukuInstalled),
    shizukuRunning: Boolean(raw?.shizukuRunning),
    shizukuGranted: Boolean(raw?.shizukuGranted),
    accessibilityEnabled: Boolean(raw?.accessibilityEnabled),
    vpnPrepared: Boolean(raw?.vpnPrepared),
    vpnRunning: Boolean(raw?.vpnRunning),
    otherVpnActive: Boolean(raw?.otherVpnActive),
    foregroundService: Boolean(raw?.foregroundService),
    batteryOptimizationIgnored: Boolean(raw?.batteryOptimizationIgnored),
    activeProxyMode,
    activeProxyUrl:
      typeof raw?.activeProxyUrl === "string" && raw.activeProxyUrl.trim()
        ? raw.activeProxyUrl.trim()
        : null,
    systemHttpProxy:
      typeof raw?.systemHttpProxy === "string" && raw.systemHttpProxy.trim()
        ? raw.systemHttpProxy.trim()
        : null,
    activeEndpointUrl:
      typeof raw?.activeEndpointUrl === "string" && raw.activeEndpointUrl.trim()
        ? raw.activeEndpointUrl.trim()
        : null,
    mihomoAvailable: Boolean(raw?.mihomoAvailable),
    mihomoRunning: Boolean(raw?.mihomoRunning),
    mihomoVersion:
      typeof raw?.mihomoVersion === "string" && raw.mihomoVersion.trim()
        ? raw.mihomoVersion.trim()
        : null,
    mihomoActiveNode:
      typeof raw?.mihomoActiveNode === "string" && raw.mihomoActiveNode.trim()
        ? raw.mihomoActiveNode.trim()
        : null,
    mihomoTailscaleLoginUrl:
      typeof raw?.mihomoTailscaleLoginUrl === "string" && raw.mihomoTailscaleLoginUrl.trim()
        ? raw.mihomoTailscaleLoginUrl.trim()
        : null,
    mihomoHasConfig: Boolean(raw?.mihomoHasConfig),
  };
}

export interface RegisterDeviceInput {
  readonly deviceId: string;
  readonly name?: string;
  readonly model?: string;
  readonly manufacturer?: string;
  readonly androidVersion?: string;
  readonly sdkInt?: number;
  readonly appVersion?: string;
  readonly remoteAddress?: string | null;
  readonly capabilities?: Partial<VlDeviceCapabilities> | null;
  readonly send: (payload: unknown) => boolean;
}

export interface SyncWProxyDeviceOptions {
  readonly scheme?: "socks5" | "http";
  readonly mode?: "auto" | "vpn_tun" | "vpn_http" | "system_proxy";
  readonly host?: string;
  readonly dnsMode?: "over_tcp" | "virtual" | "direct";
}

export interface SyncWProxyDeviceResult {
  readonly ok: boolean;
  readonly deviceId: string;
  readonly proxyUrl: string;
  readonly host: string;
  readonly scheme: "socks5" | "http";
  readonly result: VlDeviceCommandResult;
}

export interface PushMihomoConfigOptions {
  readonly yaml?: string;
  readonly configName?: string;
  readonly tailscaleAuthKey?: string;
  readonly hostname?: string;
  readonly resetTailscaleState?: boolean;
  readonly start?: boolean;
}

export interface PushMihomoConfigResult {
  readonly ok: boolean;
  readonly deviceId: string;
  readonly configName: string;
  readonly sourcePath: string | null;
  readonly bytes: number;
  readonly started: boolean;
  readonly result: VlDeviceCommandResult;
}

function normalizeMihomoTailscaleYaml(
  rawYaml: string,
  options: { readonly tailscaleAuthKey?: string; readonly hostname?: string },
): string {
  const cleanKey = options.tailscaleAuthKey?.trim();
  const cleanHost = options.hostname?.trim() || "vibelink-phone";
  const lines = rawYaml.replace(/^\uFEFF/, "").split(/\r?\n/);
  const eol = rawYaml.includes("\r\n") ? "\r\n" : "\n";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim().startsWith("- {") || !/\btype\s*:\s*['"]?tailscale['"]?\b/.test(line)) {
      continue;
    }
    let updated = line.replace(/\bhostname\s*:\s*[^,}]+/, `hostname: '${cleanHost}'`);
    if (/\bstate-dir\s*:/.test(updated)) {
      updated = updated.replace(/\bstate-dir\s*:\s*[^,}]+/, "state-dir: './tailscale'");
    } else {
      updated = updated.replace(/\s*\}\s*$/, ", state-dir: './tailscale' }");
    }
    updated = updated
      .replace(/,\s*auth-key\s*:\s*[^,}]+/g, "")
      .replace(/\bauth-key\s*:\s*[^,}]+,\s*/g, "");
    if (cleanKey) {
      updated = updated.replace(/\s*\}\s*$/, `, auth-key: '${cleanKey}' }`);
    }
    lines[i] = updated;
  }

  return lines.join(eol);
}

function rejectPendingMap(pending: Map<string, PendingRpc>, reason: string): void {
  for (const rpc of pending.values()) {
    clearTimeout(rpc.timer);
    rpc.reject(new VibeLinkError({ message: reason }));
  }
  pending.clear();
}

function pickBestShareableHost(
  activeEndpointUrl: string | null,
  endpoints: ReadonlyArray<{ readonly kind?: string; readonly ip: string }>,
  explicitHost?: string,
): { host: string; useEndpointHostAlias: string | null } {
  const cleanExplicit = explicitHost?.trim();
  if (cleanExplicit) {
    return { host: cleanExplicit, useEndpointHostAlias: null };
  }

  let endpointHost: string | null = null;
  if (activeEndpointUrl) {
    try {
      endpointHost = new URL(activeEndpointUrl).hostname;
    } catch {
      endpointHost = null;
    }
  }

  if (endpointHost) {
    const exact = endpoints.find((ep) => ep.ip === endpointHost);
    if (exact) {
      return { host: exact.ip, useEndpointHostAlias: null };
    }
    if (endpointHost === "10.0.2.2" || endpointHost === "127.0.0.1") {
      const lanFirst = endpoints.find((ep) => ep.kind === "lan") ?? endpoints[0];
      if (lanFirst) {
        return { host: lanFirst.ip, useEndpointHostAlias: endpointHost };
      }
      return { host: endpointHost, useEndpointHostAlias: null };
    }
  }

  const lan = endpoints.find((ep) => ep.kind === "lan");
  if (lan) return { host: lan.ip, useEndpointHostAlias: null };
  const ts = endpoints.find((ep) => ep.kind === "tailscale");
  if (ts) return { host: ts.ip, useEndpointHostAlias: null };
  if (endpoints[0]) return { host: endpoints[0].ip, useEndpointHostAlias: null };
  if (endpointHost) return { host: endpointHost, useEndpointHostAlias: null };
  throw new VibeLinkError({
    message: "未发现可共享给手机的宿主机 IP 地址，请检查局域网或 Tailscale 状态",
  });
}

const DEVICE_HEARTBEAT_STALE_MS = 75_000;

export class VibeLinkDeviceHub {
  private readonly records = new Map<string, DeviceRecord>();

  private expireIfStale(rec: DeviceRecord, now = Date.now()): void {
    if (rec.device.online && rec.connectionId && now - rec.device.lastSeenAt > DEVICE_HEARTBEAT_STALE_MS) {
      this.unregisterConnection(rec.device.deviceId, rec.connectionId);
    }
  }

  registerConnection(input: RegisterDeviceInput): {
    readonly connectionId: string;
    readonly device: VlConnectedDevice;
  } {
    const deviceId = input.deviceId.trim();
    if (!deviceId) {
      throw new VibeLinkError({ message: "Device id cannot be empty" });
    }
    const existing = this.records.get(deviceId);
    if (existing) {
      rejectPendingMap(
        existing.pending,
        `Device ${deviceId} reconnected with a newer control socket`,
      );
    }

    const now = Date.now();
    const connectionId = `devconn_${NodeCrypto.randomUUID().slice(0, 12)}`;
    const device: VlConnectedDevice = {
      deviceId,
      name: input.name?.trim() || input.model?.trim() || "Android 设备",
      model: input.model?.trim() || "Android",
      manufacturer: input.manufacturer?.trim() || "",
      androidVersion: input.androidVersion?.trim() || "",
      sdkInt: typeof input.sdkInt === "number" && Number.isFinite(input.sdkInt) ? input.sdkInt : 0,
      appVersion: input.appVersion?.trim() || "",
      online: true,
      connectedAt: now,
      lastSeenAt: now,
      remoteAddress: input.remoteAddress ?? null,
      capabilities: sanitizeCapabilities(input.capabilities),
    };

    this.records.set(deviceId, {
      device,
      connectionId,
      send: input.send,
      pending: new Map(),
    });

    return { connectionId, device };
  }

  unregisterConnection(deviceId: string, connectionId?: string): void {
    const rec = this.records.get(deviceId);
    if (!rec) return;
    if (connectionId && rec.connectionId !== connectionId) {
      return;
    }
    rejectPendingMap(rec.pending, `Device ${deviceId} disconnected`);
    rec.connectionId = null;
    rec.send = null;
    rec.device = {
      ...rec.device,
      online: false,
      lastSeenAt: Date.now(),
    };
  }

  updateHeartbeat(
    deviceId: string,
    connectionId: string,
    capabilities?: Partial<VlDeviceCapabilities> | null,
  ): VlConnectedDevice | null {
    const rec = this.records.get(deviceId);
    if (!rec || rec.connectionId !== connectionId) return null;
    rec.device = {
      ...rec.device,
      online: true,
      lastSeenAt: Date.now(),
      ...(capabilities
        ? {
            capabilities: sanitizeCapabilities({
              ...rec.device.capabilities,
              ...capabilities,
            }),
          }
        : {}),
    };
    return rec.device;
  }

  handleCommandResult(
    deviceId: string,
    connectionId: string,
    result: {
      readonly callId: string;
      readonly ok: boolean;
      readonly data?: unknown;
      readonly error?: string;
      readonly durationMs?: number;
      readonly capabilities?: Partial<VlDeviceCapabilities> | null;
    },
  ): boolean {
    const rec = this.records.get(deviceId);
    if (!rec || rec.connectionId !== connectionId) return false;
    if (result.capabilities) {
      rec.device = {
        ...rec.device,
        lastSeenAt: Date.now(),
        capabilities: sanitizeCapabilities({
          ...rec.device.capabilities,
          ...result.capabilities,
        }),
      };
    } else {
      rec.device = {
        ...rec.device,
        lastSeenAt: Date.now(),
      };
    }

    const rpc = rec.pending.get(result.callId);
    if (!rpc) return false;
    rec.pending.delete(result.callId);
    clearTimeout(rpc.timer);

    const payload: VlDeviceCommandResult = {
      callId: result.callId,
      ok: Boolean(result.ok),
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.error ? { error: result.error } : {}),
      durationMs:
        typeof result.durationMs === "number" && Number.isFinite(result.durationMs)
          ? result.durationMs
          : 0,
    };
    rpc.resolve(payload);
    return true;
  }

  listDevices(): ReadonlyArray<VlConnectedDevice> {
    const now = Date.now();
    for (const r of this.records.values()) {
      this.expireIfStale(r, now);
    }
    return Array.from(this.records.values())
      .map((r) => r.device)
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return b.lastSeenAt - a.lastSeenAt;
      });
  }

  getDevice(deviceId?: string | null): VlConnectedDevice {
    const cleanId = deviceId?.trim();
    const now = Date.now();
    if (cleanId && cleanId !== "auto") {
      const rec = this.records.get(cleanId);
      if (!rec) {
        throw new VibeLinkError({ message: `Device not found: ${cleanId}` });
      }
      this.expireIfStale(rec, now);
      if (!rec.device.online || !rec.send) {
        throw new VibeLinkError({ message: `Device is offline: ${rec.device.name} (${cleanId})` });
      }
      return rec.device;
    }

    const online = this.listDevices().filter((d) => d.online);
    const first = online[0];
    if (!first) {
      throw new VibeLinkError({
        message: "没有在线的已配对 Android 设备，请先在手机 VibeLink 确认后台控机服务在线",
      });
    }
    return first;
  }

  async invokeCommand(
    deviceId: string | null | undefined,
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = 20_000,
  ): Promise<VlDeviceCommandResult> {
    const cleanCommand = command.trim();
    if (!cleanCommand) {
      throw new VibeLinkError({ message: "Device command name is required" });
    }

    const target = this.getDevice(deviceId);
    const rec = this.records.get(target.deviceId);
    if (!rec || !rec.send || !rec.device.online) {
      throw new VibeLinkError({ message: `Device is offline: ${target.deviceId}` });
    }

    const boundedTimeout = Math.max(1_000, Math.min(120_000, Math.floor(timeoutMs)));
    const callId = `dcmd_${NodeCrypto.randomUUID().slice(0, 12)}`;

    return new Promise<VlDeviceCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        rec.pending.delete(callId);
        reject(
          new VibeLinkError({
            message: `Device command "${cleanCommand}" timed out after ${boundedTimeout}ms`,
          }),
        );
      }, boundedTimeout);

      rec.pending.set(callId, {
        callId,
        command: cleanCommand,
        resolve,
        reject,
        timer,
      });

      const sent = rec.send!({
        type: "invoke",
        callId,
        command: cleanCommand,
        params,
        timeoutMs: boundedTimeout,
      });

      if (!sent) {
        rec.pending.delete(callId);
        clearTimeout(timer);
        reject(
          new VibeLinkError({
            message: `Failed to enqueue command "${cleanCommand}" to device ${target.deviceId}`,
          }),
        );
      }
    });
  }

  async syncWProxyToDevice(
    plugins: VibeLinkPluginManager,
    deviceId: string | null | undefined,
    options: SyncWProxyDeviceOptions = {},
  ): Promise<SyncWProxyDeviceResult> {
    const device = this.getDevice(deviceId);
    const scheme: "socks5" | "http" = options.scheme === "http" ? "http" : "socks5";
    const status = (await plugins.invokePluginAction("wproxy", "status", {})) as {
      running?: boolean;
      localProxy?: { host?: string; port?: number };
      lanShare?: {
        enabled?: boolean;
        port?: number;
        endpoints?: Array<{ kind?: string; iface?: string; ip: string }>;
      };
    };

    if (!status?.running) {
      throw new VibeLinkError({ message: "WProxy 未运行，请先在电脑端启动 WProxy 代理核心" });
    }

    const endpoints = Array.isArray(status.lanShare?.endpoints) ? status.lanShare.endpoints : [];
    const { host, useEndpointHostAlias } = pickBestShareableHost(
      device.capabilities.activeEndpointUrl,
      endpoints,
      options.host,
    );

    let proxyUrl: string;
    let resolvedHost = useEndpointHostAlias ?? host;

    if (status.lanShare?.enabled && status.lanShare.port) {
      if (endpoints.some((ep) => ep.ip === host)) {
        const share = (await plugins.invokePluginAction("wproxy", "getLanShareUri", {
          host,
          scheme,
        })) as { uri: string };
        const parsed = new URL(share.uri);
        if (useEndpointHostAlias) {
          parsed.hostname = useEndpointHostAlias;
        }
        proxyUrl = parsed.toString().replace(/\/$/, "");
      } else {
        proxyUrl = `${scheme}://${resolvedHost}:${status.lanShare.port}`;
      }
    } else {
      const port = Number(status.localProxy?.port || 7897);
      proxyUrl = `${scheme}://${resolvedHost}:${port}`;
    }

    const result = await this.invokeCommand(
      device.deviceId,
      "proxy.apply",
      {
        mode: options.mode ?? "auto",
        proxyUrl,
        dnsMode: options.dnsMode ?? "over_tcp",
      },
      25_000,
    );

    if (!result.ok) {
      throw new VibeLinkError({
        message: result.error || "手机端应用 WProxy 代理配置失败",
      });
    }

    return {
      ok: true,
      deviceId: device.deviceId,
      proxyUrl,
      host: resolvedHost,
      scheme,
      result,
    };
  }

  async resolveMobileMihomoConfig(
    plugins: VibeLinkPluginManager,
    options: PushMihomoConfigOptions = {},
  ): Promise<{ readonly yaml: string; readonly configName: string; readonly sourcePath: string | null }> {
    const cleanOverride = options.yaml?.trim();
    if (cleanOverride) {
      const normalized = normalizeMihomoTailscaleYaml(cleanOverride, {
        ...(options.tailscaleAuthKey ? { tailscaleAuthKey: options.tailscaleAuthKey } : {}),
        ...(options.hostname ? { hostname: options.hostname } : {}),
      });
      return {
        yaml: normalized,
        configName: options.configName?.trim() || "custom-mihomo.yaml",
        sourcePath: null,
      };
    }

    let wproxyDir: string | null = null;
    try {
      const status = (await plugins.invokePluginAction("wproxy", "status", {})) as {
        wproxyDir?: string;
      };
      if (typeof status?.wproxyDir === "string" && status.wproxyDir.trim()) {
        wproxyDir = status.wproxyDir.trim();
      }
    } catch {
      // Fallback to env/cwd candidates when wproxy plugin is disabled or unavailable in tests
    }

    const candidates = [
      wproxyDir ? NodePath.join(wproxyDir, "cute-merged-private.yaml") : null,
      wproxyDir ? NodePath.join(wproxyDir, "providers", "cute.yaml") : null,
      process.env.VIBELINK_WPROXY_DIR
        ? NodePath.join(process.env.VIBELINK_WPROXY_DIR, "cute-merged-private.yaml")
        : null,
      NodePath.resolve(process.cwd(), "wproxy", "cute-merged-private.yaml"),
      NodePath.resolve(process.cwd(), "..", "..", "wproxy", "cute-merged-private.yaml"),
    ].filter((v): v is string => Boolean(v));

    const foundPath = candidates.find((p) => {
      try {
        return NodeFS.statSync(p).isFile();
      } catch {
        return false;
      }
    });

    if (!foundPath) {
      throw new VibeLinkError({
        message: "未找到手机端 Mihomo 合并配置（cute-merged-private.yaml），请先生成或直接传入 yaml 内容",
      });
    }

    const raw = NodeFS.readFileSync(foundPath, "utf8");
    const normalized = normalizeMihomoTailscaleYaml(raw, {
      ...(options.tailscaleAuthKey ? { tailscaleAuthKey: options.tailscaleAuthKey } : {}),
      ...(options.hostname ? { hostname: options.hostname } : {}),
    });
    return {
      yaml: normalized,
      configName: options.configName?.trim() || NodePath.basename(foundPath),
      sourcePath: foundPath,
    };
  }

  async pushMihomoConfigToDevice(
    plugins: VibeLinkPluginManager,
    deviceId: string | null | undefined,
    options: PushMihomoConfigOptions = {},
  ): Promise<PushMihomoConfigResult> {
    const device = this.getDevice(deviceId);
    const { yaml, configName, sourcePath } = await this.resolveMobileMihomoConfig(plugins, options);
    const shouldStart = options.start !== false;
    const command = shouldStart ? "mihomo.start" : "mihomo.apply_config";
    const result = await this.invokeCommand(
      device.deviceId,
      command,
      {
        yaml,
        configName,
        resetTailscaleState: Boolean(options.resetTailscaleState),
        start: shouldStart,
      },
      35_000,
    );

    if (!result.ok) {
      throw new VibeLinkError({
        message: result.error || "手机端应用并启动内置 Mihomo 配置失败",
      });
    }

    return {
      ok: true,
      deviceId: device.deviceId,
      configName,
      sourcePath,
      bytes: Buffer.byteLength(yaml, "utf8"),
      started: shouldStart,
      result,
    };
  }

  dispose(): void {
    for (const rec of this.records.values()) {
      rejectPendingMap(rec.pending, "VibeLinkDeviceHub disposed");
      rec.send = null;
      rec.connectionId = null;
    }
    this.records.clear();
  }
}
