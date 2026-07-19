const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export { createBrowserSessionRuntime, createBrowserTraceRedactor } from "./browserSessionRuntime.js";

function compact(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanText(value = "") {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlMeta(html = "", name = "") {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta\\s+[^>]*(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`, "i");
  const match = String(html || "").match(pattern);
  return match?.[1] ? compact(match[1], 500) : "";
}

function htmlTitle(html = "") {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? cleanText(match[1]).slice(0, 240) : "";
}

function normalizeFetchUrl(value = "") {
  let parsed = null;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    const error = new Error("Browser fetch URL is invalid.");
    error.status = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error("Browser fetch only supports http and https URLs.");
    error.status = 400;
    throw error;
  }
  if (parsed.username || parsed.password) {
    const error = new Error("Browser fetch URLs must not include embedded credentials.");
    error.status = 400;
    throw error;
  }
  return parsed.toString();
}

async function readLimitedBody(response, maxBytes, emitProgress) {
  const chunks = [];
  let total = 0;
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      body: buffer.slice(0, maxBytes).toString("utf8"),
      bytes: buffer.length,
      truncated: buffer.length > maxBytes
    };
  }

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    const remaining = maxBytes - total;
    if (remaining > 0) chunks.push(chunk.slice(0, remaining));
    total += chunk.length;
    emitProgress?.({ phase: "download", bytes: total });
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      break;
    }
  }
  return {
    body: Buffer.concat(chunks).toString("utf8"),
    bytes: total,
    truncated: total > maxBytes
  };
}

function summarizeBody(body = "", contentType = "") {
  const isHtml = /html/i.test(contentType) || /<html|<!doctype html/i.test(body);
  if (isHtml) {
    const text = cleanText(body);
    return {
      kind: "html",
      title: htmlTitle(body),
      description: htmlMeta(body, "description") || htmlMeta(body, "og:description"),
      textSample: text.slice(0, 4000)
    };
  }
  const text = String(body || "");
  return {
    kind: /json/i.test(contentType) ? "json" : /text/i.test(contentType) ? "text" : "binary-or-unknown",
    title: "",
    description: "",
    textSample: text.replace(/\s+/g, " ").trim().slice(0, 4000)
  };
}

export function browserFetchRisk(url = "", policy = {}) {
  const reasons = [];
  const matches = [];
  if (policy.networkAccess === false) {
    reasons.push("network access is disabled");
    matches.push({ code: "browser_network", severity: "medium", reason: "browser fetch needs network access", policy: "networkAccess=false" });
  }
  return {
    risky: matches.length > 0,
    required: matches.length > 0,
    reasons,
    matches,
    network: { usesNetwork: true, reasons: ["browser fetch uses network"], matches: [{ code: "browser_fetch", severity: "low", reason: "browser fetch uses network" }] },
    url: String(url || "")
  };
}

export async function fetchBrowserPage(input = {}, { emitProgress = null } = {}) {
  const url = normalizeFetchUrl(input.url || "");
  const timeoutMs = Math.min(60000, Math.max(1000, Number(input.timeoutMs || DEFAULT_TIMEOUT_MS)));
  const maxBytes = Math.min(5 * 1024 * 1024, Math.max(1024, Number(input.maxBytes || DEFAULT_MAX_BYTES)));
  const startedAt = new Date().toISOString();
  emitProgress?.({ phase: "request", url, timeoutMs, maxBytes });

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "user-agent": "VibeLink/0.1 browser.fetch"
    }
  });
  const contentType = response.headers.get("content-type") || "";
  emitProgress?.({
    phase: "response",
    url: response.url || url,
    status: response.status,
    statusText: response.statusText,
    contentType
  });
  const downloaded = await readLimitedBody(response, maxBytes, emitProgress);
  const summary = summarizeBody(downloaded.body, contentType);

  return {
    ok: response.ok,
    url,
    finalUrl: response.url || url,
    status: response.status,
    statusText: response.statusText,
    contentType,
    bytes: downloaded.bytes,
    truncated: downloaded.truncated,
    title: summary.title,
    description: summary.description,
    textSample: summary.textSample,
    bodyKind: summary.kind,
    startedAt,
    completedAt: new Date().toISOString()
  };
}
