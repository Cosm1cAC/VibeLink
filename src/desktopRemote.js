import crypto from "node:crypto";
import { focusCodexDesktopConversation, getCodexDesktopStatus, probeCodexDesktopDraft, restoreCodexDesktopWindow, sendToCodexDesktop } from "./codexDesktopControl.js";
import { listDesktopRemoteQueue, recordDesktopObservation, upsertDesktopRemoteQueueItem } from "./db.js";
import { normalizeDesktopTarget } from "./desktopObserver.js";

const MAX_ITEMS = 120;
const queue = listDesktopRemoteQueue({ limit: MAX_ITEMS }).map(restoreQueueItem);
const STATUS_CACHE_MS = 1500;
const RETRY_MS = 2500;
const POST_SEND_VERIFY_ATTEMPTS = 5;
const POST_SEND_VERIFY_MS = 1100;
const DRAFT_PROBE_MS = 10 * 60 * 1000;
const SEND_PROBE_MS = 60 * 60 * 1000;

let active = false;
let retryTimer = null;
let lastDesktopStatus = null;
let lastDesktopStatusAt = 0;
let probeRunning = false;
let probeHealth = {
  draft: null,
  send: null,
  draftProbeEnabled: process.env.VIBELINK_DESKTOP_DRAFT_PROBE !== "0",
  sendProbeEnabled: process.env.VIBELINK_DESKTOP_SEND_PROBE === "1"
};
const cancelledIds = new Set();
let notificationHandler = null;

function nowIso() {
  return new Date().toISOString();
}

function trimItems() {
  while (queue.length > MAX_ITEMS) queue.shift();
}

export function setDesktopRemoteNotificationHandler(handler) {
  notificationHandler = typeof handler === "function" ? handler : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeMatchText(value) {
  return compactText(value).replace(/[\s"'`“”‘’。，、,.!?！？:：;；()[\]{}<>《》【】\-_/\\…]+/g, "").toLowerCase();
}

function pathBaseName(value = "") {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || "";
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
  const canAttemptSend = composerReady && !minimized && !sidebarHasRunning && draftLength === 0;
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

function desktopRunningTurn(desktop) {
  return Boolean(desktop?.sidebarHasRunning || desktop?.sidebarRunningCount > 0) || /running a turn|Stop button|composer is unavailable|thinking|loading|progress|busy/i.test(desktop?.reason || "");
}

function targetConversation(desktop, target = {}) {
  const index = Number(target.desktopIndex);
  if (!Number.isFinite(index)) return null;
  return (desktop?.conversations || []).find((item) => Number(item.index) === index) || desktop?.conversations?.[index] || null;
}

function titleMatches(actual, expected) {
  const a = normalizeMatchText(actual);
  const b = normalizeMatchText(expected);
  if (!a || !b) return false;
  return a === b || (a.length >= 6 && b.includes(a)) || (b.length >= 6 && a.includes(b));
}

function projectMatches(actual, expected) {
  const a = normalizeMatchText(actual);
  const b = normalizeMatchText(expected);
  if (!b || b === "noproject") return true;
  if (!a || a === "noproject") return false;
  return a === b || a.includes(b) || b.includes(a);
}

function hasDesktopSettingRequest(item) {
  return Boolean(
    item.model ||
    item.reasoningEffort ||
    (item.permissionMode && item.permissionMode !== "default")
  );
}

function validateDesktopSettingsPolicy(item) {
  if (!hasDesktopSettingRequest(item)) {
    return {
      ok: true,
      mode: "use-existing",
      reason: "Desktop remote will use the current Codex Desktop model, permission, and reasoning settings."
    };
  }

  if (item.settingsPolicy === "useExisting") {
    return {
      ok: true,
      mode: "use-existing",
      ignored: true,
      reason: "Requested settings are recorded for visibility only; Desktop remote uses the current Codex Desktop settings."
    };
  }

  return {
    ok: false,
    mode: "unsupported",
    reason: "Desktop remote does not blindly change native Codex model, permission, or reasoning menus. Use CLI mode for deterministic settings, or switch Codex Desktop manually before sending."
  };
}

function evaluateDesktopPreflight(desktop, item) {
  const failures = [];
  const warnings = [];
  const checks = {
    found: Boolean(desktop?.found),
    processPath: desktop?.processPath || "",
    windowTitle: desktop?.windowTitle || "",
    inputName: desktop?.inputName || "",
    inputSynthetic: Boolean(desktop?.inputSynthetic),
    sendName: desktop?.sendName || "",
    sendEnabled: Boolean(desktop?.sendEnabled),
    draftLength: Number(desktop?.draftLength || 0),
    target: item.target || null
  };

  if (!desktop?.found) failures.push({ code: "window_missing", message: "Codex Desktop window was not found.", retryable: true });

  const processName = pathBaseName(desktop?.processPath || "");
  if (desktop?.found && !/^codex(?:\.exe)?$/i.test(processName)) {
    failures.push({ code: "process_mismatch", message: `Detected process is not Codex.exe: ${desktop?.processPath || "unknown"}` });
  }

  if (desktop?.found && !/^Codex(?:\b|$)/i.test(compactText(desktop.windowTitle))) {
    failures.push({ code: "window_mismatch", message: `Detected window is not the Codex window: ${desktop.windowTitle || "untitled"}` });
  }

  if (desktop?.remoteControlPageVisible) {
    failures.push({ code: "remote_page_visible", message: "The remote control page is open inside Codex Desktop." });
  }

  if (desktop?.minimized) warnings.push({ code: "minimized", message: "Codex Desktop is minimized; it must be restored and re-checked before sending." });
  if (!desktop?.composerReady) failures.push({ code: "composer_unready", message: desktop?.reason || "Codex Desktop composer is not ready.", retryable: true });
  if (!desktop?.inputName) failures.push({ code: "input_missing", message: "Composer input selector was not found.", retryable: Boolean(desktop?.minimized) });
  if (desktop?.inputSynthetic) warnings.push({ code: "synthetic_input", message: "Using bottom-composer geometry fallback because a named input was not exposed." });
  if (!desktop?.sendName) failures.push({ code: "send_missing", message: "Send button selector was not found.", retryable: Boolean(desktop?.minimized) });
  if (desktop?.sendEnabled) failures.push({ code: "send_enabled_before_paste", message: "Send button is already enabled before paste; refusing to risk sending an existing draft." });
  if (Number(desktop?.draftLength || 0) > 0 || desktop?.inputHasText) failures.push({ code: "draft_present", message: "Codex Desktop composer already contains text." });

  if (desktop?.sidebarHasRunning || Number(desktop?.sidebarRunningCount || 0) > 0) {
    failures.push({ code: "sidebar_running", message: `Codex Desktop sidebar shows ${desktop.sidebarRunningCount || 1} running conversation(s).`, retryable: true });
  }

  if (!item.target || !Number.isFinite(Number(item.target.desktopIndex))) {
    failures.push({ code: "target_missing", message: "Desktop remote requires a bound visible Codex conversation target." });
  } else {
    const conversation = targetConversation(desktop, item.target);
    if (!conversation) {
      failures.push({ code: "target_not_visible", message: "Expected Codex Desktop sidebar conversation is no longer visible.", retryable: true });
    } else {
      checks.actualConversation = {
        index: conversation.index,
        title: conversation.title || conversation.rawName || "",
        projectTitle: conversation.projectTitle || ""
      };
      if (!titleMatches(conversation.title || conversation.rawName, item.target.desktopTitle || item.target.title)) {
        failures.push({ code: "target_title_mismatch", message: "Visible Codex Desktop conversation title no longer matches the selected thread." });
      }
      if (!projectMatches(conversation.projectTitle, item.target.desktopProjectTitle || item.target.projectTitle || "")) {
        failures.push({ code: "target_project_mismatch", message: "Visible Codex Desktop project no longer matches the selected thread." });
      }
    }
  }

  const retryable = failures.length > 0 && failures.every((item) => item.retryable);
  return {
    ok: failures.length === 0,
    retryable,
    reason: failures.map((item) => item.message).join(" "),
    failures,
    warnings,
    checks,
    checkedAt: nowIso()
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

async function restoreAndRefreshDesktopStatus() {
  const result = await restoreCodexDesktopWindow();
  const desktop = summarizeDesktop(result?.target ? { ok: result.ok, target: result.target } : result);
  const observation = recordDesktopObservation(desktop);
  if (observation?.cursor) desktop.observationCursor = observation.cursor;
  lastDesktopStatus = desktop;
  lastDesktopStatusAt = Date.now();
  await sleep(250);
  return refreshDesktopStatus(true);
}

function transcriptContainsUserText(desktop, text) {
  const expected = compactText(text).slice(0, 220);
  if (!expected) return false;
  return (desktop?.visibleTranscript || []).some((item) => {
    if (item.role !== "user") return false;
    const actual = compactText(item.text);
    return actual.includes(expected) || expected.includes(actual.slice(0, 160));
  });
}

function postSendSnapshotOk(desktop, item) {
  const inputCleared = !desktop?.inputHasText && Number(desktop?.draftLength || 0) === 0;
  const userMessageSeen = transcriptContainsUserText(desktop, item.text);
  const running = desktopRunningTurn(desktop);
  return {
    ok: inputCleared && userMessageSeen && running,
    inputCleared,
    userMessageSeen,
    running,
    desktop
  };
}

async function verifyPostSend(item, firstResult) {
  const attempts = [];
  for (let index = 0; index < POST_SEND_VERIFY_ATTEMPTS; index += 1) {
    if (index > 0) await sleep(POST_SEND_VERIFY_MS);
    const desktop =
      index === 0 && firstResult
        ? summarizeDesktop(firstResult.afterSend ? { ok: firstResult.ok, target: firstResult.afterSend } : firstResult)
        : await refreshDesktopStatus(true);
    const snapshot = postSendSnapshotOk(desktop, item);
    attempts.push({
      at: nowIso(),
      inputCleared: snapshot.inputCleared,
      userMessageSeen: snapshot.userMessageSeen,
      running: snapshot.running,
      visibleTranscriptHash: desktop.visibleTranscriptHash || "",
      reason: desktop.reason || ""
    });
    if (snapshot.ok) {
      return {
        ok: true,
        attempts,
        verifiedAt: nowIso()
      };
    }
  }

  return {
    ok: false,
    reason: "Sent, but post-send verification did not confirm cleared input, visible user message, and thinking/running state.",
    attempts,
    verifiedAt: nowIso()
  };
}

async function maybeRunDesktopProbe() {
  if (probeRunning) return;
  const current = Date.now();
  const idleForProbe = !active && !queue.some((item) => ["queued", "waiting", "checking", "sending"].includes(item.status));
  const desktopReadyForProbe =
    Boolean(lastDesktopStatus?.ready) &&
    Boolean(lastDesktopStatus?.found) &&
    !lastDesktopStatus?.inputHasText &&
    !desktopRunningTurn(lastDesktopStatus);
  const draftDue =
    probeHealth.draftProbeEnabled &&
    idleForProbe &&
    desktopReadyForProbe &&
    (!probeHealth.draft?.at || current - new Date(probeHealth.draft.at).getTime() > DRAFT_PROBE_MS);
  const sendDue =
    probeHealth.sendProbeEnabled &&
    idleForProbe &&
    desktopReadyForProbe &&
    (!probeHealth.send?.at || current - new Date(probeHealth.send.at).getTime() > SEND_PROBE_MS);

  if (!draftDue && !sendDue) return;
  probeRunning = true;
  try {
    if (draftDue) {
      const result = await probeCodexDesktopDraft(`DESKTOP_REMOTE_DRAFT_PROBE_${Date.now()}`);
      probeHealth = {
        ...probeHealth,
        draft: {
          at: nowIso(),
          ok: Boolean(result.ok),
          error: result.error || "",
          action: result.action || "draft"
        }
      };
    }

    if (sendDue) {
      const result = await sendToCodexDesktop(`DESKTOP_REMOTE_SEND_PROBE_${Date.now()}`, { settingsPolicy: "useExisting" });
      probeHealth = {
        ...probeHealth,
        send: {
          at: nowIso(),
          ok: Boolean(result.ok),
          error: result.error || "",
          action: result.action || "send"
        }
      };
    }
  } catch (error) {
    probeHealth = {
      ...probeHealth,
      draft: draftDue ? { at: nowIso(), ok: false, error: error.message, action: "draft" } : probeHealth.draft
    };
  } finally {
    probeRunning = false;
  }
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
    settings: {
      permissionMode: item.permissionMode || "",
      model: item.model || "",
      reasoningEffort: item.reasoningEffort || ""
    },
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
      : null,
    target: item.target || null,
    settingsPolicy: item.settingsPolicy || "useExisting",
    settingsCheck: item.settingsCheck || null,
    restoreCheck: item.restoreCheck || null,
    preflight: item.preflight || null,
    postflight: item.postflight || null
  };
}

function restoreQueueItem(item) {
  if (["checking", "sending"].includes(item.status)) {
    return {
      ...item,
      status: "waiting",
      error: "Bridge restarted before this Desktop remote message completed.",
      updatedAt: nowIso()
    };
  }
  return item;
}

function persistQueueItem(item) {
  try {
    upsertDesktopRemoteQueueItem(item);
  } catch {
    // Persistence should not block the live remote queue.
  }
}

for (const item of queue) persistQueueItem(item);

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
      persistQueueItem(item);
      return;
    }

    item.status = "checking";
    item.updatedAt = nowIso();
    persistQueueItem(item);

    let desktop = await refreshDesktopStatus(true);
    if (cancelledIds.has(item.id) || item.status === "cancelled") return;

    const settingsCheck = validateDesktopSettingsPolicy(item);
    item.settingsCheck = settingsCheck;
    if (!settingsCheck.ok) {
      item.status = "failed";
      item.error = settingsCheck.reason;
      item.updatedAt = nowIso();
      persistQueueItem(item);
      return;
    }

    if (desktop?.minimized) {
      const restored = await restoreAndRefreshDesktopStatus();
      if (cancelledIds.has(item.id) || item.status === "cancelled") return;
      item.restoreCheck = restored;
      desktop = restored;
      persistQueueItem(item);
    }

    const preflight = evaluateDesktopPreflight(desktop, item);
    item.preflight = preflight;
    if (!preflight.ok) {
      item.status = preflight.retryable ? "waiting" : "failed";
      item.error = preflight.reason || desktop.reason || "Codex Desktop preflight failed.";
      item.updatedAt = nowIso();
      persistQueueItem(item);
      if (preflight.retryable) scheduleProcess();
      return;
    }

    if (!desktop.canAttemptSend) {
      item.status = "waiting";
      item.error = desktop.reason || "Codex Desktop is not ready.";
      item.updatedAt = nowIso();
      persistQueueItem(item);
      scheduleProcess();
      return;
    }

    item.status = "sending";
    item.attempts += 1;
    item.error = "";
    item.updatedAt = nowIso();
    persistQueueItem(item);

    const result = await sendToCodexDesktop(item.text, {
      permissionMode: item.permissionMode || "",
      model: item.model || "",
      reasoningEffort: item.reasoningEffort || "",
      settingsPolicy: item.settingsPolicy || "useExisting",
      target: item.target || {}
    });
    if (cancelledIds.has(item.id) || item.status === "cancelled") return;
    item.result = result;
    persistQueueItem(item);
    lastDesktopStatus = summarizeDesktop(result.afterSend ? { ok: result.ok, target: result.afterSend } : result);
    const observation = recordDesktopObservation(lastDesktopStatus);
    if (observation?.cursor) lastDesktopStatus.observationCursor = observation.cursor;
    lastDesktopStatusAt = Date.now();

    if (result.ok) {
      const postflight = await verifyPostSend(item, result);
      item.postflight = postflight;
      item.status = postflight.ok ? "sent" : "sent_unverified";
      item.error = postflight.ok ? "" : postflight.reason;
      item.sentAt = nowIso();
      item.updatedAt = item.sentAt;
      persistQueueItem(item);
      if (postflight.ok) {
        notificationHandler?.({
          type: "desktop.sent",
          title: "Desktop message sent",
          body: item.target?.desktopTitle || item.target?.title || "Codex Desktop accepted the queued message.",
          tag: `desktop:${item.id}`,
          url: "/",
          meta: { itemId: item.id, target: item.target || null }
        });
      }
      processQueue().catch(() => {});
      return;
    }

    if (shouldWait(result)) {
      item.status = "waiting";
      item.error = result.error || result.target?.reason || "Codex Desktop is not ready.";
      item.updatedAt = nowIso();
      persistQueueItem(item);
      scheduleProcess();
      return;
    }

    item.status = "failed";
    item.error = result.error || "Desktop send failed.";
    item.updatedAt = nowIso();
    persistQueueItem(item);
  } finally {
    active = false;
  }
}

export function enqueueDesktopRemoteMessage(text, options = {}) {
  const item = {
    id: crypto.randomUUID(),
    text,
    permissionMode: options.permissionMode || "",
    model: options.model || "",
    reasoningEffort: options.reasoningEffort || "",
    settingsPolicy: options.settingsPolicy || "useExisting",
    target: options.target || null,
    settingsCheck: null,
    preflight: null,
    postflight: null,
    status: "queued",
    error: "",
    attempts: 0,
    result: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  queue.push(item);
  trimItems();
  persistQueueItem(item);
  processQueue().catch(() => {});
  return publicItem(item);
}

export async function getDesktopRemoteState({ fresh = false } = {}) {
  const desktop = await refreshDesktopStatus(fresh);
  maybeRunDesktopProbe().catch(() => {});
  return {
    ok: true,
    mode: "desktop-remote",
    active,
    desktop,
    items: queue.map(publicItem),
    pendingCount: queue.filter((item) => ["queued", "waiting", "checking", "sending"].includes(item.status)).length,
    probeHealth,
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
      persistQueueItem(item);
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
