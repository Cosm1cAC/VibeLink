import crypto from "node:crypto";
import { getCodexDesktopStatus } from "./codexDesktopControl.js";
import { listDesktopObservations, recordDesktopObservation } from "./db.js";

const listeners = new Set();

let timer = null;
let running = false;
let lastSnapshot = null;
let lastSnapshotCursor = 0;
let lastTranscriptIds = new Set();
let lastRunningKey = "";
let lastSelectionKey = "";

function nowIso() {
  return new Date().toISOString();
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeVisibleTranscript(items = []) {
  const seen = new Set();
  const result = [];
  for (const [index, item] of items.entries()) {
    const text = compactText(item?.text);
    if (!text) continue;
    const role = item.role === "user" || item.role === "assistant" || item.role === "error" ? item.role : "system";
    const kind = item.kind || "text";
    const id = crypto.createHash("sha1").update(`${role}\n${kind}\n${text}`).digest("hex").slice(0, 16);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      index: Number.isFinite(Number(item.index)) ? Number(item.index) : index,
      role,
      kind,
      text,
      bounds: item.bounds || null
    });
  }
  return result.slice(-80);
}

export function normalizeDesktopTarget(result) {
  const target = result?.target || {};
  const conversations = Array.isArray(target.sidebarConversations) ? target.sidebarConversations : [];
  const projects = Array.isArray(target.sidebarProjects) ? target.sidebarProjects : [];
  const visibleTranscript = normalizeVisibleTranscript(target.visibleTranscript);
  const visibleTranscriptHash = crypto
    .createHash("sha1")
    .update(visibleTranscript.map((item) => `${item.role}:${item.text}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
  const sidebarRunningCount = Number(target.sidebarRunningCount || conversations.filter((item) => item?.running).length || 0);
  const draftLength = typeof target.inputValue === "string" ? target.inputValue.trim().length : 0;
  const composerReady = Boolean(target.composerReady ?? target.ready) && draftLength === 0;

  return {
    ok: Boolean(result?.ok),
    found: Boolean(target.found),
    ready: composerReady && sidebarRunningCount === 0,
    composerReady,
    reason: target.reason || result?.error || "",
    windowTitle: target.windowTitle || "",
    minimized: Boolean(target.minimized),
    sidebarHasRunning: sidebarRunningCount > 0,
    sidebarRunningCount,
    projects,
    conversations,
    visibleTranscript,
    visibleTranscriptCount: visibleTranscript.length,
    visibleTranscriptHash,
    inputName: target.inputName || "",
    inputSynthetic: Boolean(target.inputSynthetic),
    inputHasText: draftLength > 0,
    draftLength,
    sendEnabled: Boolean(target.sendEnabled),
    updatedAt: nowIso()
  };
}

function emit(event) {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      listeners.delete(listener);
    }
  }
}

function runningKey(desktop) {
  return JSON.stringify((desktop.conversations || []).filter((item) => item.running).map((item) => [item.index, item.title, item.projectTitle]));
}

function selectionKey(desktop) {
  return JSON.stringify({
    windowTitle: desktop.windowTitle,
    firstConversation: desktop.conversations?.[0]?.title || "",
    firstProject: desktop.projects?.[0]?.title || ""
  });
}

function emitObservation(type, desktop, extra = {}) {
  const observation = recordDesktopObservation(desktop, { source: "codex-desktop-ui" });
  if (!observation) return null;
  const event = {
    type,
    cursor: observation.cursor,
    observedAt: observation.observedAt,
    source: "codex-desktop-ui",
    desktop,
    ...extra
  };
  emit(event);
  return event;
}

async function sample() {
  if (running) return;
  running = true;
  try {
    const desktop = normalizeDesktopTarget(await getCodexDesktopStatus());
    const snapshotEvent = emitObservation("desktop.snapshot", desktop);
    if (snapshotEvent) {
      lastSnapshot = desktop;
      lastSnapshotCursor = snapshotEvent.cursor || lastSnapshotCursor;
    }

    const currentIds = new Set((desktop.visibleTranscript || []).map((item) => item.id));
    const added = (desktop.visibleTranscript || []).filter((item) => !lastTranscriptIds.has(item.id));
    if (added.length && lastTranscriptIds.size) {
      emitObservation("desktop.visibleTranscript.delta", desktop, { delta: added });
    }
    lastTranscriptIds = currentIds;

    const nextRunningKey = runningKey(desktop);
    if (nextRunningKey !== lastRunningKey) {
      lastRunningKey = nextRunningKey;
      emitObservation("desktop.sidebar.running", desktop, {
        running: (desktop.conversations || []).filter((item) => item.running)
      });
    }

    const nextSelectionKey = selectionKey(desktop);
    if (nextSelectionKey !== lastSelectionKey) {
      lastSelectionKey = nextSelectionKey;
      emitObservation("desktop.selection.changed", desktop);
    }
  } finally {
    running = false;
  }
}

export function startDesktopObserver({ intervalMs = 1400 } = {}) {
  if (timer) return;
  sample().catch(() => {});
  timer = setInterval(() => {
    sample().catch(() => {});
  }, intervalMs);
}

export function stopDesktopObserver() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function subscribeDesktopObserver(response, { after = 0 } = {}) {
  startDesktopObserver();
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const send = (event) => {
    if (response.destroyed || response.writableEnded) {
      listeners.delete(send);
      return;
    }
    if (event.cursor) response.write(`id: ${event.cursor}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  listeners.add(send);
  const historical = listDesktopObservations({ after, limit: 100 });
  for (const item of historical) {
    send({
      type: "desktop.snapshot",
      cursor: item.cursor,
      observedAt: item.observedAt,
      source: "codex-desktop-ui",
      desktop: item.desktop
    });
  }

  if (!historical.length && lastSnapshot) {
    send({
      type: "desktop.snapshot",
      cursor: lastSnapshotCursor,
      observedAt: lastSnapshot.updatedAt || nowIso(),
      source: "codex-desktop-ui",
      desktop: lastSnapshot
    });
  } else {
    sample().catch(() => {});
  }

  const ping = setInterval(() => {
    if (response.destroyed || response.writableEnded) {
      clearInterval(ping);
      listeners.delete(send);
      return;
    }
    response.write(`event: ping\ndata: {}\n\n`);
  }, 25000);

  response.on("close", () => {
    clearInterval(ping);
    listeners.delete(send);
  });

  return true;
}
