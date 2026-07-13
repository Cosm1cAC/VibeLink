import { createStatusSidecarClient } from "./statusSidecarClient.js";

function enabled(value) {
  return ["1", "true", "on", "opt-in"].includes(String(value || "").trim().toLowerCase());
}

function sidecarArgs(env) {
  try {
    const parsed = JSON.parse(env.VIBELINK_CONTROL_PLANE_RUST_SIDECAR_ARGS_JSON || "[]");
    if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
  } catch {}
  return ["status-sidecar"];
}

function timeoutValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5000;
}

export function createStatusRuntime({ env = process.env, cwd = process.cwd(), logger = console } = {}) {
  const rustEnabled = enabled(env.VIBELINK_RUST_STATUS);
  const command = String(env.VIBELINK_CONTROL_PLANE_RUST_SIDECAR_COMMAND || "").trim();
  const timeoutMs = timeoutValue(env.VIBELINK_CONTROL_PLANE_RUST_SIDECAR_TIMEOUT_MS);
  let client = null;
  let ready = false;
  let failed = false;
  let attempts = 0;
  let rustResponses = 0;
  let fallbacks = 0;
  let lastError = "";

  async function ensureReady() {
    if (ready) return client;
    if (!command) throw new Error("Rust status sidecar command is not configured.");
    client ||= createStatusSidecarClient({ command, args: sidecarArgs(env), cwd, env, timeoutMs });
    const health = await client.health();
    if (!health?.ok || health.implementation !== "rust" || health.protocolVersion !== 1) {
      throw new Error("Rust status sidecar health check failed.");
    }
    ready = true;
    return client;
  }

  async function fallback(snapshot, error) {
    failed = true;
    ready = false;
    fallbacks += 1;
    lastError = error?.message || String(error);
    logger.warn?.(`[status] Rust sidecar failed; falling back: ${lastError}`);
    await client?.close().catch(() => {});
    return snapshot;
  }

  async function render(snapshot) {
    if (!rustEnabled) return snapshot;
    attempts += 1;
    if (failed) {
      fallbacks += 1;
      return snapshot;
    }
    try {
      const active = await ensureReady();
      const result = await active.renderStatus(snapshot);
      rustResponses += 1;
      return result;
    } catch (error) {
      return fallback(snapshot, error);
    }
  }

  function stats() {
    return {
      enabled: rustEnabled,
      available: Boolean(command),
      ready,
      failed,
      mode: !rustEnabled ? "node" : failed ? "node-fallback" : ready ? "rust-sidecar" : "rust-pending",
      attempts,
      rustResponses,
      fallbacks,
      lastError,
      client: client?.stats() || null
    };
  }

  async function close() {
    await client?.close().catch(() => {});
    client = null;
    ready = false;
  }

  return { render, stats, close };
}

const defaultRuntime = createStatusRuntime();

export const renderStatusPayload = (snapshot) => defaultRuntime.render(snapshot);
export const getStatusRuntimeStats = () => defaultRuntime.stats();
export const closeStatusRuntime = () => defaultRuntime.close();
