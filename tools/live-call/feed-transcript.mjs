#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

const DEFAULT_URL = "http://127.0.0.1:8787";
const DEFAULT_TEXT = "请问你如何排查线上故障，并保证类似问题不再发生？";

function parseArgs(argv) {
  const options = {
    url: process.env.VIBELINK_URL || DEFAULT_URL,
    token: process.env.VIBELINK_TOKEN || process.env.MOBILE_AGENT_DEVICE_TOKEN || "",
    sessionId: "",
    title: "Mock ASR Live Call",
    source: "mock-asr-feed",
    text: DEFAULT_TEXT,
    file: "",
    speaker: "remote",
    chunkSize: 8,
    delayMs: 350,
    partial: true,
    answer: "",
    verify: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === "--url") options.url = next();
    else if (arg === "--token") options.token = next();
    else if (arg === "--session" || arg === "--session-id") options.sessionId = next();
    else if (arg === "--title") options.title = next();
    else if (arg === "--source") options.source = next();
    else if (arg === "--text") options.text = next();
    else if (arg === "--file") options.file = next();
    else if (arg === "--speaker") options.speaker = next();
    else if (arg === "--chunk-size") options.chunkSize = Math.max(1, Number(next()) || 8);
    else if (arg === "--delay-ms") options.delayMs = Math.max(0, Number(next()) || 0);
    else if (arg === "--no-partial") options.partial = false;
    else if (arg === "--answer") options.answer = next();
    else if (arg === "--no-verify") options.verify = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.url = options.url.replace(/\/+$/, "");
  return options;
}

function usage() {
  return `Usage: npm run live-call:feed-transcript -- [options]

Options:
  --url URL          VibeLink bridge URL. Default: ${DEFAULT_URL}
  --token TOKEN      Device token. Or set VIBELINK_TOKEN.
  --session ID       Existing live-call session id. Creates one if omitted.
  --text TEXT        Transcript text to feed.
  --file PATH        Read transcript text from a UTF-8 file.
  --speaker NAME     Speaker label. Default: remote.
  --chunk-size N     Characters added per partial event. Default: 8.
  --delay-ms N       Delay between partial events. Default: 350.
  --no-partial       Send only the final transcript.
  --answer TEXT      Optional answer to push as live_call.agent.done.
  --no-verify        Skip event verification.
`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(options, pathValue, init = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(init.headers || {})
  };
  const response = await fetch(`${options.url}${pathValue}`, { ...init, headers });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const hint = response.status === 401 ? " Pass --token or set VIBELINK_TOKEN to a valid device token." : "";
    throw new Error(`${init.method || "GET"} ${pathValue} failed: HTTP ${response.status} ${data.error || text}${hint}`);
  }
  return data;
}

async function createOrLoadSession(options) {
  if (options.sessionId) {
    const result = await request(options, `/api/live-calls/${encodeURIComponent(options.sessionId)}`);
    return result.session;
  }
  const result = await request(options, "/api/live-calls", {
    method: "POST",
    body: JSON.stringify({ title: options.title, source: options.source })
  });
  return result.session;
}

function transcriptText(options) {
  if (options.file) return fs.readFileSync(options.file, "utf8").trim();
  return String(options.text || "").trim();
}

function partialChunks(text, chunkSize) {
  const chars = Array.from(text);
  const chunks = [];
  for (let size = Math.min(chunkSize, chars.length); size < chars.length; size += chunkSize) {
    chunks.push(chars.slice(0, size).join(""));
  }
  return chunks;
}

async function postTranscript(options, sessionId, text, final) {
  const result = await request(options, `/api/live-calls/${encodeURIComponent(sessionId)}/transcript`, {
    method: "POST",
    body: JSON.stringify({ text, final, speaker: options.speaker })
  });
  process.stdout.write(`${JSON.stringify({ type: final ? "mock_asr.final" : "mock_asr.partial", sessionId, text })}\n`);
  return result.session;
}

function eventTypes(events) {
  return new Set((events || []).map((event) => event.type));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const text = transcriptText(options);
  if (!text) throw new Error("Transcript text is empty.");
  const session = await createOrLoadSession(options);
  let partialCount = 0;

  if (options.partial) {
    for (const chunk of partialChunks(text, options.chunkSize)) {
      await postTranscript(options, session.id, chunk, false);
      partialCount += 1;
      if (options.delayMs) await sleep(options.delayMs);
    }
  }

  await postTranscript(options, session.id, text, true);
  if (options.answer) {
    await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ text: options.answer })
    });
  }

  const events = options.verify
    ? (await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/events/catch-up?limit=1000`)).items || []
    : [];
  const types = eventTypes(events);
  if (options.verify) {
    if (!types.has("live_call.started")) throw new Error("Verification failed: missing live_call.started");
    if (options.partial && !types.has("live_call.transcript.partial")) throw new Error("Verification failed: missing live_call.transcript.partial");
    if (!types.has("live_call.transcript.final")) throw new Error("Verification failed: missing live_call.transcript.final");
    if (/[?？]|什么|如何|怎么|为什么|介绍|经验|项目|问题|请问|能否|是否|怎样|多少|哪里|哪/.test(text) && !types.has("live_call.question.detected")) {
      throw new Error("Verification failed: missing live_call.question.detected");
    }
    if (options.answer && !types.has("live_call.agent.done")) throw new Error("Verification failed: missing live_call.agent.done");
  }

  const finalSession = (await request(options, `/api/live-calls/${encodeURIComponent(session.id)}`)).session;
  process.stdout.write(`${JSON.stringify({ ok: true, session: finalSession, partialCount, finalText: text, eventTypes: [...types] }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
