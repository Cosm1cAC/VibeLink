// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
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

function createTestService() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vibelink-pairing-"));
  tempDirs.push(home);
  process.env.VIBELINK_MOCK_BOTS = "1";
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
  return {
    vl,
    async cleanup() {
      devices.dispose();
      plugins.stop();
      await Effect.runPromise(orchestration.stop());
      db.close();
      delete process.env.VIBELINK_MOCK_BOTS;
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

async function callRoute(
  vl: VibeLinkServiceShape,
  method: string,
  url: string,
  opts?: { bodyText?: string; headers?: Record<string, string>; remoteAddress?: string },
) {
  return Effect.runPromise(
    dispatchVibeLinkHttp(vl, {
      method,
      url,
      headers: { host: "192.168.5.2:18990", ...(opts?.headers ?? {}) },
      remoteAddress: opts?.remoteAddress ?? "127.0.0.1",
      ...(opts?.bodyText !== undefined ? { bodyText: opts.bodyText } : {}),
    }),
  );
}

describe("VibeLink Pairing & Speedtest HTTP routes", () => {
  it("returns pairing info and valid qrPayload", async () => {
    const { vl, cleanup } = createTestService();
    try {
      const resp = await callRoute(vl, "GET", "/api/vl/pairing/info");
      expect(resp.status).toBe(200);
      const data = resp.json as {
        ok: boolean;
        hostName: string;
        port: number;
        token: string;
        endpoints: Array<{ label: string; kind: string; url: string }>;
        qrPayload: string;
      };
      expect(data.ok).toBe(true);
      expect(data.port).toBe(18990);
      expect(data.token).toBe(vl.auth.token);
      expect(Array.isArray(data.endpoints)).toBe(true);
      const parsedQr = JSON.parse(data.qrPayload) as { t: string; v: number; k: string; e: unknown[] };
      expect(parsedQr.t).toBe("vl-pair");
      expect(parsedQr.v).toBe(1);
      expect(parsedQr.k).toBe(vl.auth.token);
      expect(parsedQr.e.length).toBe(data.endpoints.length);
    } finally {
      await cleanup();
    }
  });

  it("persists customExternalUrl via POST /api/vl/pairing/config", async () => {
    const { vl, cleanup } = createTestService();
    try {
      const resp = await callRoute(vl, "POST", "/api/vl/pairing/config", {
        bodyText: JSON.stringify({ customExternalUrl: "https://vibelink.example.com:8443/" }),
      });
      expect(resp.status).toBe(200);
      const data = resp.json as {
        customExternalUrl: string;
        endpoints: Array<{ kind: string; url: string }>;
        qrPayload: string;
      };
      expect(data.customExternalUrl).toBe("https://vibelink.example.com:8443");
      expect(data.endpoints.some((e) => e.kind === "wan" && e.url === "https://vibelink.example.com:8443")).toBe(
        true,
      );
      expect(data.qrPayload).toContain("https://vibelink.example.com:8443");
    } finally {
      await cleanup();
    }
  });

  it("handles speedtest ping, download binary payload, upload size check, and rejects unauthenticated remote calls", async () => {
    const { vl, cleanup } = createTestService();
    try {
      const pingResp = await callRoute(vl, "GET", "/api/vl/speedtest/ping");
      expect(pingResp.status).toBe(200);
      expect((pingResp.json as { ok: boolean; service: string }).service).toBe("vibelink");

      const dlResp = await callRoute(vl, "GET", "/api/vl/speedtest/download?bytes=65536");
      expect(dlResp.status).toBe(200);
      expect(dlResp.binary?.contentType).toBe("application/octet-stream");
      expect(dlResp.binary?.bytes.byteLength).toBe(65536);

      const uploadPayload = "X".repeat(32768);
      const ulResp = await callRoute(vl, "POST", "/api/vl/speedtest/upload", {
        bodyText: uploadPayload,
        headers: { "content-type": "text/plain" },
      });
      expect(ulResp.status).toBe(200);
      expect((ulResp.json as { receivedBytes: number }).receivedBytes).toBe(32768);

      const unauth = await callRoute(vl, "GET", "/api/vl/speedtest/ping", {
        remoteAddress: "192.168.5.4",
      });
      expect(unauth.status).toBe(401);
    } finally {
      await cleanup();
    }
  });
});
