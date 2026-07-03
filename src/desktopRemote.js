import { focusCodexDesktopConversation, getCodexDesktopStatus, sendToCodexDesktop } from "./codexDesktopControl.js";
import { recordDesktopObservation } from "./db.js";
import { normalizeDesktopTarget } from "./desktopObserver.js";

const queue = [];
const MAX_ITEMS = 120;
const STATUS_CACHE_MS = 1500;
const RETRY_MS = 2500;

let active = false;
let retryTimer = null;
let lastDesktopStatus = null;
let lastDesktopStatusAt = 0;
const cancelledIds = new Set();

function nowIso() {
  return new Date().toISOString();
}

function trimItems() {
  while (queue.length > MAX_ITEMS) queue.shift();
}

function summarizeDesktop(result) {
  const desktop = normalizeDesktopTarget(result);
  const draftLength = desktop.draftLength || 0;
  const minimized = Boolean(desktop.minimized);
  const sidebarRunningCount = Number(desktop.sidebarRunningCount || 0);
  const sidebarHasRunning = Boolean(desktop.sidebarHasRunning) || sidebarRunningCount > 0;
  const baseReason = desktop.reason || result?.error || "";
  const reason = sidebarHasRunning
    ? `Codex Desktop sidebar shows ${sidebarRunningCount} running conversation(s).`
    : baseReason;
  const composerReady = Boolean(desktop.composerReady) && draftLength === 0;
  const ready = composerReady && !sidebarHasRunning;
  const running = /currently running a turn|running a turn|composer shows a Stop button|composer is unavailable/i.test(reason);
  const canAttemptSend = (composerReady || (minimized && !running)) && !sidebarHasRunning && draftLength === 0;
  return {
    ...desktop,
    ready,
    composerReady,
    canAttemptSend,
    reason: draftLength ? "Codex Desktop composer already contains text." : reason,
    minimized,
    sidebarHasRunning,
    sidebarRunningCount,
    inputHasText: draftLength > 0,
    updatedAt: nowIso()
  };
}

async function refreshDesktopStatus(force = false) {
  const age = Date.now() - lastDesktopStatusAt;
  if (!force && lastDesktopStatus && age < STATUS_CACHE_MS) return lastDesktopStatus;

  try {
    lastDesktopStatus = summarizeDesktop(await getCodexDesktopStatus());
    const observation = recordDesktopObservation(lastDesktopStatus);
    if (observation?.cursor) lastDesktopStatus.observationCursor = observation.cursor;
  } catch (error) {
    lastDesktopStatus = {
      ok: false,
      found: false,
      ready: false,
      reason: error.message,
      updatedAt: nowIso()
    };
  }
  lastDesktopStatusAt = Date.now();
  return lastDesktopStatus;
}

function scheduleProcess(delay = RETRY_MS) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    processQueue().catch(() => {});
  }, delay);
}

function shouldWait(result) {
  const text = `${result?.error || ""} ${result?.target?.reason || ""}`.toLowerCase();
  return /running|busy|unavailable|not found|composer|send button|window|already contains text|refusing to overwrite/.test(text);
}

function publicItem(item) {
  return {
    id: item.id,
    text: item.text,
    status: item.status,
    error: item.error,
    attempts: item.attempts,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    sentAt: item.sentAt || "",
    result: item.result
      ? {
          ok: Boolean(item.result.ok),
          action: item.result.action || "",
          sendMethod: item.result.sendMethod || "",
          error: item.result.error || ""
        }
      : null
  };
}

async function processQueue() {
  if (active) return;
  active = true;

  try {
    const item = queue.find((entry) => entry.status === "queued" || entry.status === "waiting");
    if (!item) return;
    if (cancelledIds.has(item.id)) {
      item.status = "cancelled";
      item.error = "Cancelled";
      item.updatedAt = nowIso();
      return;
    }

    item.status = "checking";
    item.updatedAt = nowIso();

    const desktop = await refreshDesktopStatus(true);
    if (cancelledIds.has(item.id) || item.status === "cancelled") return;
    if (!desktop.canAttemptSend) {
      item.status = "waiting";
      item.error = desktop.reason || "Codex Desktop is not ready.";
      item.updatedAt = nowIso();
      scheduleProcess();
      return;
    }

    item.status = "sending";
    item.attempts += 1;
    item.error = "";
    item.updatedAt = nowIso();

    const result = await sendToCodexDesktop(item.text);
    if (cancelledIds.has(item.id) || item.status === "cancelled") return;
    item.result = result;
    lastDesktopStatus = summarizeDesktop(result.afterSend ? { ok: result.ok, target: result.afterSend } : result);
    const observation = recordDesktopObservation(lastDesktopStatus);
    if (observation?.cursor) lastDesktopStatus.observationCursor = observation.cursor;
    lastDesktopStatusAt = Date.now();

    if (result.ok) {
      item.status = "sent";
      item.sentAt = nowIso();
      item.updatedAt = item.sentAt;
      processQueue().catch(() => {});
      return;
    }

    if (shouldWait(result)) {
      item.status = "waiting";
      item.error = result.error || result.target?.reason || "Codex Desktop is not ready.";
      item.updatedAt = nowIso();
      scheduleProcess();
      return;
    }

    item.status = "failed";
    item.error = result.error || "Desktop send failed.";
    item.updatedAt = nowIso();
  } finally {
    active = false;
  }
}

export function enqueueDesktopRemoteMessage(text) {
  const item = {
    id: crypto.randomUUID(),
    text,
    status: "queued",
    error: "",
    attempts: 0,
    result: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  queue.push(item);
  trimItems();
  processQueue().catch(() => {});
  return publicItem(item);
}

export async function getDesktopRemoteState({ fresh = false } = {}) {
  const desktop = await refreshDesktopStatus(fresh);
  return {
    ok: true,
    mode: "desktop-remote",
    active,
    desktop,
    items: queue.map(publicItem),
    pendingCount: queue.filter((item) => ["queued", "waiting", "checking", "sending"].includes(item.status)).length,
    updatedAt: nowIso()
  };
}

export function retryDesktopRemoteQueue() {
  processQueue().catch(() => {});
}

export function clearDesktopRemoteQueue() {
  for (const item of queue) {
    if (["queued", "waiting", "checking", "sending"].includes(item.status)) {
      cancelledIds.add(item.id);
      item.status = "cancelled";
      item.error = "Cancelled";
      item.updatedAt = nowIso();
    }
  }
  return queue.map(publicItem);
}

export async function focusDesktopRemoteConversation(index) {
  const result = await focusCodexDesktopConversation(index);
  lastDesktopStatus = summarizeDesktop(result.afterFocus ? { ok: result.ok, target: result.afterFocus } : result);
  const observation = recordDesktopObservation(lastDesktopStatus);
  if (observation?.cursor) lastDesktopStatus.observationCursor = observation.cursor;
  lastDesktopStatusAt = Date.now();
  return {
    ok: Boolean(result.ok),
    action: result.action || "focusConversation",
    error: result.error || "",
    index,
    desktop: lastDesktopStatus,
    result
  };
}
