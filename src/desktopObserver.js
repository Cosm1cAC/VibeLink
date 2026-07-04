import crypto from "node:crypto";
import { getCodexDesktopStatus } from "./codexDesktopControl.js";
import { listDesktopObservations, recordDesktopObservation } from "./db.js";

const listeners = new Set();

let timer = null;
let running = false;
let lastSnapshot = null;
let lastSnapshotCursor = 0;
let lastTranscript = [];
let lastRunningKey = "";
let lastSelectionKey = "";

function nowIso() {
  return new Date().toISOString();
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hashText(value, length = 16) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, length);
}

function rectCenter(bounds = {}) {
  const x = Number(bounds.x ?? bounds.X ?? 0);
  const y = Number(bounds.y ?? bounds.Y ?? 0);
  const width = Number(bounds.width ?? bounds.Width ?? 0);
  const height = Number(bounds.height ?? bounds.Height ?? 0);
  return {
    x: x + width / 2,
    y: y + height / 2,
    width,
    height
  };
}

function fallbackTrackId(item, index) {
  const center = rectCenter(item.bounds || {});
  const bucketX = Math.round(center.x / 48);
  const bucketY = Math.round(center.y / 48);
  const bucketWidth = Math.round(center.width / 96);
  return hashText(`${item.role}\n${item.kind}\n${bucketX}\n${bucketY}\n${bucketWidth}\n${index}`, 16);
}

function findPreviousTranscriptItem(item, previousItems, usedTrackIds, index) {
  const normalized = compactText(item.text);
  const center = rectCenter(item.bounds || {});
  let best = null;
  let bestScore = Infinity;

  for (const previous of previousItems || []) {
    if (!previous?.trackId || usedTrackIds.has(previous.trackId)) continue;
    if (previous.role !== item.role || previous.kind !== item.kind) continue;

    const previousText = compactText(previous.text);
    const previousCenter = rectCenter(previous.bounds || {});
    const distance = Math.abs(center.x - previousCenter.x) + Math.abs(center.y - previousCenter.y);
    const indexDistance = Math.abs(Number(item.index ?? index) - Number(previous.index ?? index));
    const sameText = previousText === normalized;
    const streamingUpdate =
      previousText.length > 12 &&
      normalized.length > 12 &&
      (normalized.startsWith(previousText) || previousText.startsWith(normalized) || normalized.includes(previousText));

    let score = distance + indexDistance * 80;
    if (sameText) score -= 600;
    else if (streamingUpdate) score -= 380;
    if (indexDistance === 0) score -= 120;

    if (score < bestScore && (sameText || streamingUpdate || distance < 180)) {
      best = previous;
      bestScore = score;
    }
  }

  return best;
}

function normalizeVisibleTranscript(items = [], previousItems = []) {
  const seen = new Set();
  const result = [];
  for (const [index, item] of items.entries()) {
    const text = compactText(item?.text);
    if (!text) continue;
    const role = item.role === "user" || item.role === "assistant" || item.role === "error" ? item.role : "system";
    const kind = item.kind || "text";
    const contentHash = hashText(`${role}\n${kind}\n${text}`, 16);
    if (seen.has(contentHash)) continue;
    seen.add(contentHash);
    const draft = {
      index: Number.isFinite(Number(item.index)) ? Number(item.index) : index,
      role,
      kind,
      text,
      bounds: item.bounds || null
    };
    const previous = findPreviousTranscriptItem(draft, previousItems, new Set(result.map((entry) => entry.trackId).filter(Boolean)), index);
    const trackId = previous?.trackId || fallbackTrackId(draft, index);
    result.push({
      id: `${trackId}:${contentHash.slice(0, 10)}`,
      trackId,
      contentHash,
      ...draft
    });
  }
  return result.slice(-80);
}

export function normalizeDesktopTarget(result, previousTranscript = []) {
  const target = result?.target || {};
  const conversations = Array.isArray(target.sidebarConversations) ? target.sidebarConversations : [];
  const projects = Array.isArray(target.sidebarProjects) ? target.sidebarProjects : [];
  const visibleTranscript = normalizeVisibleTranscript(target.visibleTranscript, previousTranscript);
  const visibleTranscriptHash = crypto
    .createHash("sha1")
    .update(visibleTranscript.map((item) => `${item.trackId || item.id}:${item.role}:${item.text}`).join("\n"))
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
    remoteControlPageVisible: Boolean(target.remoteControlPageVisible),
    sidebarHasRunning: sidebarRunningCount > 0,
    sidebarRunningCount,
    projects,
    conversations,
    visibleTranscript,
    visibleTranscriptCount: visibleTranscript.length,
    visibleTranscriptHash,
    processId: target.processId || 0,
    processPath: target.processPath || "",
    hwnd: target.hwnd || "",
    windowClass: target.windowClass || "",
    inputName: target.inputName || "",
    inputSynthetic: Boolean(target.inputSynthetic),
    inputFocusable: Boolean(target.inputFocusable),
    inputBounds: target.inputBounds || null,
    inputHasText: draftLength > 0,
    draftLength,
    sendName: target.sendName || "",
    sendEnabled: Boolean(target.sendEnabled),
    sendHasInvokePattern: Boolean(target.sendHasInvokePattern),
    sendBounds: target.sendBounds || null,
    bottomButtons: Array.isArray(target.bottomButtons) ? target.bottomButtons : [],
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
  const observation = recordDesktopObservation(desktop, { source: "codex-desktop-ui", type, extra });
  if (!observation) return null;
  const event = observation;
  emit(event);
  return event;
}

function emitTransientObservation(type, desktop, extra = {}) {
  const observation = recordDesktopObservation(desktop, { source: "codex-desktop-ui", type, extra });
  const event = observation || {
    type,
    cursor: extra.cursor || desktop.observationCursor || lastSnapshotCursor || 0,
    observedAt: desktop.updatedAt || nowIso(),
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
    const desktop = normalizeDesktopTarget(await getCodexDesktopStatus(), lastTranscript);
    const snapshotEvent = emitObservation("desktop.snapshot", desktop);
    if (snapshotEvent) {
      lastSnapshot = desktop;
      lastSnapshotCursor = snapshotEvent.cursor || lastSnapshotCursor;
    }

    const previousByTrack = new Map((lastTranscript || []).map((item) => [item.trackId || item.id, item]));
    const changed = (desktop.visibleTranscript || []).filter((item) => {
      const key = item.trackId || item.id;
      const previous = previousByTrack.get(key);
      return !previous || previous.text !== item.text || previous.contentHash !== item.contentHash;
    });
    if (changed.length && lastTranscript.length) {
      emitTransientObservation("desktop.visibleTranscript.delta", desktop, {
        cursor: snapshotEvent?.cursor || lastSnapshotCursor,
        delta: changed
      });
    }
    lastTranscript = desktop.visibleTranscript || [];

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
      ...item,
      type: item.type || "desktop.snapshot",
      cursor: item.cursor,
      observedAt: item.observedAt,
      source: item.source || "codex-desktop-ui",
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
