import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { attachmentsDir, getNetworkAddresses, publicDir } from "./config.js";
import { getDbPath, listDesktopObservations, listDevices, revokeDevice } from "./db.js";
import { createTask, getTask, getTasks, restoreTasks, stopTask, subscribeTask, writeTaskInput } from "./agents.js";
import { runCodexAppServerProbe } from "./codexAppServerProbe.js";
import { getCodexDesktopStatus, probeCodexDesktopDraft, sendToCodexDesktop } from "./codexDesktopControl.js";
import { startDesktopObserver, subscribeDesktopObserver } from "./desktopObserver.js";
import { clearDesktopRemoteQueue, enqueueDesktopRemoteMessage, focusDesktopRemoteConversation, getDesktopRemoteState, retryDesktopRemoteQueue } from "./desktopRemote.js";
import { getHistory, listHistories } from "./history.js";
import { authenticateRequest, ensureDefaultWorkspaces, isHostAllowed, pairDevice, publicAccessWarnings, resolveAllowedPath } from "./security.js";
import { loadSettings, publicSettings, sanitizeSettingsPatch, saveSettings } from "./store.js";
import { createThreadFork, getThreadState, updateThreadState } from "./threadState.js";
import { createWorkspace, getTaskChanges, getWorkspaceContext, getWorkspaceGitDiff, getWorkspaceGitStatus, getWorkspaces, getWorkspaceTree } from "./workspaces.js";

let settings = await loadSettings();
ensureDefaultWorkspaces(settings);
restoreTasks();
startDesktopObserver();

const runtimeLogDir = path.join(attachmentsDir, "..", "logs");
const crashLogPath = path.join(runtimeLogDir, "server-crash.log");

function appendRuntimeLog(label, error) {
  try {
    fs.mkdirSync(runtimeLogDir, { recursive: true });
    const text = error?.stack || error?.message || String(error || "");
    fs.appendFileSync(crashLogPath, `[${new Date().toISOString()}] ${label}\n${text}\n\n`, "utf8");
  } catch {
    // Logging must never bring down the bridge.
  }
}

process.on("uncaughtException", (error) => {
  appendRuntimeLog("uncaughtException", error);
  console.error(error?.stack || error?.message || error);
});

process.on("unhandledRejection", (error) => {
  appendRuntimeLog("unhandledRejection", error);
  console.error(error?.stack || error?.message || error);
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".zip": "application/zip"
};

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"]);
const uploadMimeToExt = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
  ["text/markdown", ".md"],
  ["text/csv", ".csv"],
  ["application/json", ".json"],
  ["application/zip", ".zip"]
]);

function sendJson(response, status, value) {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  if (response.headersSent || response.writableEnded || response.destroyed) {
    console.error(message);
    return;
  }
  sendJson(response, status, { error: message });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

async function readRawBody(request, limitBytes = 15 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) {
      const error = new Error("Upload is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isAuthed(request, url) {
  return authenticateRequest(request, url, settings).ok;
}

function serveStatic(request, response, url) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendError(response, 404, "Not found");
      return;
    }

    const extension = path.extname(filePath);
    const isHashedAsset = /^\/assets\/.+-[A-Za-z0-9_-]+\.(?:js|css)$/.test(url.pathname);
    const cacheControl = isHashedAsset
      ? "public, max-age=31536000, immutable"
      : "no-store, must-revalidate";

    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": cacheControl
    });
    response.end(data);
  });
}

function serveLocalFile(response, url) {
  const requestedPath = (url.searchParams.get("path") || "").trim().replace(/^<|>$/g, "");
  let filePath = "";
  try {
    filePath = resolveAllowedPath(requestedPath, settings);
  } catch (error) {
    sendError(response, error.status || 403, error.message);
    return;
  }
  const extension = path.extname(filePath).toLowerCase();

  if (!path.isAbsolute(requestedPath) || !imageExtensions.has(extension)) {
    sendError(response, 400, "Unsupported file");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendError(response, 404, "File not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": "private, max-age=60"
    });
    response.end(data);
  });
}

function attachmentPathFor(id) {
  const safeId = path.basename(String(id || ""));
  if (!/^[a-f0-9-]+(?:\.[a-z0-9]{1,16})?$/i.test(safeId)) return "";
  return path.join(attachmentsDir, safeId);
}

function safeUploadName(value) {
  return path
    .basename(String(value || "attachment").replaceAll("\\", "/"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .slice(0, 160) || "attachment";
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function uploadExtension(mimeType, name) {
  const fromMime = uploadMimeToExt.get(mimeType);
  if (fromMime) return fromMime;
  const fromName = path.extname(safeUploadName(name)).toLowerCase();
  if (/^\.[a-z0-9]{1,16}$/i.test(fromName)) return fromName;
  return ".bin";
}

function textPreview(buffer, mimeType, extension) {
  const textish =
    mimeType.startsWith("text/") ||
    [".txt", ".md", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".xml", ".yaml", ".yml", ".toml", ".py", ".ps1", ".sh"].includes(extension);
  if (!textish) return "";
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf8");
  if (sample.includes("\u0000")) return "";
  return sample;
}

async function saveAttachment(request, response) {
  const mimeType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const originalName = safeUploadName(safeDecode(request.headers["x-file-name"] || ""));
  const relativePath = safeDecode(request.headers["x-relative-path"] || "").replace(/^[\\/]+/, "").slice(0, 500);
  const extension = uploadExtension(mimeType, originalName);

  let data;
  try {
    data = await readRawBody(request, 30 * 1024 * 1024);
  } catch (error) {
    sendError(response, error.status || 400, error.message);
    return;
  }

  if (!data.length) {
    sendError(response, 400, "Empty upload.");
    return;
  }

  await fs.promises.mkdir(attachmentsDir, { recursive: true });
  const id = `${crypto.randomUUID()}${extension}`;
  const filePath = path.join(attachmentsDir, id);
  await fs.promises.writeFile(filePath, data);
  const isImage = imageExtensions.has(extension);
  sendJson(response, 201, {
    ok: true,
    id,
    name: originalName,
    relativePath,
    path: filePath,
    url: `/api/attachments/${encodeURIComponent(id)}`,
    kind: isImage ? "image" : "file",
    markdown: isImage ? `![${originalName}](${filePath})` : `[${originalName}](${filePath})`,
    mimeType,
    size: data.length,
    preview: textPreview(data, mimeType, extension)
  });
}

function serveAttachment(request, response, url) {
  const id = decodeURIComponent(url.pathname.replace(/^\/api\/attachments\//, ""));
  const filePath = attachmentPathFor(id);
  if (!filePath || !filePath.startsWith(attachmentsDir)) {
    sendError(response, 400, "Invalid attachment.");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendError(response, 404, "Attachment not found.");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Content-Disposition": `inline; filename="${path.basename(filePath).replaceAll('"', "")}"`,
      "Cache-Control": "private, max-age=300"
    });
    response.end(data);
  });
}

async function routeApi(request, response, url) {
  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await readBody(request);
    let device;
    try {
      device = pairDevice({
        pairingToken: body.pairingToken,
        settings,
        label: body.deviceLabel || request.headers["user-agent"] || "Browser"
      });
    } catch (error) {
      sendError(response, error.status || 401, error.message);
      return;
    }

    const patch = sanitizeSettingsPatch({ apiKeys: body.apiKeys || {} });
    settings = {
      ...settings,
      apiKeys: {
        ...settings.apiKeys,
        ...patch.apiKeys
      }
    };

    if (body.rememberKeys) await saveSettings(settings);
    sendJson(response, 200, { ok: true, token: device.token, device: { id: device.id, label: device.label }, settings: publicSettings(settings) });
    return;
  }

  if (!isHostAllowed(request, settings)) {
    sendError(response, 403, "Host is not allowed.");
    return;
  }

  if (!isAuthed(request, url)) {
    sendError(response, 401, "Unauthorized");
    return;
  }

  if (url.pathname === "/api/files" && request.method === "GET") {
    serveLocalFile(response, url);
    return;
  }

  if (url.pathname === "/api/attachments" && request.method === "POST") {
    await saveAttachment(request, response);
    return;
  }

  if (url.pathname.startsWith("/api/attachments/") && request.method === "GET") {
    serveAttachment(request, response, url);
    return;
  }

  if (url.pathname === "/api/status" && request.method === "GET") {
    sendJson(response, 200, {
      ok: true,
      settings: publicSettings(settings),
      storage: {
        sqlite: getDbPath()
      },
      security: {
        warnings: publicAccessWarnings(request, settings),
        devices: listDevices()
      },
      workspaces: getWorkspaces(settings),
      network: getNetworkAddresses(settings.port),
      tasks: getTasks()
    });
    return;
  }

  if (url.pathname === "/api/settings" && request.method === "POST") {
    const body = await readBody(request);
    const patch = sanitizeSettingsPatch(body);
    settings = {
      ...settings,
      ...patch,
      apiKeys: {
        ...settings.apiKeys,
        ...(patch.apiKeys || {})
      }
    };
    await saveSettings(settings);
    ensureDefaultWorkspaces(settings);
    sendJson(response, 200, { ok: true, settings: publicSettings(settings) });
    return;
  }

  if (url.pathname === "/api/devices" && request.method === "GET") {
    sendJson(response, 200, { items: listDevices() });
    return;
  }

  const deviceRevokeMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/);
  if (deviceRevokeMatch && request.method === "POST") {
    sendJson(response, 200, { ok: revokeDevice(deviceRevokeMatch[1]) });
    return;
  }

  if (url.pathname === "/api/workspaces" && request.method === "GET") {
    sendJson(response, 200, { items: getWorkspaces(settings) });
    return;
  }

  if (url.pathname === "/api/workspaces" && request.method === "POST") {
    const body = await readBody(request);
    sendJson(response, 201, { workspace: createWorkspace(body, settings) });
    return;
  }

  const workspaceTreeMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tree$/);
  if (workspaceTreeMatch && request.method === "GET") {
    sendJson(response, 200, await getWorkspaceTree(workspaceTreeMatch[1], settings, url.searchParams.get("dir") || ""));
    return;
  }

  const workspaceContextMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/context$/);
  if (workspaceContextMatch && request.method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, await getWorkspaceContext(workspaceContextMatch[1], settings, body));
    return;
  }

  const workspaceGitStatusMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/git\/status$/);
  if (workspaceGitStatusMatch && request.method === "GET") {
    sendJson(response, 200, await getWorkspaceGitStatus(workspaceGitStatusMatch[1], settings));
    return;
  }

  const workspaceGitDiffMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/git\/diff$/);
  if (workspaceGitDiffMatch && request.method === "GET") {
    sendJson(response, 200, await getWorkspaceGitDiff(workspaceGitDiffMatch[1], settings));
    return;
  }

  if (url.pathname === "/api/codex-app-server/probe" && request.method === "POST") {
    const result = await runCodexAppServerProbe(settings);
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/codex-desktop/status" && request.method === "GET") {
    const result = await getCodexDesktopStatus();
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/codex-desktop/draft-probe" && request.method === "POST") {
    const body = await readBody(request);
    const result = await probeCodexDesktopDraft(typeof body.text === "string" ? body.text : "");
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/codex-desktop/send" && request.method === "POST") {
    const body = await readBody(request);
    if (!body.prompt || typeof body.prompt !== "string") {
      sendError(response, 400, "Prompt is required");
      return;
    }

    const result = await sendToCodexDesktop(body.prompt);
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/desktop-remote/status" && request.method === "GET") {
    const result = await getDesktopRemoteState({ fresh: url.searchParams.get("fresh") === "1" });
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/desktop-remote/observations" && request.method === "GET") {
    const result = listDesktopObservations({
      after: Number(url.searchParams.get("after") || 0),
      limit: Number(url.searchParams.get("limit") || 100)
    });
    sendJson(response, 200, { items: result });
    return;
  }

  if (url.pathname === "/api/desktop-remote/events" && request.method === "GET") {
    const after = Number(url.searchParams.get("after") || request.headers["last-event-id"] || 0);
    subscribeDesktopObserver(response, { after });
    return;
  }

  if (url.pathname === "/api/desktop-remote/messages" && request.method === "POST") {
    const body = await readBody(request);
    if (!body.text || typeof body.text !== "string") {
      sendError(response, 400, "Text is required");
      return;
    }

    const item = enqueueDesktopRemoteMessage(body.text);
    const state = await getDesktopRemoteState();
    sendJson(response, 202, { ok: true, item, state });
    return;
  }

  if (url.pathname === "/api/desktop-remote/retry" && request.method === "POST") {
    retryDesktopRemoteQueue();
    const state = await getDesktopRemoteState({ fresh: true });
    sendJson(response, 200, state);
    return;
  }

  if (url.pathname === "/api/desktop-remote/clear" && request.method === "POST") {
    clearDesktopRemoteQueue();
    const state = await getDesktopRemoteState();
    sendJson(response, 200, state);
    return;
  }

  if (url.pathname === "/api/desktop-remote/focus" && request.method === "POST") {
    const body = await readBody(request);
    const result = await focusDesktopRemoteConversation(Number(body.index || 0));
    sendJson(response, result.ok ? 200 : 409, result);
    return;
  }

  if (url.pathname === "/api/histories" && request.method === "GET") {
    sendJson(response, 200, { items: listHistories() });
    return;
  }

  if (url.pathname === "/api/thread-state" && request.method === "GET") {
    sendJson(response, 200, getThreadState());
    return;
  }

  if (url.pathname === "/api/thread-state" && request.method === "POST") {
    const body = await readBody(request);
    const state = updateThreadState(body.key, body.patch || {});
    sendJson(response, 200, state);
    return;
  }

  if (url.pathname === "/api/thread-state/forks" && request.method === "POST") {
    const body = await readBody(request);
    const result = createThreadFork(body);
    sendJson(response, 201, result);
    return;
  }

  const historyMatch = url.pathname.match(/^\/api\/histories\/([^/]+)\/([^/]+)$/);
  if (historyMatch && request.method === "GET") {
    const [, provider, id] = historyMatch;
    const item = getHistory(provider, decodeURIComponent(id));
    if (!item) {
      sendError(response, 404, "History not found");
      return;
    }
    sendJson(response, 200, item);
    return;
  }

  if (url.pathname === "/api/tasks" && request.method === "GET") {
    sendJson(response, 200, { items: getTasks() });
    return;
  }

  if (url.pathname === "/api/tasks" && request.method === "POST") {
    const body = await readBody(request);
    if (!body.prompt || typeof body.prompt !== "string") {
      sendError(response, 400, "Prompt is required");
      return;
    }

    const task = createTask(body, settings);
    sendJson(response, 201, {
      id: task.id,
      status: task.status
    });
    return;
  }

  const taskEventsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
  if (taskEventsMatch && request.method === "GET") {
    const after = Number(url.searchParams.get("after") || request.headers["last-event-id"] || 0);
    const ok = subscribeTask(taskEventsMatch[1], response, { after });
    if (!ok) sendError(response, 404, "Task not found");
    return;
  }

  const taskChangesMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/changes$/);
  if (taskChangesMatch && request.method === "GET") {
    const task = getTask(taskChangesMatch[1]);
    if (!task) {
      sendError(response, 404, "Task not found");
      return;
    }
    sendJson(response, 200, await getTaskChanges(task, settings));
    return;
  }

  const taskInputMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/input$/);
  if (taskInputMatch && request.method === "POST") {
    const body = await readBody(request);
    const result = writeTaskInput(taskInputMatch[1], String(body.text || ""));
    sendJson(response, 200, result);
    return;
  }

  const taskStopMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/);
  if (taskStopMatch && request.method === "POST") {
    const ok = stopTask(taskStopMatch[1]);
    sendJson(response, ok ? 200 : 409, { ok });
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && request.method === "GET") {
    const task = getTask(taskMatch[1]);
    if (!task) {
      sendError(response, 404, "Task not found");
      return;
    }
    sendJson(response, 200, {
      id: task.id,
      agent: task.agent,
      title: task.title,
      cwd: task.cwd,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      exitCode: task.exitCode,
      sessionId: task.sessionId,
      commandLabel: task.commandLabel,
      events: task.events
    });
    return;
  }

  sendError(response, 404, "Unknown API route");
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (!isHostAllowed(request, settings)) {
      sendError(response, 403, "Host is not allowed.");
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await routeApi(request, response, url);
      return;
    }

    serveStatic(request, response, url);
  } catch (error) {
    if (response.headersSent || response.writableEnded || response.destroyed) {
      console.error(error.stack || error.message);
      return;
    }
    sendError(response, 500, error.stack || error.message);
  }
});

server.on("clientError", (error, socket) => {
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {
    // Ignore broken client sockets.
  }
});

server.on("error", (error) => {
  console.error(error.stack || error.message);
});

server.listen(settings.port, settings.host, () => {
  const local = `http://localhost:${settings.port}`;
  console.log(`VibeLink listening on ${local}`);
  console.log(`Pairing token: ${settings.pairingToken}`);
  for (const item of getNetworkAddresses(settings.port)) console.log(`LAN: ${item.url}`);
});
