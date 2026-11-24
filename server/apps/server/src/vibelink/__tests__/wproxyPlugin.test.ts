// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  collectShareableHosts,
  parseWproxyConfigFiles,
  // @ts-expect-error Pure ESM JS plugin module without .d.ts
} from "../../../../../../plugins/vibelink-plugin-wproxy/index.mjs";
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

async function callRoute(
  vl: VibeLinkServiceShape,
  method: string,
  url: string,
  body?: unknown,
) {
  return Effect.runPromise(
    dispatchVibeLinkHttp(vl, {
      method,
      url,
      headers: { host: "127.0.0.1:18990" },
      remoteAddress: "127.0.0.1",
      bodyText: body !== undefined ? JSON.stringify(body) : "",
    }),
  );
}

afterEach(async () => {
  for (const srv of activeServers.splice(0, activeServers.length)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("VibeLink Built-in WProxy Plugin", () => {
  it("parses wproxy/config.ps1 and wproxy/config.yaml including lan-share without leaking secrets", () => {
    const ps1 = [
      "$WproxyDir = $PSScriptRoot",
      "$MixedPort = 7897",
      "$ApiPort = 9097",
      "$ApiSecret = 'super-secret-token'",
      "$TaskName = 'WProxy'",
    ].join("\n");

    const yaml = [
      "mixed-port: 7897",
      "external-controller: 127.0.0.1:9097",
      "listeners:",
      "  - name: lan-share",
      "    type: mixed",
      "    port: 7898",
      "    listen: 0.0.0.0",
      "    users:",
      "      - username: wproxy",
      "        password: lan-secret-password",
      "proxies:",
      "  - name: DIRECT",
    ].join("\n");

    const parsed = parseWproxyConfigFiles(ps1, yaml);
    expect(parsed.mixedPort).toBe(7897);
    expect(parsed.apiPort).toBe(9097);
    expect(parsed.apiBase).toBe("http://127.0.0.1:9097");
    expect(parsed.apiSecret).toBe("super-secret-token");
    expect(parsed.lanShare).toEqual({
      enabled: true,
      name: "lan-share",
      type: "mixed",
      port: 7898,
      username: "wproxy",
      hasPassword: true,
      password: "lan-secret-password",
    });
  });

  it("collects shareable LAN and Tailscale IPv4 hosts while filtering loopback and virtual switches", () => {
    const hosts = collectShareableHosts({
      "Loopback Pseudo-Interface 1": [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
      "vEthernet (WSL (Hyper-V firewall))": [{ family: "IPv4", internal: false, address: "172.31.176.1" }],
      "vEthernet (Default Switch)": [{ family: "IPv4", internal: false, address: "172.23.48.1" }],
      "本地连接* 1": [{ family: "IPv4", internal: false, address: "169.254.12.34" }],
      Tailscale: [{ family: "IPv4", internal: false, address: "100.98.206.126" }],
      以太网: [{ family: "IPv4", internal: false, address: "192.168.5.2" }],
    });

    expect(hosts).toEqual([
      { kind: "lan", iface: "以太网", ip: "192.168.5.2" },
      { kind: "tailscale", iface: "Tailscale", ip: "100.98.206.126" },
    ]);
  });

  it("integrates wproxy plugin actions over HTTP, uses google generate_204, hides secrets, and keeps bots intact on toggle", async () => {
    const home = makeTempDir("vl-wproxy-home-");
    const bundledPluginsDir = makeTempDir("vl-wproxy-bundled-");
    const mockWproxyDir = makeTempDir("vl-wproxy-mockdir-");

    // Copy real plugins/vibelink-plugin-wproxy into isolated bundled dir (without magpie so seed bots remain baseline)
    const pluginTargetDir = NodePath.join(bundledPluginsDir, "vibelink-plugin-wproxy");
    NodeFS.mkdirSync(pluginTargetDir, { recursive: true });
    for (const file of ["plugin.json", "index.mjs"]) {
      NodeFS.copyFileSync(
        NodePath.join("D:\\AI\\VibeLink\\plugins\\vibelink-plugin-wproxy", file),
        NodePath.join(pluginTargetDir, file),
      );
    }

    const secretToken = "mock_secret_never_leak_999";
    const lanPass = "mock_lan_pass_never_leak_888";

    NodeFS.writeFileSync(
      NodePath.join(mockWproxyDir, "config.ps1"),
      `$MixedPort = 7897\n$ApiPort = 9097\n$ApiSecret = '${secretToken}'\n`,
      "utf8",
    );
    NodeFS.writeFileSync(
      NodePath.join(mockWproxyDir, "config.yaml"),
      [
        "mixed-port: 7897",
        "listeners:",
        "  - name: lan-share",
        "    type: mixed",
        "    port: 7898",
        "    listen: 0.0.0.0",
        "    users:",
        "      - username: wproxy",
        `        password: ${lanPass}`,
      ].join("\n"),
      "utf8",
    );

    let currentNode = "Japan-MacHy2";
    let currentMode = "rule";
    const delayUrlsSeen: string[] = [];
    let reloadedPath = "";

    const server = NodeHttp.createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${secretToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Unauthorized" }));
        return;
      }

      const urlObj = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && urlObj.pathname === "/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ meta: true, version: "v1.19.10-mock" }));
        return;
      }
      if (req.method === "GET" && urlObj.pathname === "/configs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ mode: currentMode, "mixed-port": 7897, tun: { enable: false } }));
        return;
      }
      if (req.method === "PATCH" && urlObj.pathname === "/configs") {
        let body = "";
        req.on("data", (c) => (body += String(c)));
        req.on("end", () => {
          const parsed = JSON.parse(body) as { mode?: string };
          if (parsed.mode) currentMode = parsed.mode;
          res.writeHead(204);
          res.end();
        });
        return;
      }
      if (req.method === "PUT" && urlObj.pathname === "/configs") {
        let body = "";
        req.on("data", (c) => (body += String(c)));
        req.on("end", () => {
          const parsed = JSON.parse(body) as { path?: string };
          reloadedPath = parsed.path ?? "";
          res.writeHead(204);
          res.end();
        });
        return;
      }
      if (req.method === "GET" && urlObj.pathname === "/proxies") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            proxies: {
              PROXY: {
                name: "PROXY",
                type: "Selector",
                now: currentNode,
                all: ["Japan-MacHy2", "Japan-MacMini", "DIRECT"],
              },
              "Japan-MacHy2": {
                name: "Japan-MacHy2",
                type: "Hysteria2",
                alive: true,
                history: [{ delay: 145 }],
              },
              "Japan-MacMini": {
                name: "Japan-MacMini",
                type: "Shadowsocks",
                alive: true,
                history: [{ delay: 220 }],
              },
              DIRECT: {
                name: "DIRECT",
                type: "Direct",
                alive: true,
                history: [],
              },
            },
          }),
        );
        return;
      }
      if (req.method === "GET" && urlObj.pathname === "/proxies/PROXY") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            name: "PROXY",
            type: "Selector",
            now: currentNode,
            all: ["Japan-MacHy2", "Japan-MacMini", "DIRECT"],
          }),
        );
        return;
      }
      if (req.method === "PUT" && urlObj.pathname === "/proxies/PROXY") {
        let body = "";
        req.on("data", (c) => (body += String(c)));
        req.on("end", () => {
          const parsed = JSON.parse(body) as { name?: string };
          if (parsed.name) currentNode = parsed.name;
          res.writeHead(204);
          res.end();
        });
        return;
      }
      if (req.method === "GET" && /^\/proxies\/[^/]+\/delay$/.test(urlObj.pathname)) {
        delayUrlsSeen.push(urlObj.searchParams.get("url") || "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ delay: 168 }));
        return;
      }
      if (req.method === "GET" && urlObj.pathname === "/connections") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ connections: [{ id: "1" }], uploadTotal: 1024, downloadTotal: 4096 }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    activeServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const prevDir = process.env.VIBELINK_WPROXY_DIR;
    const prevBase = process.env.VIBELINK_WPROXY_API_BASE;
    const prevSecret = process.env.VIBELINK_WPROXY_API_SECRET;
    process.env.VIBELINK_WPROXY_DIR = mockWproxyDir;
    process.env.VIBELINK_WPROXY_API_BASE = `http://127.0.0.1:${port}`;
    delete process.env.VIBELINK_WPROXY_API_SECRET;

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

      const listRes = await callRoute(vl, "GET", "/api/vl/plugins");
      expect(listRes.status).toBe(200);
      const listJsonText = JSON.stringify(listRes.json);
      expect(listJsonText).not.toContain(secretToken);
      expect(listJsonText).not.toContain(lanPass);

      const wproxySummary = (
        listRes.json as { plugins: Array<{ id: string; health: { status: string; ok: boolean } }> }
      ).plugins.find((p) => p.id === "wproxy");
      expect(wproxySummary?.health.ok).toBe(true);
      expect(wproxySummary?.health.status).toBe("running");

      const statusRes = await callRoute(vl, "POST", "/api/vl/plugins/wproxy/action", {
        action: "status",
      });
      expect(statusRes.status).toBe(200);
      const statusJsonText = JSON.stringify(statusRes.json);
      expect(statusJsonText).not.toContain(secretToken);
      expect(statusJsonText).not.toContain(lanPass);

      const statusObj = statusRes.json as {
        activeNode: string;
        routeMode: string;
        nodes: Array<{ name: string }>;
        lanShare: { port: number; endpoints: Array<{ ip: string }> };
      };
      expect(statusObj.activeNode).toBe("Japan-MacHy2");
      expect(statusObj.routeMode).toBe("rule");
      expect(statusObj.nodes.map((n) => n.name)).toEqual(["Japan-MacHy2", "Japan-MacMini", "DIRECT"]);

      // Select node
      const selRes = await callRoute(vl, "POST", "/api/vl/plugins/wproxy/action", {
        action: "selectNode",
        payload: { node: "Japan-MacMini" },
      });
      expect(selRes.status).toBe(200);
      expect((selRes.json as { status: { activeNode: string } }).status.activeNode).toBe("Japan-MacMini");

      // Test delay -> strictly uses https://www.google.com/generate_204
      const delayRes = await callRoute(vl, "POST", "/api/vl/plugins/wproxy/action", {
        action: "testDelay",
        payload: { node: "Japan-MacMini" },
      });
      expect(delayRes.status).toBe(200);
      expect((delayRes.json as { delays: Record<string, number> }).delays["Japan-MacMini"]).toBe(168);
      expect(delayUrlsSeen).toEqual(["https://www.google.com/generate_204"]);

      // Set route mode
      const modeRes = await callRoute(vl, "POST", "/api/vl/plugins/wproxy/action", {
        action: "setRouteMode",
        payload: { mode: "global" },
      });
      expect(modeRes.status).toBe(200);
      expect((modeRes.json as { status: { routeMode: string } }).status.routeMode).toBe("global");

      // Reload config
      const reloadRes = await callRoute(vl, "POST", "/api/vl/plugins/wproxy/action", {
        action: "reloadConfig",
      });
      expect(reloadRes.status).toBe(200);
      expect(reloadedPath).toBe(NodePath.join(mockWproxyDir, "config.yaml"));

      // Reject non-host IP on getLanShareUri
      const badIpRes = await callRoute(vl, "POST", "/api/vl/plugins/wproxy/action", {
        action: "getLanShareUri",
        payload: { host: "1.2.3.4", scheme: "http" },
      });
      expect(badIpRes.status).toBe(400);

      // Valid host IP from collectShareableHosts(os.networkInterfaces()) works if available
      const firstShareIp = statusObj.lanShare.endpoints[0]?.ip;
      if (firstShareIp) {
        const uriRes = await callRoute(vl, "POST", "/api/vl/plugins/wproxy/action", {
          action: "getLanShareUri",
          payload: { host: firstShareIp, scheme: "socks5" },
        });
        expect(uriRes.status).toBe(200);
        expect((uriRes.json as { uri: string }).uri).toBe(
          `socks5://wproxy:${lanPass}@${firstShareIp}:7898`,
        );
      }

      // Disabling wproxy must NOT hide/alter any visible bots
      const beforeBots = db.listAccounts("bot").map((b) => b.id);
      const toggleRes = await callRoute(vl, "POST", "/api/vl/plugins/wproxy/toggle", {
        enabled: false,
      });
      expect(toggleRes.status).toBe(200);
      const afterBots = db.listAccounts("bot").map((b) => b.id);
      expect(afterBots).toEqual(beforeBots);
      expect(afterBots).toHaveLength(4);
    } finally {
      plugins.stop();
      await Effect.runPromise(orchestration.stop());
      db.close();
      if (prevDir === undefined) delete process.env.VIBELINK_WPROXY_DIR;
      else process.env.VIBELINK_WPROXY_DIR = prevDir;
      if (prevBase === undefined) delete process.env.VIBELINK_WPROXY_API_BASE;
      else process.env.VIBELINK_WPROXY_API_BASE = prevBase;
      if (prevSecret === undefined) delete process.env.VIBELINK_WPROXY_API_SECRET;
      else process.env.VIBELINK_WPROXY_API_SECRET = prevSecret;
    }
  });
});
