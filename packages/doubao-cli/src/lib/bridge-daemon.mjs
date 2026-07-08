import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

function readBearer(request) {
  const header = request.headers.authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function extensionOfflineStatus(extra = {}) {
  return {
    ok: false,
    daemon: true,
    backend: "extension_bridge",
    extension: { connected: false },
    error: {
      code: "EXTENSION_OFFLINE",
      message: "Doubao browser extension is not connected to the local bridge.",
      recoverable: true,
      suggestion: "Install or enable the Doubao Bridge extension, then open doubao.com in Chrome or Edge."
    },
    ...extra
  };
}

function extensionOnlineStatus() {
  return {
    ok: true,
    daemon: true,
    backend: "extension_bridge",
    extension: { connected: true }
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    request.on("error", reject);
  });
}

export async function startBridgeDaemon(options = {}) {
  const token = String(options.token || "");
  const port = Number(options.port ?? 45771);
  const pending = new Map();
  let activeExtension = null;

  const isExtensionConnected = () => activeExtension?.readyState === WebSocket.OPEN;

  const requestExtension = (method, params = {}, timeoutMs = 120000) => new Promise((resolve, reject) => {
    if (!isExtensionConnected()) {
      reject(new Error("EXTENSION_OFFLINE"));
      return;
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("ANSWER_TIMEOUT"));
    }, Math.max(1000, Number(timeoutMs || 120000)));

    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });

    activeExtension.send(JSON.stringify({ id, type: "rpc", method, params }));
  });

  const server = http.createServer(async (request, response) => {
    if (token && readBearer(request) !== token) {
      sendJson(response, 401, {
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          message: "Invalid bridge token.",
          recoverable: true
        }
      });
      return;
    }

    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/status") {
      sendJson(response, 200, isExtensionConnected() ? extensionOnlineStatus() : extensionOfflineStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/rpc") {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: error.message,
            recoverable: true
          }
        });
        return;
      }

      if (!isExtensionConnected()) {
        sendJson(response, 409, extensionOfflineStatus());
        return;
      }

      try {
        const result = await requestExtension(body.method, body.params || {}, body.timeoutMs);
        sendJson(response, result?.ok === false ? 409 : 200, result);
      } catch (error) {
        const code = error.message === "ANSWER_TIMEOUT" ? "ANSWER_TIMEOUT" : "EXTENSION_OFFLINE";
        sendJson(response, code === "ANSWER_TIMEOUT" ? 504 : 409, extensionOfflineStatus({
          error: {
            code,
            message: code === "ANSWER_TIMEOUT"
              ? "Timed out waiting for Doubao extension response."
              : "Doubao browser extension is not connected to the local bridge.",
            recoverable: true
          }
        }));
      }
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Unknown bridge endpoint.",
        recoverable: false
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    activeExtension = socket;
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      waiter.resolve(message);
    });
    socket.on("close", () => {
      if (activeExtension === socket) activeExtension = null;
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const suppliedToken = url.searchParams.get("token") || readBearer(request);
    if (url.pathname !== "/extension" || (token && suppliedToken !== token)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    close: async () => {
      for (const waiter of pending.values()) waiter.reject(new Error("BRIDGE_CLOSED"));
      pending.clear();
      for (const client of wss.clients) client.close();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
