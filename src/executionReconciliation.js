const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "lost", "outcome_unknown"]);
const UNREACHABLE_CODES = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "EPIPE",
  "ECONNRESET",
  "EXECUTION_HOST_TIMEOUT",
  "EXECUTION_HOST_UNAVAILABLE",
  "EXECUTION_NOT_ATTACHED"
]);

function snapshotPatch(binding, snapshot) {
  const owner = snapshot.owner === "external" ? "external" : binding.owner;
  const status = snapshot.status || binding.status;
  let attachState = owner === "external" ? "external" : snapshot.attachState || "attached";
  if (status === "lost") attachState = "lost";
  return {
    id: binding.id,
    owner,
    status,
    attachState,
    workerPid: snapshot.workerPid ?? binding.workerPid,
    processPid: snapshot.processPid ?? binding.processPid,
    processStartedAt: snapshot.processStartedAt || binding.processStartedAt,
    workerInstanceId: snapshot.workerInstanceId || binding.workerInstanceId,
    protocolVersion: snapshot.protocolVersion || binding.protocolVersion,
    capabilities: snapshot.capabilities || binding.capabilities,
    lastSeenHostSeq: Math.max(binding.lastSeenHostSeq, Number(snapshot.lastHostSeq || 0)),
    endedAt: snapshot.endedAt || binding.endedAt,
    exitCode: snapshot.exitCode ?? binding.exitCode,
    signal: snapshot.signal || binding.signal
  };
}

function lostPatch(binding, reason) {
  return {
    id: binding.id,
    status: "lost",
    attachState: "lost",
    endedAt: new Date().toISOString(),
    lostReason: String(reason || "Execution is no longer known by execd.").slice(0, 2000)
  };
}

export function createExecutionStartupReconciler({
  persistence,
  host,
  projectEvent = () => {},
  restoreSubscription = async () => {},
  eventLimit = 128
} = {}) {
  if (!persistence || !host) throw new TypeError("Execution reconciliation requires persistence and host adapters.");

  async function reconcileBinding(binding) {
    if (binding.owner === "external") {
      const current = persistence.upsertExecutionBinding({ id: binding.id, attachState: "external" });
      await restoreSubscription(current, null);
      return current;
    }
    if (binding.owner !== "execution-host") return binding;

    persistence.upsertExecutionBinding({ id: binding.id, attachState: "reconnecting" });
    let snapshot;
    try {
      snapshot = await host.get(binding.id);
    } catch (error) {
      if (error?.code === "EXECUTION_NOT_FOUND") {
        return persistence.upsertExecutionBinding(lostPatch(binding, error.message));
      }
      if (UNREACHABLE_CODES.has(error?.code) || error?.retryable) {
        return persistence.upsertExecutionBinding({ id: binding.id, attachState: "unreachable" });
      }
      throw error;
    }

    let current = persistence.upsertExecutionBinding(snapshotPatch(binding, snapshot));
    if (current.attachState === "unreachable" && !TERMINAL_STATUSES.has(current.status)) return current;

    let cursor = current.lastIngestedHostSeq;
    while (cursor < Number(snapshot.lastHostSeq || 0)) {
      const page = await host.events(binding.id, cursor, eventLimit);
      const events = Array.isArray(page?.events) ? page.events : [];
      if (!events.length) break;
      for (const event of events) {
        const result = persistence.ingestExecutionEvent(binding.id, event, (normalized, db) => {
          projectEvent(current, normalized, db);
        });
        cursor = Math.max(cursor, Number(result.hostSeq || 0));
      }
    }

    current = persistence.getExecutionBinding(binding.id);
    if (current.lastIngestedHostSeq > current.lastAckedHostSeq) {
      await host.ack(binding.id, current.lastIngestedHostSeq, `bridge-startup-ack:${binding.id}:${current.lastIngestedHostSeq}`);
      current = persistence.ackExecutionEvents(binding.id, current.lastIngestedHostSeq);
    }
    await restoreSubscription(current, { ...snapshot, lastAckedHostSeq: current.lastAckedHostSeq });
    return current;
  }

  async function reconcile() {
    const bindings = persistence.listExecutionBindings({ activeOnly: true });
    const results = [];
    for (const binding of bindings) {
      try {
        results.push({ id: binding.id, binding: await reconcileBinding(binding) });
      } catch (error) {
        const current = persistence.upsertExecutionBinding({ id: binding.id, attachState: "unreachable" });
        results.push({ id: binding.id, binding: current, error });
      }
    }
    return results;
  }

  return { reconcile, reconcileBinding };
}
