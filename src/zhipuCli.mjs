#!/usr/bin/env node
import process from "node:process";

const DEFAULT_MODEL = "glm-5.2";
const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_TIMEOUT_MS = 120000;

function parseArgs(argv) {
  const args = {
    json: false,
    prompt: "",
    model: DEFAULT_MODEL,
    effort: "",
    timeoutMs: DEFAULT_TIMEOUT_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--json") args.json = true;
    else if (item === "--prompt") args.prompt = argv[++index] || "";
    else if (item === "--model") args.model = argv[++index] || DEFAULT_MODEL;
    else if (item === "--effort") args.effort = argv[++index] || "";
    else if (item === "--timeout-ms") args.timeoutMs = Number(argv[++index] || DEFAULT_TIMEOUT_MS);
  }

  return args;
}

function fail(code, message, suggestion = "") {
  const payload = {
    ok: false,
    error: {
      code,
      message,
      recoverable: code !== "UNKNOWN_ERROR",
      ...(suggestion ? { suggestion } : {})
    }
  };
  console.log(JSON.stringify(payload));
  process.exitCode = 1;
}

function buildRequestBody(args) {
  const system = "You are VibeLink Agent running through the Zhipu/GLM provider adapter.";
  const messages = [
    { role: "system", content: system },
    { role: "user", content: args.prompt }
  ];

  const body = {
    model: args.model || DEFAULT_MODEL,
    messages,
    stream: false
  };

  if (args.effort) {
    body.extra = { reasoning_effort: args.effort };
  }

  return body;
}

function extractText(payload) {
  const choice = payload?.choices?.[0] || {};
  const content = choice.message?.content ?? choice.delta?.content ?? "";
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || "").join("");
  }
  return String(content || payload?.text || "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt.trim()) {
    fail("PROMPT_REQUIRED", "Zhipu provider requires a prompt.");
    return;
  }

  const apiKey = process.env.ZHIPU_API_KEY || "";
  if (!apiKey) {
    fail("MISSING_API_KEY", "ZHIPU_API_KEY is not configured.", "Add a Zhipu/GLM API key in VibeLink Settings.");
    return;
  }

  const controller = new AbortController();
  const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? Math.min(args.timeoutMs, 600000) : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(process.env.ZHIPU_BASE_URL || DEFAULT_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(buildRequestBody(args)),
      signal: controller.signal
    });

    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      fail("HTTP_ERROR", payload?.error?.message || raw || `Zhipu request failed with HTTP ${response.status}.`);
      return;
    }

    const text = extractText(payload);
    console.log(JSON.stringify({
      ok: true,
      provider: "zhipu",
      model: args.model || DEFAULT_MODEL,
      text,
      elapsedMs: Date.now() - startedAt,
      raw: payload
    }));
  } catch (error) {
    const aborted = error?.name === "AbortError";
    fail(aborted ? "TIMEOUT" : "UNKNOWN_ERROR", aborted ? "Zhipu request timed out." : error?.message || String(error));
  } finally {
    clearTimeout(timer);
  }
}

await main();
