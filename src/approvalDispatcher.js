import {
  claimApprovalOutboxCommands,
  getApprovalRequest,
  markApprovalOutboxCommandOutcomeUnknown,
  markApprovalOutboxCommandStale,
  retryApprovalOutboxCommand,
  settleApprovalContinuation
} from "./db.js";

const STALE_CODES = new Set(["APPROVAL_STALE", "APPROVAL_NOT_FOUND"]);

const defaultPersistence = {
  claim: claimApprovalOutboxCommands,
  getApproval: getApprovalRequest,
  delivered: (command, options) => settleApprovalContinuation(command.continuationRef, "delivered", options),
  applied: (command, options) => settleApprovalContinuation(command.continuationRef, "applied", options),
  stale: markApprovalOutboxCommandStale,
  outcomeUnknown: markApprovalOutboxCommandOutcomeUnknown,
  retry: retryApprovalOutboxCommand
};

export function createApprovalDispatcher({ resolveApproval, persistence = defaultPersistence, now = () => new Date().toISOString() } = {}) {
  if (typeof resolveApproval !== "function") throw new TypeError("resolveApproval is required.");

  async function dispatchOnce(options = {}) {
    const [command] = persistence.claim(options);
    if (!command) return null;
    const approval = persistence.getApproval(command.approvalId);
    const executionId = String(approval?.request?.executionId || "");
    if (!approval || !executionId || approval.continuationRef !== command.continuationRef) {
      return persistence.stale(command.id, {
        reason: "Approval continuation no longer identifies an execution."
      });
    }
    try {
      const result = await resolveApproval({
        executionId,
        approvalId: command.approvalId,
        continuationRef: command.continuationRef,
        expectedVersion: command.expectedVersion,
        decision: command.decision,
        operationId: command.operationId,
        afterHostSeq: Number(approval.request?.approvalHostSeq || 0)
      });
      persistence.delivered(command, { deliveredAt: result?.deliveredAt || now() });
      if (result?.stale) return persistence.stale(command.id, { reason: result.reason });
      if (result?.applied) {
        return persistence.applied(command, {
          deliveredAt: result.deliveredAt || now(),
          appliedAt: result.appliedAt || now()
        });
      }
      return persistence.delivered(command, { deliveredAt: result?.deliveredAt || now() });
    } catch (error) {
      if (STALE_CODES.has(error?.code)) {
        return persistence.stale(command.id, { reason: error.message });
      }
      if (error?.code === "OUTCOME_UNKNOWN") {
        return persistence.outcomeUnknown(command.id, { reason: error.message });
      }
      return persistence.retry(command.id, {
        error: error?.message || "Execution worker is unavailable.",
        nextAttemptAt: new Date(Date.parse(now()) + 1000).toISOString()
      });
    }
  }

  return { dispatchOnce };
}
