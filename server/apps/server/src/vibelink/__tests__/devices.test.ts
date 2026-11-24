// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { VibeLinkAccountStore } from "../accounts.ts";
import { VibeLinkAuth } from "../auth.ts";
import { BotHomeManager } from "../bots/botHome.ts";
import { runSeedMigration } from "../bots/botMigration.ts";
import { VibeLinkOrchestrationBridge } from "../bridge/orchestrationBridge.ts";
import { VibeLinkTerminalBridge } from "../bridge/terminalBridge.ts";
import { VibeLinkClusterManager } from "../cluster.ts";
import { VibeLinkDatabase } from "../db.ts";
import { VibeLinkDeviceHub } from "../devices.ts";
import { dispatchVibeLinkHttp } from "../http.ts";
import { VibeLinkPluginManager } from "../plugins/pluginManager.ts";
import type { VibeLinkServiceShape } from "../service.ts";

const tempDirs: string[] = [];
const activeServers: NodeHttp.Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const srv of activeServers.splice(0, activeServers.length)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("VibeLinkDeviceHub & /api/vl/devices routes", () => {
  it("registers devices, replaces stale sockets on reconnect, handles RPC roundtrip, and exposes HTTP endpoints", async () => {
    const home = makeTempDir("vibelink-devices-");
    process.env.VIBELINK_DISABLE_CLUSTER_SYNC = "1";
    const db = new VibeLinkDatabase(home);
    const auth = new VibeLinkAuth(home);
    const accounts = new VibeLinkAccountStore(db, home);
    const cluster = new VibeLinkClusterManager(home, accounts);
    const botHome = new BotHomeManager(home);
    runSeedMigration(db, botHome);
    const plugins = new VibeLinkPluginManager(db, botHome, {
      disableBundled: true,
      watchIntervalMs: 0,
    });
    const orchestration = new VibeLinkOrchestrationBridge(db, botHome, null, null, null, plugins);
    const terminal = new VibeLinkTerminalBridge(db, null);
    const devices = new VibeLinkDeviceHub();
    const vl: VibeLinkServiceShape = { db, auth, accounts, cluster, botHome, plugins, orchestration, terminal, devices };

    try {
      const sent1: unknown[] = [];
      const reg1 = devices.registerConnection({
        deviceId: "dev_pjx110",
        name: "OPPO PJX110",
        model: "PJX110",
        manufacturer: "OPPO",
        androidVersion: "15",
        sdkInt: 35,
        appVersion: "3.0.9",
        remoteAddress: "192.168.5.88",
        capabilities: {
          root: false,
          shizukuInstalled: true,
          shizukuRunning: true,
          shizukuGranted: true,
          accessibilityEnabled: true,
          vpnPrepared: true,
          foregroundService: true,
          activeEndpointUrl: "http://192.168.5.2:18990",
        },
        send: (payload) => {
          sent1.push(payload);
          return true;
        },
      });

      const pendingOld = devices.invokeCommand("dev_pjx100_missing", "ui.tree").catch((e) => e);
      expect(await pendingOld).toBeInstanceOf(Error);

      // Simulate reconnect replacing stale connection while an RPC is in flight
      const inFlight = devices.invokeCommand("dev_pjx110", "device.info", {}, 5000).catch((e) => e);
      expect(sent1.length).toBe(1);

      const sent2: unknown[] = [];
      const reg2 = devices.registerConnection({
        deviceId: "dev_pjx110",
        name: "OPPO PJX110",
        model: "PJX110",
        capabilities: {
          accessibilityEnabled: true,
          vpnPrepared: true,
          foregroundService: true,
          activeEndpointUrl: "http://100.98.206.126:18990",
        },
        send: (payload) => {
          sent2.push(payload);
          const frame = payload as { callId: string; command: string; params: Record<string, unknown> };
          queueMicrotask(() => {
            devices.handleCommandResult("dev_pjx110", reg2.connectionId, {
              callId: frame.callId,
              ok: true,
              data: { echoedCommand: frame.command, params: frame.params },
              durationMs: 12,
              capabilities: { activeProxyMode: "vpn_tun", vpnRunning: true, activeProxyUrl: "socks5://100.98.206.126:7898" },
            });
          });
          return true;
        },
      });

      // Stale unregister from old connectionId must be ignored
      devices.unregisterConnection("dev_pjx110", reg1.connectionId);
      expect((await inFlight) instanceof Error).toBe(true);
      expect(devices.listDevices()[0]?.online).toBe(true);

      // HTTP GET /api/vl/devices
      const listResp = await Effect.runPromise(
        dispatchVibeLinkHttp(vl, {
          method: "GET",
          url: "/api/vl/devices",
          headers: { host: "127.0.0.1:18990" },
          remoteAddress: "127.0.0.1",
          bodyText: "",
        }),
      );
      expect(listResp.status).toBe(200);
      expect((listResp.json as { devices: Array<{ deviceId: string }> }).devices).toHaveLength(1);

      // HTTP POST /api/vl/devices/auto/command
      const cmdResp = await Effect.runPromise(
        dispatchVibeLinkHttp(vl, {
          method: "POST",
          url: "/api/vl/devices/auto/command",
          headers: { host: "127.0.0.1:18990" },
          remoteAddress: "127.0.0.1",
          bodyText: JSON.stringify({ command: "ui.tap", params: { x: 100, y: 200 } }),
        }),
      );
      expect(cmdResp.status).toBe(200);
      expect((cmdResp.json as { ok: boolean; data: { echoedCommand: string } })).toMatchObject({
        ok: true,
        data: { echoedCommand: "ui.tap", params: { x: 100, y: 200 } },
      });
      expect(devices.getDevice("dev_pjx110").capabilities.vpnRunning).toBe(true);
    } finally {
      devices.dispose();
      plugins.stop();
      await Effect.runPromise(orchestration.stop());
      db.close();
    }
  });

  it("syncs WProxy endpoint credentials to paired phone over matching channel network", async () => {
    const home = makeTempDir("vibelink-sync-wproxy-");
    const bundledPluginsDir = NodePath.join(home, "bundled-plugins");
    const wproxyPluginDir = NodePath.join(bundledPluginsDir, "wproxy");
    const wproxyRuntimeDir = NodePath.join(home, "wproxy-runtime");
    NodeFS.mkdirSync(wproxyPluginDir, { recursive: true });
    NodeFS.mkdirSync(wproxyRuntimeDir, { recursive: true });

    const realPluginSrc = NodePath.resolve(
      import.meta.dirname,
      "../../../../../../plugins/vibelink-plugin-wproxy",
    );
    NodeFS.cpSync(realPluginSrc, wproxyPluginDir, { recursive: true });

    const server = NodeHttp.createServer((req, res) => {
      if (req.url === "/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "Meta-test" }));
        return;
      }
      if (req.url === "/configs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ mode: "rule", "mixed-port": 7897, tun: { enable: false } }));
        return;
      }
      if (req.url === "/proxies") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ proxies: { PROXY: { now: "HK-01", all: ["HK-01"] } } }));
        return;
      }
      if (req.url === "/connections") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ connections: [], uploadTotal: 0, downloadTotal: 0 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    activeServers.push(server);
    const addr = server.address() as { port: number };

    NodeFS.writeFileSync(
      NodePath.join(wproxyRuntimeDir, "config.ps1"),
      `$MixedPort = 7897\n$ApiPort = ${addr.port}\n$ApiSecret = ''\n`,
      "utf8",
    );
    NodeFS.writeFileSync(
      NodePath.join(wproxyRuntimeDir, "config.yaml"),
      [
        "mixed-port: 7897",
        `external-controller: 127.0.0.1:${addr.port}`,
        "listeners:",
        "  - name: lan-share",
        "    type: mixed",
        "    port: 7898",
        "    listen: 0.0.0.0",
        "    users:",
        "      - username: phone",
        "        password: pw123",
      ].join("\n"),
      "utf8",
    );

    const prevDir = process.env.VIBELINK_WPROXY_DIR;
    process.env.VIBELINK_WPROXY_DIR = wproxyRuntimeDir;

    process.env.VIBELINK_DISABLE_CLUSTER_SYNC = "1";
    const db = new VibeLinkDatabase(home);
    const auth = new VibeLinkAuth(home);
    const accounts = new VibeLinkAccountStore(db, home);
    const cluster = new VibeLinkClusterManager(home, accounts);
    const botHome = new BotHomeManager(home);
    runSeedMigration(db, botHome);
    const plugins = new VibeLinkPluginManager(db, botHome, {
      bundledPluginsDir,
      userPluginsDir: NodePath.join(home, "user-plugins"),
      watchIntervalMs: 0,
    });
    const orchestration = new VibeLinkOrchestrationBridge(db, botHome, null, null, null, plugins);
    const terminal = new VibeLinkTerminalBridge(db, null);
    const devices = new VibeLinkDeviceHub();
    const vl: VibeLinkServiceShape = { db, auth, accounts, cluster, botHome, plugins, orchestration, terminal, devices };

    try {
      await plugins.initialize();
      let appliedPayload: Record<string, unknown> | null = null;
      const status = (await plugins.invokePluginAction("wproxy", "status", {})) as {
        lanShare?: { endpoints?: Array<{ ip: string }> };
      };
      const shareIp = status.lanShare?.endpoints?.[0]?.ip ?? "127.0.0.1";

      const reg = devices.registerConnection({
        deviceId: "dev_wproxy_test",
        name: "Test Phone",
        capabilities: {
          vpnPrepared: true,
          activeEndpointUrl: `http://${shareIp}:18990`,
        },
        send: (payload) => {
          const frame = payload as { callId: string; command: string; params: Record<string, unknown> };
          appliedPayload = frame.params;
          queueMicrotask(() => {
            devices.handleCommandResult("dev_wproxy_test", reg.connectionId, {
              callId: frame.callId,
              ok: true,
              data: { activeProxyMode: "vpn_tun", proxyUrl: frame.params.proxyUrl },
              durationMs: 25,
            });
          });
          return true;
        },
      });

      const syncResp = await Effect.runPromise(
        dispatchVibeLinkHttp(vl, {
          method: "POST",
          url: "/api/vl/devices/dev_wproxy_test/sync-wproxy",
          headers: { host: "127.0.0.1:18990" },
          remoteAddress: "127.0.0.1",
          bodyText: JSON.stringify({ scheme: "socks5", mode: "vpn_tun" }),
        }),
      );
      expect(syncResp.status).toBe(200);
      const syncJson = syncResp.json as { ok: boolean; proxyUrl: string; scheme: string };
      expect(syncJson.ok).toBe(true);
      expect(syncJson.scheme).toBe("socks5");
      expect(syncJson.proxyUrl).toContain(`socks5://phone:pw123@${shareIp}:7898`);
      expect(appliedPayload).toMatchObject({ mode: "vpn_tun", proxyUrl: syncJson.proxyUrl });
    } finally {
      if (prevDir === undefined) delete process.env.VIBELINK_WPROXY_DIR;
      else process.env.VIBELINK_WPROXY_DIR = prevDir;
      devices.dispose();
      plugins.stop();
      await Effect.runPromise(orchestration.stop());
      db.close();
    }
  });

  it("normalizes and pushes merged Mihomo YAML over /api/vl/devices/:id/sync-mihomo while stripping consumed auth-key by default", async () => {
    const home = makeTempDir("vibelink-mihomo-home-");
    const wproxyRuntimeDir = makeTempDir("vibelink-mihomo-wproxy-");
    const sampleMergedYaml = [
      "mixed-port: 7890",
      "proxies:",
      "  - { name: 'tsnode', type: tailscale, hostname: 'phone-clash', auth-key: 'tskey-consumed-old', ephemeral: false, udp: true }",
      "  - { name: 'Japan-MacMini', type: socks5, server: 100.105.59.31, port: 7891, dialer-proxy: 'tsnode' }",
      "proxy-groups:",
      "  - { name: 手动选择, type: select, proxies: [Japan-MacMini, DIRECT] }",
      "rules:",
      "  - MATCH,手动选择",
    ].join("\n");
    NodeFS.writeFileSync(NodePath.join(wproxyRuntimeDir, "cute-merged-private.yaml"), sampleMergedYaml, "utf8");

    const prevDir = process.env.VIBELINK_WPROXY_DIR;
    process.env.VIBELINK_WPROXY_DIR = wproxyRuntimeDir;

    process.env.VIBELINK_DISABLE_CLUSTER_SYNC = "1";
    const db = new VibeLinkDatabase(home);
    const auth = new VibeLinkAuth(home);
    const accounts = new VibeLinkAccountStore(db, home);
    const cluster = new VibeLinkClusterManager(home, accounts);
    const botHome = new BotHomeManager(home);
    runSeedMigration(db, botHome);
    const plugins = new VibeLinkPluginManager(db, botHome, {
      disableBundled: true,
      watchIntervalMs: 0,
    });
    const orchestration = new VibeLinkOrchestrationBridge(db, botHome, null, null, null, plugins);
    const terminal = new VibeLinkTerminalBridge(db, null);
    const devices = new VibeLinkDeviceHub();
    const vl: VibeLinkServiceShape = { db, auth, accounts, cluster, botHome, plugins, orchestration, terminal, devices };

    try {
      let pushedCommand = "";
      let pushedYaml = "";
      const reg = devices.registerConnection({
        deviceId: "dev_mihomo_test",
        name: "PJX110",
        capabilities: {
          vpnPrepared: true,
          mihomoAvailable: true,
        },
        send: (payload) => {
          const frame = payload as { callId: string; command: string; params: Record<string, unknown> };
          pushedCommand = frame.command;
          pushedYaml = String(frame.params.yaml ?? "");
          queueMicrotask(() => {
            devices.handleCommandResult("dev_mihomo_test", reg.connectionId, {
              callId: frame.callId,
              ok: true,
              data: { running: true, version: "v1.19.34" },
              capabilities: {
                activeProxyMode: "mihomo",
                vpnRunning: true,
                mihomoAvailable: true,
                mihomoRunning: true,
                mihomoVersion: "v1.19.34",
                mihomoActiveNode: "Japan-MacMini",
              },
              durationMs: 32,
            });
          });
          return true;
        },
      });

      const resp = await Effect.runPromise(
        dispatchVibeLinkHttp(vl, {
          method: "POST",
          url: "/api/vl/devices/dev_mihomo_test/sync-mihomo",
          headers: { host: "127.0.0.1:18990" },
          remoteAddress: "127.0.0.1",
          bodyText: JSON.stringify({}),
        }),
      );
      expect(resp.status).toBe(200);
      const json = resp.json as { ok: boolean; configName: string; started: boolean };
      expect(json.ok).toBe(true);
      expect(json.configName).toBe("cute-merged-private.yaml");
      expect(json.started).toBe(true);
      expect(pushedCommand).toBe("mihomo.start");
      expect(pushedYaml).toContain("hostname: 'vibelink-phone'");
      expect(pushedYaml).toContain("state-dir: './tailscale'");
      expect(pushedYaml).not.toContain("tskey-consumed-old");
      expect(devices.listDevices()[0]?.capabilities.activeProxyMode).toBe("mihomo");
      expect(devices.listDevices()[0]?.capabilities.mihomoVersion).toBe("v1.19.34");
    } finally {
      if (prevDir === undefined) delete process.env.VIBELINK_WPROXY_DIR;
      else process.env.VIBELINK_WPROXY_DIR = prevDir;
      devices.dispose();
      plugins.stop();
      await Effect.runPromise(orchestration.stop());
      db.close();
    }
  });
});
