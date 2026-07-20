const APPROVAL_DELIVERY = {
  pending: { tone: "pending", label: "Awaiting decision" },
  decision_recorded: { tone: "pending", label: "Decision recorded" },
  delivering: { tone: "pending", label: "Delivering decision" },
  delivered: { tone: "ok", label: "Delivered" },
  applied: { tone: "ok", label: "Applied" },
  stale: { tone: "warning", label: "Stale after reconnect" },
  outcome_unknown: { tone: "warning", label: "Outcome unknown" }
};

export function eventStreamId(kind, id) {
  const normalizedKind = String(kind || "").trim();
  const normalizedId = String(id || "").trim();
  if (!normalizedKind || !normalizedId) throw new Error("A stream id requires both kind and id.");
  return `${normalizedKind}:${normalizedId}`;
}

export function buildEventAck(streamId, cursor, expectedCursor = 0, eventId = "") {
  const nextCursor = Number(cursor || 0);
  const currentCursor = Number(expectedCursor || 0);
  if (!streamId || !Number.isSafeInteger(nextCursor) || nextCursor <= currentCursor) return null;
  return {
    streamId,
    cursor: nextCursor,
    expectedCursor: currentCursor,
    ...(eventId ? { eventId } : {})
  };
}

export function approvalDeliveryPresentation(approval = {}) {
  const status = approval.deliveryStatus || approval.status || "pending";
  const presentation = APPROVAL_DELIVERY[status] || { tone: "pending", label: status };
  const attachState = approval.execution?.attachState || "";
  const detail = attachState ? `Runtime ${attachState}` : "";
  return { ...presentation, detail };
}

export function retentionPresentation(plan = {}) {
  const blockers = Array.isArray(plan.blockedByDeviceIds) ? plan.blockedByDeviceIds : [];
  if (plan.safe === false || blockers.length) {
    return {
      tone: "warning",
      label: `Blocked by ${blockers.length} device${blockers.length === 1 ? "" : "s"}`,
      blockedByDeviceIds: blockers
    };
  }
  const cursor = Number(plan.compactThroughCursor || plan.safeCursor || 0);
  return {
    tone: "ok",
    label: cursor ? `Safe through cursor ${cursor}` : "No active blockers",
    blockedByDeviceIds: blockers
  };
}
