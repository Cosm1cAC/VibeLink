import crypto from "node:crypto";

function bridgeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function text(value, max = 2000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Provider-host side approval adapter. The persistence object is deliberately
 * injected so the adapter can be used by the HTTP bridge and by restart tests.
 */
export function createCodexApprovalBridge({ persistence, sendDecision, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() } = {}) {
  if (!persistence?.recordApprovalDecision || !persistence?.claimApprovalOutbox) throw new TypeError("Approval persistence is required.");
  if (typeof sendDecision !== "function") throw new TypeError("sendDecision is required.");
  const continuations = new Map();

  function register(request = {}) {
    const continuationRef = text(request.continuationRef, 2000) || `codex:${text(request.threadId, 160)}:${text(request.turnId, 160)}:${text(request.itemId, 160)}:${text(request.requestId, 160)}`;
    if (!continuationRef) throw bridgeError("APPROVAL_DECISION_INVALID", "continuationRef is required.");
    const record = { ...request, continuationRef, registeredAt: now() };
    continuations.set(continuationRef, record);
    return record;
  }

  function resolve(input = {}) {
    const continuationRef = text(input.continuationRef, 2000);
    const continuation = continuations.get(continuationRef);
    if (!continuation) throw bridgeError("APPROVAL_STALE", "Approval continuation is no longer attached.");
    return persistence.recordApprovalDecision({
      approvalId: text(input.approvalId || continuation.approvalId, 160),
      operationId: text(input.operationId, 160) || uuid(),
      continuationRef,
      expectedDecisionVersion: input.expectedDecisionVersion,
      decision: input.decision,
      reason: input.reason,
      deviceId: input.deviceId
    });
  }

  async function dispatchOnce(options = {}) {
    const [command] = persistence.claimApprovalOutbox(options);
    if (!command) return null;
    try {
      const result = await sendDecision(command, continuations.get(command.continuationRef) || null);
      if (result?.stale) return persistence.markApprovalOutboxStale(command.id, { reason: result.reason });
      if (result?.outcomeUnknown) return persistence.markApprovalOutboxOutcomeUnknown(command.id, { reason: result.reason });
      if (result?.delivered === false) {
        return persistence.retryApprovalOutbox(command.id, { error: result.reason || "Provider did not accept the decision." });
      }
      persistence.markApprovalOutboxDelivered?.(command.id, { deliveredAt: result?.deliveredAt || now() });
      return persistence.markApprovalOutboxApplied(command.id, { appliedAt: result?.appliedAt || now(), deliveredAt: result?.deliveredAt || now() });
    } catch (error) {
      if (["APPROVAL_STALE", "OUTCOME_UNKNOWN"].includes(error?.code)) {
        return error.code === "APPROVAL_STALE"
          ? persistence.markApprovalOutboxStale(command.id, { reason: error.message })
          : persistence.markApprovalOutboxOutcomeUnknown(command.id, { reason: error.message });
      }
      return persistence.retryApprovalOutbox(command.id, { error: error?.message || "Provider transport failed." });
    }
  }

  function detach(continuationRef) {
    continuations.delete(text(continuationRef, 2000));
  }

  return { register, resolve, dispatchOnce, detach, continuations };
}
