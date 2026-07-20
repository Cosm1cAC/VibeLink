const STREAM_ID_PATTERN = /^(task|live-call|tool-event):[^:][\s\S]{0,159}$/;

function validStreamId(value) {
  return STREAM_ID_PATTERN.test(String(value || "").trim());
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function createEventSyncHttpHandler({
  readBody,
  sendJson,
  getEventAck,
  upsertEventAck,
  listEventAcks,
  planRetention,
  compactEvents,
  listCompactionMarkers,
  enforceRateLimit = () => true,
  audit = () => {}
}) {
  return async function routeEventSyncRequest(request, response, url, auth) {
    if (url.pathname === "/api/events/ack" && request.method === "POST") {
      if (!enforceRateLimit(request, response, url, "events.ack", { limit: 240, windowMs: 60 * 1000 }, auth)) return true;
      const body = await readBody(request);
      const streamId = String(body.streamId || "").trim();
      const deviceId = String(auth?.device?.id || "").trim();
      const rawCursor = Number(body.cursor);
      const cursor = Math.max(0, Math.floor(rawCursor));
      if (!deviceId || !validStreamId(streamId) || !Number.isFinite(rawCursor) || rawCursor < 0) {
        sendJson(response, 400, { error: "A valid streamId, cursor, and authenticated device are required." });
        return true;
      }
      const current = getEventAck(deviceId, streamId);
      if (body.expectedCursor !== undefined && numberOr(body.expectedCursor, -1) !== Number(current?.cursor || 0)) {
        sendJson(response, 409, {
          error: "Event acknowledgement changed on another client.",
          code: "EVENT_ACK_CONFLICT",
          current
        });
        return true;
      }
      const ack = upsertEventAck(deviceId, streamId, cursor, {
        eventId: body.eventId || "",
        metadata: body.metadata || {}
      });
      audit(request, url, auth, { type: "events.ack", success: true, target: streamId, meta: { cursor: ack.cursor } });
      sendJson(response, 200, { ok: true, ack });
      return true;
    }

    if (url.pathname === "/api/events/acks" && request.method === "GET") {
      const streamId = url.searchParams.get("streamId") || "";
      sendJson(response, 200, { items: listEventAcks({ streamId }) });
      return true;
    }

    if (url.pathname === "/api/events/retention-plan" && request.method === "GET") {
      const streamId = url.searchParams.get("streamId") || "";
      if (!validStreamId(streamId)) {
        sendJson(response, 400, { error: "A valid streamId is required." });
        return true;
      }
      sendJson(response, 200, planRetention({
        streamId,
        retentionDays: numberOr(url.searchParams.get("retentionDays"), 30),
        keepLatest: numberOr(url.searchParams.get("keepLatest"), 5000)
      }));
      return true;
    }

    if (url.pathname === "/api/events/compact" && request.method === "POST") {
      if (!enforceRateLimit(request, response, url, "events.compact", { limit: 20, windowMs: 60 * 1000 }, auth)) return true;
      const body = await readBody(request);
      if (!validStreamId(body.streamId)) {
        sendJson(response, 400, { error: "A valid streamId is required." });
        return true;
      }
      const result = compactEvents({
        streamId: body.streamId,
        retentionDays: numberOr(body.retentionDays, 30),
        keepLatest: numberOr(body.keepLatest, 5000),
        spoolQuotaBytes: numberOr(body.spoolQuotaBytes, 0),
        dryRun: body.dryRun !== false
      });
      audit(request, url, auth, {
        type: "events.compact",
        success: true,
        target: body.streamId,
        meta: { dryRun: result.dryRun, prunable: result.prunable, deleted: result.deleted, quotaExceeded: result.quotaExceeded }
      });
      sendJson(response, 200, result);
      return true;
    }

    if (url.pathname === "/api/events/compaction-markers" && request.method === "GET") {
      sendJson(response, 200, {
        items: listCompactionMarkers({
          streamId: url.searchParams.get("streamId") || "",
          afterCursor: numberOr(url.searchParams.get("after"), 0),
          limit: numberOr(url.searchParams.get("limit"), 100)
        })
      });
      return true;
    }
    return false;
  };
}
