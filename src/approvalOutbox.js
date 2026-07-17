import crypto from "node:crypto";

const MAX_DECISION_BYTES = 64 * 1024;

function outboxError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function cleanString(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function fromJson(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function decisionJson(value) {
  let serialized;
  try {
    serialized = JSON.stringify(sortJson(value ?? null));
  } catch {
    throw outboxError("APPROVAL_DECISION_INVALID", "Decision must be JSON serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_DECISION_BYTES) {
    throw outboxError("APPROVAL_DECISION_INVALID", "Decision is too large.", { maxBytes: MAX_DECISION_BYTES });
  }
  return serialized;
}

function decisionName(value) {
  const candidate = typeof value === "string" ? value : value?.decision || value?.type;
  const name = cleanString(candidate, 80);
  if (!name) throw outboxError("APPROVAL_DECISION_INVALID", "Decision type is required.");
  return name;
}

function approvalStatus(name) {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.includes("accept") || normalized.includes("approv") || normalized.includes("grant")) return "approved";
  if (normalized.includes("deny") || normalized.includes("deni") || normalized.includes("declin") || normalized.includes("cancel")) return "denied";
  throw outboxError("APPROVAL_DECISION_INVALID", "Decision type is not supported.", { decision: name });
}

function publicApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    continuationRef: row.continuation_ref || "",
    decisionVersion: Number(row.decision_version || 0),
    deliveryStatus: row.delivery_status || "pending",
    decision: fromJson(row.decision_json, null),
    expiresAt: row.expires_at || "",
    decidedAt: row.decided_at || ""
  };
}

function publicOutbox(row) {
  if (!row) return null;
  return {
    id: row.id,
    approvalId: row.approval_id,
    operationId: row.operation_id,
    continuationRef: row.continuation_ref,
    decision: fromJson(row.decision_json, null),
    status: row.status,
    attempts: Number(row.attempts || 0),
    nextAttemptAt: row.next_attempt_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at || "",
    appliedAt: row.applied_at || "",
    lastError: row.last_error || ""
  };
}

export function createApprovalOutboxPersistence({
  database,
  now = () => new Date().toISOString(),
  uuid = () => crypto.randomUUID()
} = {}) {
  if (typeof database !== "function") throw new TypeError("A database function is required.");

  function getApproval(id) {
    return publicApproval(database().prepare("SELECT * FROM approval_requests WHERE id = ?").get(cleanString(id, 160)));
  }

  function getApprovalOutbox(id) {
    return publicOutbox(database().prepare("SELECT * FROM approval_outbox WHERE id = ?").get(cleanString(id, 160)));
  }

  function duplicateResult(db, row, expected) {
    if (
      row.approval_id !== expected.approvalId ||
      row.continuation_ref !== expected.continuationRef ||
      row.decision_json !== expected.serializedDecision
    ) {
      throw outboxError("OPERATION_CONFLICT", "Operation id is already bound to a different approval decision.");
    }
    return {
      approval: publicApproval(db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(row.approval_id)),
      outbox: publicOutbox(row),
      duplicate: true
    };
  }

  function recordApprovalDecision(input = {}) {
    const approvalId = cleanString(input.approvalId, 160);
    const operationId = cleanString(input.operationId, 160);
    const continuationRef = cleanString(input.continuationRef, 2000);
    if (!approvalId || !operationId || !continuationRef) {
      throw outboxError("APPROVAL_DECISION_INVALID", "Approval, operation, and continuation ids are required.");
    }
    const name = decisionName(input.decision);
    const status = approvalStatus(name);
    const serializedDecision = decisionJson(input.decision);
    const expectedDecisionVersion = Number(input.expectedDecisionVersion);
    if (!Number.isSafeInteger(expectedDecisionVersion) || expectedDecisionVersion < 0) {
      throw outboxError("APPROVAL_DECISION_INVALID", "Expected decision version is required.");
    }
    const expected = { approvalId, continuationRef, serializedDecision };
    const db = database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const operation = db.prepare("SELECT * FROM approval_outbox WHERE operation_id = ?").get(operationId);
      if (operation) {
        const result = duplicateResult(db, operation, expected);
        db.exec("COMMIT");
        return result;
      }
      const prior = db.prepare("SELECT * FROM approval_outbox WHERE approval_id = ?").get(approvalId);
      if (prior) {
        if (prior.continuation_ref === continuationRef && prior.decision_json === serializedDecision) {
          const result = duplicateResult(db, prior, expected);
          db.exec("COMMIT");
          return result;
        }
        throw outboxError("APPROVAL_ALREADY_DECIDED", "Approval already has a different decision.");
      }

      const approval = db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(approvalId);
      if (!approval) throw outboxError("APPROVAL_NOT_FOUND", "Approval does not exist.");
      const current = now();
      if (
        approval.status !== "pending" ||
        (approval.expires_at && new Date(approval.expires_at).getTime() <= new Date(current).getTime()) ||
        approval.continuation_ref !== continuationRef ||
        Number(approval.decision_version || 0) !== expectedDecisionVersion
      ) {
        throw outboxError("APPROVAL_STALE", "Approval continuation is no longer current.");
      }
      const available = fromJson(approval.available_decisions_json, []);
      if (Array.isArray(available) && available.length) {
        const allowedNames = available.map((item) => decisionName(item));
        if (!allowedNames.includes(name)) {
          throw outboxError("APPROVAL_DECISION_INVALID", "Decision is not available for this approval.", { decision: name });
        }
      }

      const outboxId = uuid();
      const reason = cleanString(input.reason, 2000);
      const deviceId = cleanString(input.deviceId, 160);
      db.prepare(`
        UPDATE approval_requests SET
          status = ?, updated_at = ?, decided_at = ?, decided_by_device_id = ?,
          decision_reason = ?, decision_json = ?, decision_version = ?,
          delivery_status = 'decision_recorded'
        WHERE id = ?
      `).run(
        status,
        current,
        current,
        deviceId,
        reason,
        serializedDecision,
        expectedDecisionVersion + 1,
        approvalId
      );
      db.prepare(`
        INSERT INTO approval_decisions (
          id, approval_id, tool_run_id, task_id, workspace_id, decision,
          reason, device_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(),
        approvalId,
        approval.tool_run_id || "",
        approval.task_id || "",
        approval.workspace_id || "",
        status,
        reason,
        deviceId,
        serializedDecision,
        current
      );
      db.prepare(`
        INSERT INTO approval_outbox (
          id, approval_id, operation_id, continuation_ref, decision_json,
          status, attempts, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'decision_recorded', 0, ?, ?, ?)
      `).run(outboxId, approvalId, operationId, continuationRef, serializedDecision, current, current, current);
      db.exec("COMMIT");
      return { approval: getApproval(approvalId), outbox: getApprovalOutbox(outboxId), duplicate: false };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function claimApprovalOutbox({ at = now(), limit = 20 } = {}) {
    const current = cleanString(at, 80) || now();
    const boundedLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
    const db = database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = db.prepare(`
        SELECT id FROM approval_outbox
        WHERE status = 'decision_recorded' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC LIMIT ?
      `).all(current, boundedLimit);
      for (const row of rows) {
        db.prepare(`
          UPDATE approval_outbox
          SET status = 'delivering', attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND status = 'decision_recorded'
        `).run(current, row.id);
      }
      db.exec("COMMIT");
      return rows.map((row) => getApprovalOutbox(row.id));
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function retryApprovalOutbox(id, { error = "", nextAttemptAt = now() } = {}) {
    const result = database().prepare(`
      UPDATE approval_outbox SET
        status = 'decision_recorded', next_attempt_at = ?, updated_at = ?, last_error = ?
      WHERE id = ? AND status = 'delivering'
    `).run(cleanString(nextAttemptAt, 80), now(), cleanString(error, 2000), cleanString(id, 160));
    if (result.changes !== 1) throw outboxError("OUTBOX_STATE_CONFLICT", "Outbox command is not delivering.");
    return getApprovalOutbox(id);
  }

  function markApprovalOutboxApplied(id, { deliveredAt = now(), appliedAt = now() } = {}) {
    const outboxId = cleanString(id, 160);
    const db = database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare("SELECT * FROM approval_outbox WHERE id = ?").get(outboxId);
      if (!existing || existing.status !== "delivering") {
        throw outboxError("OUTBOX_STATE_CONFLICT", "Outbox command is not delivering.");
      }
      db.prepare(`
        UPDATE approval_outbox SET
          status = 'applied', updated_at = ?, delivered_at = ?, applied_at = ?, last_error = ''
        WHERE id = ?
      `).run(now(), cleanString(deliveredAt, 80), cleanString(appliedAt, 80), outboxId);
      db.prepare("UPDATE approval_requests SET delivery_status = 'applied', updated_at = ? WHERE id = ?")
        .run(now(), existing.approval_id);
      db.exec("COMMIT");
      return getApprovalOutbox(outboxId);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  return {
    getApproval,
    getApprovalOutbox,
    recordApprovalDecision,
    claimApprovalOutbox,
    retryApprovalOutbox,
    markApprovalOutboxApplied
  };
}
