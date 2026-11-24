// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import type { TerminalAttachStreamEvent } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { resolveAuthContext } from "./accountRoutes.ts";
import * as VibeLinkService from "./service.ts";
import type { VlDeviceCapabilities } from "./devices.ts";
import type { VlEvent } from "./types.ts";

function getRemoteAddressSafely(request: HttpServerRequest.HttpServerRequest): string | null {
  try {
    return NodeHttpServerRequest.toIncomingMessage(request).socket?.remoteAddress ?? null;
  } catch {
    return null;
  }
}

function getRequestAuth(
  vl: VibeLinkService.VibeLinkServiceShape,
  request: HttpServerRequest.HttpServerRequest,
): { authorized: boolean; parsedUrl: URL } {
  const parsedUrl = new URL(request.url, "http://127.0.0.1");
  const headers = request.headers as Record<string, string | ReadonlyArray<string> | undefined>;
  const ctx = resolveAuthContext(vl.auth, vl.accounts, {
    headers,
    queryToken: parsedUrl.searchParams.get("token"),
    remoteAddress: getRemoteAddressSafely(request),
  });
  return { authorized: Boolean(ctx?.isAdmin), parsedUrl };
}

function decodeSocketFrame(frame: string | Uint8Array): string {
  return typeof frame === "string" ? frame : Buffer.from(frame).toString("utf8");
}

function parseClientWsJson(text: string): {
  readonly type?: string;
  readonly data?: string;
  readonly cols?: number;
  readonly rows?: number;
} | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as {
          readonly type?: string;
          readonly data?: string;
          readonly cols?: number;
          readonly rows?: number;
        })
      : null;
  } catch {
    return null;
  }
}

const runEventSocket = Effect.fn("vibelink.ws.events")(function* (
  socket: Socket.Socket,
  vl: VibeLinkService.VibeLinkServiceShape,
  sinceSeq: number,
) {
  const writer = yield* socket.writer;
  // Acquire `socket.reader` before sending initial frames so NodeHttpServer completes the 101 upgrade first.
  const reader = yield* socket.reader;
  const outgoing = yield* Queue.unbounded<VlEvent>();
  const sendJson = (payload: unknown) => writer.write(JSON.stringify(payload));

  const unsubscribe = vl.db.subscribe((event) => {
    Queue.offerUnsafe(outgoing, event);
  });

  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()));

  const backlog = vl.db.listEventsSince(sinceSeq, 1000);
  let lastSentSeq = sinceSeq;
  for (const event of backlog) {
    yield* sendJson({ type: "event", event });
    lastSentSeq = Math.max(lastSentSeq, event.seq);
  }
  yield* sendJson({ type: "ready", latestSeq: Math.max(lastSentSeq, vl.db.getLatestSeq()) });

  yield* Effect.forever(
    Queue.take(outgoing).pipe(
      Effect.flatMap((event) =>
        event.seq > lastSentSeq
          ? sendJson({ type: "event", event }).pipe(
              Effect.tap(() => Effect.sync(() => { lastSentSeq = event.seq; })),
            )
          : Effect.void,
      ),
    ),
  ).pipe(Effect.ignore, Effect.forkScoped);

  yield* Effect.gen(function* () {
    while (true) {
      const frames = yield* reader.pull;
      for (const frame of frames) {
        const msg = parseClientWsJson(decodeSocketFrame(frame));
        if (msg?.type === "ping") {
          const ts = yield* Clock.currentTimeMillis;
          yield* sendJson({ type: "pong", ts });
        }
      }
    }
  }).pipe(Effect.ignore);
});

const runTerminalSocket = Effect.fn("vibelink.ws.terminal")(function* (
  socket: Socket.Socket,
  vl: VibeLinkService.VibeLinkServiceShape,
  sessionId: string,
) {
  const writer = yield* socket.writer;
  const reader = yield* socket.reader;
  const viewerId = `vlviewer_${NodeCrypto.randomUUID().slice(0, 8)}`;
  const sendJson = (payload: unknown) => writer.write(JSON.stringify(payload));
  const outgoing = yield* Queue.unbounded<TerminalAttachStreamEvent>();

  const detach = yield* vl.terminal.attachSession(sessionId, viewerId, (event) =>
    Queue.offer(outgoing, event).pipe(Effect.asVoid),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => detach()));

  const session = vl.terminal.getSession(sessionId);
  yield* sendJson({ type: "attached", session });

  yield* Effect.forever(
    Queue.take(outgoing).pipe(Effect.flatMap((event) => sendJson(event))),
  ).pipe(Effect.ignore, Effect.forkScoped);

  yield* Effect.gen(function* () {
    while (true) {
      const frames = yield* reader.pull;
      for (const frame of frames) {
        const msg = parseClientWsJson(decodeSocketFrame(frame));
        if (!msg) continue;
        if (msg.type === "input" && typeof msg.data === "string") {
          yield* vl.terminal.write(sessionId, msg.data, viewerId).pipe(Effect.ignore);
        } else if (
          msg.type === "resize" &&
          typeof msg.cols === "number" &&
          typeof msg.rows === "number"
        ) {
          yield* vl.terminal.resize(sessionId, msg.cols, msg.rows, viewerId).pipe(Effect.ignore);
        } else if (msg.type === "clear") {
          yield* vl.terminal.clear(sessionId).pipe(Effect.ignore);
        } else if (msg.type === "ping") {
          const ts = yield* Clock.currentTimeMillis;
          yield* sendJson({ type: "pong", ts });
        }
      }
    }
  }).pipe(Effect.ignore);
});

const runDeviceSocket = Effect.fn("vibelink.ws.device")(function* (
  socket: Socket.Socket,
  vl: VibeLinkService.VibeLinkServiceShape,
  remoteAddress: string | null,
) {
  const writer = yield* socket.writer;
  const reader = yield* socket.reader;
  const outgoing = yield* Queue.unbounded<unknown>();
  let socketClosed = false;
  let boundDeviceId: string | null = null;
  let boundConnectionId: string | null = null;

  const sendJson = (payload: unknown) => writer.write(JSON.stringify(payload));

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      socketClosed = true;
      if (boundDeviceId && boundConnectionId) {
        vl.devices.unregisterConnection(boundDeviceId, boundConnectionId);
      }
    }),
  );

  yield* sendJson({ type: "welcome", serverTime: Date.now() });

  yield* Effect.forever(
    Queue.take(outgoing).pipe(Effect.flatMap((payload) => sendJson(payload))),
  ).pipe(Effect.ignore, Effect.forkScoped);

  yield* Effect.gen(function* () {
    while (true) {
      const frames = yield* reader.pull;
      for (const frame of frames) {
        const rawText = decodeSocketFrame(frame);
        let msg: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(rawText) as unknown;
          if (typeof parsed === "object" && parsed !== null) {
            msg = parsed as Record<string, unknown>;
          }
        } catch {
          msg = null;
        }
        if (!msg) continue;

        const msgType = typeof msg.type === "string" ? msg.type : "";
        if (msgType === "hello") {
          const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
          if (!deviceId) continue;
          if (boundDeviceId && boundConnectionId) {
            vl.devices.unregisterConnection(boundDeviceId, boundConnectionId);
          }
          const caps =
            typeof msg.capabilities === "object" && msg.capabilities !== null
              ? (msg.capabilities as Partial<VlDeviceCapabilities>)
              : null;
          const reg = vl.devices.registerConnection({
            deviceId,
            name: typeof msg.name === "string" ? msg.name : undefined,
            model: typeof msg.model === "string" ? msg.model : undefined,
            manufacturer: typeof msg.manufacturer === "string" ? msg.manufacturer : undefined,
            androidVersion: typeof msg.androidVersion === "string" ? msg.androidVersion : undefined,
            sdkInt: typeof msg.sdkInt === "number" ? msg.sdkInt : undefined,
            appVersion: typeof msg.appVersion === "string" ? msg.appVersion : undefined,
            remoteAddress,
            capabilities: caps,
            send: (payload) => {
              if (socketClosed) return false;
              Queue.offerUnsafe(outgoing, payload);
              return true;
            },
          });
          boundDeviceId = deviceId;
          boundConnectionId = reg.connectionId;
          yield* sendJson({
            type: "registered",
            deviceId,
            connectionId: reg.connectionId,
            serverTime: Date.now(),
          });
        } else if (msgType === "heartbeat") {
          if (boundDeviceId && boundConnectionId) {
            const caps =
              typeof msg.capabilities === "object" && msg.capabilities !== null
                ? (msg.capabilities as Partial<VlDeviceCapabilities>)
                : null;
            vl.devices.updateHeartbeat(boundDeviceId, boundConnectionId, caps);
          }
          const ts = yield* Clock.currentTimeMillis;
          yield* sendJson({ type: "pong", ts });
        } else if (msgType === "result") {
          if (boundDeviceId && boundConnectionId && typeof msg.callId === "string") {
            const caps =
              typeof msg.capabilities === "object" && msg.capabilities !== null
                ? (msg.capabilities as Partial<VlDeviceCapabilities>)
                : null;
            vl.devices.handleCommandResult(boundDeviceId, boundConnectionId, {
              callId: msg.callId,
              ok: Boolean(msg.ok),
              data: msg.data,
              error: typeof msg.error === "string" ? msg.error : undefined,
              durationMs: typeof msg.durationMs === "number" ? msg.durationMs : undefined,
              capabilities: caps,
            });
          }
        } else if (msgType === "ping") {
          const ts = yield* Clock.currentTimeMillis;
          yield* sendJson({ type: "pong", ts });
        }
      }
    }
  }).pipe(Effect.ignore);
});

const eventSocketRoute = Layer.unwrap(
  Effect.gen(function* () {
    const vl = yield* VibeLinkService.VibeLinkService;
    return HttpRouter.add(
      "GET",
      "/ws/vl",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { authorized, parsedUrl } = getRequestAuth(vl, request);
        if (!authorized) {
          return HttpServerResponse.empty({ status: 401 });
        }
        const rawSeq = Number(parsedUrl.searchParams.get("sinceSeq") ?? "0");
        const sinceSeq = Number.isFinite(rawSeq) && rawSeq > 0 ? Math.floor(rawSeq) : 0;
        const socket = yield* request.upgrade;
        yield* runEventSocket(socket, vl, sinceSeq).pipe(Effect.scoped);
        return HttpServerResponse.empty();
      }),
    );
  }),
);

const terminalSocketRoute = Layer.unwrap(
  Effect.gen(function* () {
    const vl = yield* VibeLinkService.VibeLinkService;
    return HttpRouter.add(
      "GET",
      "/ws/vl/terminal/*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { authorized, parsedUrl } = getRequestAuth(vl, request);
        if (!authorized) {
          return HttpServerResponse.empty({ status: 401 });
        }
        const parts = parsedUrl.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        const sessionId = parts[3];
        if (!sessionId || !vl.terminal.getSession(sessionId)) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const socket = yield* request.upgrade;
        yield* runTerminalSocket(socket, vl, sessionId).pipe(Effect.scoped, Effect.ignore);
        return HttpServerResponse.empty();
      }),
    );
  }),
);

const deviceSocketRoute = Layer.unwrap(
  Effect.gen(function* () {
    const vl = yield* VibeLinkService.VibeLinkService;
    return HttpRouter.add(
      "GET",
      "/ws/vl/device",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { authorized } = getRequestAuth(vl, request);
        if (!authorized) {
          return HttpServerResponse.empty({ status: 401 });
        }
        const remoteAddr = getRemoteAddressSafely(request);
        const socket = yield* request.upgrade;
        yield* runDeviceSocket(socket, vl, remoteAddr).pipe(Effect.scoped, Effect.ignore);
        return HttpServerResponse.empty();
      }),
    );
  }),
);

export const vibelinkWsRoutes = Layer.mergeAll(
  eventSocketRoute,
  terminalSocketRoute,
  deviceSocketRoute,
);
