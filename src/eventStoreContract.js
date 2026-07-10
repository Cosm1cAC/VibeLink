export const EVENT_STORE_SIDECAR_PROTOCOL_VERSION = 1;

export const EVENT_STORE_CONTRACT_METHODS = Object.freeze([
  "insertTaskEvent",
  "insertTaskEvents",
  "listTaskEvents",
  "getTaskEventCount",
  "insertToolEvent",
  "insertToolEvents",
  "listToolEvents",
  "getToolEventStats",
  "pruneToolEvents",
  "insertLiveCallEvent",
  "insertLiveCallEvents",
  "listLiveCallEvents",
  "pruneLiveCallEvents",
  "listUnifiedEvents",
  "replayWindow"
]);

export const EVENT_STORE_SIDECAR_CONTROL_METHODS = Object.freeze([
  "__health",
  "stats",
  "__close"
]);

export function serializeEventStoreError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
    code: error?.code || ""
  };
}

export function eventStoreErrorFromPayload(payload = {}) {
  const error = new Error(payload.message || "Event store request failed.");
  error.name = payload.name || "Error";
  if (payload.stack) error.stack = payload.stack;
  if (payload.code) error.code = payload.code;
  return error;
}
