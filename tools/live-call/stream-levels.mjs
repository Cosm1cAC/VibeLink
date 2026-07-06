#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";
import process from "node:process";

const DEFAULT_URL = "http://127.0.0.1:8787";

function parseArgs(argv) {
  const options = {
    url: process.env.VIBELINK_URL || DEFAULT_URL,
    token: process.env.VIBELINK_TOKEN || process.env.MOBILE_AGENT_DEVICE_TOKEN || "",
    sessionId: "",
    title: "Windows Live Level Stream",
    source: "windows-audio-level",
    seconds: 30,
    intervalMs: 500,
    render: "",
    capture: "",
    transcript: "",
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
    else if (arg === "--seconds" || arg === "-s") options.seconds = Math.max(0, Number(next()) || 0);
    else if (arg === "--interval-ms" || arg === "-i") options.intervalMs = Math.max(100, Number(next()) || 500);
    else if (arg === "--render") options.render = next();
    else if (arg === "--capture") options.capture = next();
    else if (arg === "--transcript" || arg === "--text") options.transcript = next();
    else if (arg === "--answer") options.answer = next();
    else if (arg === "--no-verify") options.verify = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.url = options.url.replace(/\/+$/, "");
  return options;
}

function usage() {
  return `Usage: npm run live-call:stream-levels -- [options]

Options:
  --url URL             VibeLink bridge URL. Default: ${DEFAULT_URL}
  --token TOKEN         Device token. Or set VIBELINK_TOKEN.
  --session ID          Existing live-call session id. Creates one if omitted.
  --seconds N           Stream duration. 0 means until interrupted. Default: 30.
  --interval-ms N       Level interval. Default: 500.
  --render ID           Windows render device id.
  --capture ID          Windows capture device id.
  --transcript TEXT     Optional final transcript to push after streaming.
  --answer TEXT         Optional answer to push after streaming.
  --no-verify           Skip event verification.
`;
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

function buildLevelArgs(options) {
  const args = ["run", "--project", "tools/windows-audio-probe", "--", "level", "--seconds", String(options.seconds), "--interval-ms", String(options.intervalMs)];
  if (options.render) args.push("--render", options.render);
  if (options.capture) args.push("--capture", options.capture);
  return args;
}

function normalizeLevel(channel, item = {}) {
  const levels = item.levels || {};
  return {
    channel,
    bytes: Number(item.bytes || 0),
    peak: Number(levels.peak || 0),
    rms: Number(levels.rms || 0),
    deviceName: String(item.deviceName || "").slice(0, 240)
  };
}

async function pushLevel(options, sessionId, channel, item) {
  const payload = normalizeLevel(channel, item);
  await request(options, `/api/live-calls/${encodeURIComponent(sessionId)}/level`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return payload;
}

async function streamLevels(options, sessionId) {
  const child = spawn("dotnet", buildLevelArgs(options), {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let remoteEvents = 0;
  let localEvents = 0;
  let lastRemote = null;
  let lastLocal = null;
  let helperStarted = false;

  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

  for await (const line of rl) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      process.stderr.write(`Skipping non-JSON helper output: ${line}\n`);
      continue;
    }
    if (event.type === "audio.level.started") {
      helperStarted = true;
      process.stdout.write(`${JSON.stringify({ type: "live_call.level_stream.started", sessionId, helper: event })}\n`);
      continue;
    }
    if (event.type === "audio.level") {
      lastRemote = await pushLevel(options, sessionId, "remote", event.remote);
      lastLocal = await pushLevel(options, sessionId, "local", event.local);
      remoteEvents += 1;
      localEvents += 1;
      process.stdout.write(`${JSON.stringify({ type: "live_call.level_stream.tick", sessionId, elapsedMs: event.elapsedMs, remote: lastRemote, local: lastLocal })}\n`);
      continue;
    }
    if (event.type === "audio.level.stopped") {
      process.stdout.write(`${JSON.stringify({ type: "live_call.level_stream.stopped", sessionId, helper: event })}\n`);
    }
  }

  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  if (exitCode !== 0) {
    throw new Error(`windows-audio-probe level exited with ${exitCode}: ${stderrChunks.join("").trim()}`);
  }
  if (!helperStarted) throw new Error("windows-audio-probe level did not emit a start event.");
  return { remoteEvents, localEvents, lastRemote, lastLocal };
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

  const session = await createOrLoadSession(options);
  const levelSummary = await streamLevels(options, session.id);

  if (options.transcript) {
    await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/transcript`, {
      method: "POST",
      body: JSON.stringify({ text: options.transcript, final: true, speaker: "remote" })
    });
  }
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
    if (!types.has("live_call.audio_level")) throw new Error("Verification failed: missing live_call.audio_level");
    if (levelSummary.remoteEvents <= 0 || levelSummary.localEvents <= 0) throw new Error("Verification failed: no level ticks were pushed.");
    if (options.transcript && !types.has("live_call.transcript.final")) throw new Error("Verification failed: missing live_call.transcript.final");
    if (options.answer && !types.has("live_call.agent.done")) throw new Error("Verification failed: missing live_call.agent.done");
  }

  const finalSession = (await request(options, `/api/live-calls/${encodeURIComponent(session.id)}`)).session;
  process.stdout.write(`${JSON.stringify({ ok: true, session: finalSession, levelSummary, eventTypes: [...types] }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
