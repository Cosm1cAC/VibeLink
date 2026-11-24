// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { VibeLinkAccountStore } from "./accounts.ts";
import { dispatchAccountAndClusterHttp, resolveAuthContext } from "./accountRoutes.ts";
import { VibeLinkAuth } from "./auth.ts";
import { VibeLinkClusterManager } from "./cluster.ts";
import { VibeLinkDatabase } from "./db.ts";
import { buildPairingInfo, getSpeedTestPayload } from "./pairing.ts";

export interface StandbyRuntime {
  readonly db: VibeLinkDatabase;
  readonly auth: VibeLinkAuth;
  readonly accounts: VibeLinkAccountStore;
  readonly cluster: VibeLinkClusterManager;
  readonly server: NodeHttp.Server;
  readonly port: number;
  readonly close: () => Promise<void>;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, x-vibelink-token, x-vibelink-cluster-secret, x-api-key, anthropic-version, anthropic-beta, content-type",
  "access-control-max-age": "600",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const LARGE_ROUTE_MAX_BODY_BYTES = 12 * 1024 * 1024;

class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Request body exceeds ${limitBytes} byte limit`);
  }
}

function sendJson(res: NodeHttp.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readRequestBody(req: NodeHttp.IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settled = true;
        req.pause();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

export async function startStandbyServer(options: {
  readonly homeDir?: string;
  readonly host?: string;
  readonly port?: number;
  readonly disableSyncLoop?: boolean;
} = {}): Promise<StandbyRuntime> {
  const db = new VibeLinkDatabase(options.homeDir);
  const auth = new VibeLinkAuth(db.homeDir);
  const accounts = new VibeLinkAccountStore(db, db.homeDir);
  const cluster = new VibeLinkClusterManager(db.homeDir, accounts);
  if (!options.disableSyncLoop) {
    cluster.startBackgroundLoop();
  }

  const server = NodeHttp.createServer(async (req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const rawUrl = req.url || "/";
    const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
    const pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";
    const headers = req.headers as Record<string, string | ReadonlyArray<string> | undefined>;
    const remoteAddress = req.socket?.remoteAddress ?? null;

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (method === "GET" && pathname === "/api/vl/health") {
      sendJson(res, 200, {
        ok: true,
        service: "vibelink",
        version: 3,
        standby: true,
        mockBots: false,
        botsCount: 0,
        roomsCount: 0,
        latestSeq: 0,
        cluster: cluster.getPublicSummary(),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/vl/speedtest/ping") {
      sendJson(res, 200, { ok: true, service: "vibelink", standby: true, serverTime: Date.now() });
      return;
    }

    if (method === "GET" && pathname === "/api/vl/speedtest/download") {
      const bytesParam = Number.parseInt(parsedUrl.searchParams.get("bytes") ?? "", 10);
      const payload = getSpeedTestPayload(Number.isFinite(bytesParam) ? bytesParam : undefined);
      res.writeHead(200, {
        ...CORS_HEADERS,
        "content-type": "application/octet-stream",
        "cache-control": "private, no-store",
      });
      res.end(payload);
      return;
    }

    let bodyText = "";
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const maxBytes =
        pathname.startsWith("/api/vl/cluster/") || pathname === "/api/vl/speedtest/upload"
          ? LARGE_ROUTE_MAX_BODY_BYTES
          : DEFAULT_MAX_BODY_BYTES;
      try {
        bodyText = await readRequestBody(req, maxBytes);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: "payload_too_large", message: "Request body exceeds size limit" });
          return;
        }
        sendJson(res, 400, { error: "invalid_body", message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    if (method === "POST" && pathname === "/api/vl/speedtest/upload") {
      sendJson(res, 200, {
        ok: true,
        receivedBytes: Buffer.byteLength(bodyText, "utf8"),
        serverTime: Date.now(),
      });
      return;
    }

    const handled = await dispatchAccountAndClusterHttp(
      { auth, accounts, cluster },
      {
        method,
        url: rawUrl,
        headers,
        remoteAddress,
        bodyText,
      },
    );
    if (handled !== null) {
      if (handled.rawText) {
        res.writeHead(handled.status, {
          ...CORS_HEADERS,
          "content-type": handled.rawText.contentType,
          "cache-control": "no-store",
        });
        res.end(handled.rawText.body);
        return;
      }
      if (handled.json !== undefined) {
        sendJson(res, handled.status, handled.json);
        return;
      }
      res.writeHead(handled.status, CORS_HEADERS);
      res.end();
      return;
    }

    const authCtx = resolveAuthContext(auth, accounts, {
      headers,
      queryToken: parsedUrl.searchParams.get("token"),
      remoteAddress,
    });
    if (!authCtx) {
      sendJson(res, 401, { error: "unauthorized", message: "Valid VibeLink token required." });
      return;
    }
    if (!authCtx.isAdmin) {
      sendJson(res, 403, { error: "forbidden", message: "仅管理员账号可访问控制面接口" });
      return;
    }

    if (method === "GET" && pathname === "/api/vl/bootstrap") {
      const me = db.getAccount("me") ?? {
        id: "me",
        kind: "human",
        slug: "me",
        handle: "me",
        displayName: authCtx.user.displayName || "我",
        avatar: "preset:user",
        roleTitle: "Owner",
        department: "VibeLink",
        presence: "online",
        statusText: "Mac mini 备服在线",
        provider: "",
        model: "",
        cwd: "",
        isolationMode: "shared",
        approvalMode: "ask",
        description: "",
        pinned: false,
        source: "system",
        pluginId: null,
        externalId: null,
        visible: true,
        createdAt: authCtx.user.createdAt,
        updatedAt: authCtx.user.updatedAt,
      };
      sendJson(res, 200, {
        me,
        accounts: [me],
        rooms: [],
        messagesByRoom: {},
        latestSeq: 0,
        mockBots: false,
        standbyMode: true,
      });
      return;
    }

    if (method === "GET" && pathname === "/api/vl/pairing/info") {
      const hostHeader = typeof headers.host === "string" ? headers.host : null;
      const clusterExtras = cluster.getClusterEndpoints(hostHeader).map((ep) => ({
        id: ep.id,
        label: ep.label,
        kind: ep.kind,
        url: ep.url,
        priority: ep.priority,
        serverRole: ep.serverRole,
        nodeId: ep.nodeId,
      }));
      sendJson(
        res,
        200,
        buildPairingInfo({
          homeDir: db.homeDir,
          token: auth.token,
          hostHeader,
          extraEndpoints: clusterExtras,
        }),
      );
      return;
    }

    if (method === "GET" && pathname === "/api/vl/infra/status") {
      sendJson(res, 200, {
        ok: true,
        readOnly: true,
        standby: true,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        nodeVersion: process.version,
        homeDir: db.homeDir,
        dbPath: db.dbPath,
        mockBots: false,
        botsTotal: 0,
        botsWorking: 0,
        roomsTotal: 0,
        activeTerminals: 0,
        pluginsCount: 0,
        userPluginsDir: "",
        latestSeq: 0,
        cluster: cluster.getPublicSummary(),
      });
      return;
    }

    sendJson(res, 404, {
      error: "standby_not_supported",
      message: "Mac mini 备服专注提供账号、福利、Token 网关与集群切换服务（完整 Bot 编排由 PC 主服承担）",
      path: pathname,
    });
  });

  const host = options.host ?? process.env.VIBELINK_HOST ?? "0.0.0.0";
  const desiredPort =
    options.port ?? (Number.parseInt(process.env.VIBELINK_PORT ?? "18990", 10) || 18990);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(desiredPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : desiredPort;

  return {
    db,
    auth,
    accounts,
    cluster,
    server,
    port: actualPort,
    close: async () => {
      cluster.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      db.close();
    },
  };
}

const isMain =
  Boolean(process.argv[1]) &&
  NodePath.resolve(process.argv[1]) === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url));

if (isMain) {
  if (!process.env.VIBELINK_CLUSTER_ROLE) {
    process.env.VIBELINK_CLUSTER_ROLE = "standby";
  }
  const rt = await startStandbyServer();
  console.log(
    `[vibelink-standby] listening on ${process.env.VIBELINK_HOST ?? "0.0.0.0"}:${rt.port} role=${rt.cluster.getRole()} home=${rt.db.homeDir}`,
  );
  const shutdown = () => {
    void rt.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
