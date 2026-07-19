#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs";
import WebSocket from "ws";

const DEFAULT_URL = "http://127.0.0.1:8787";
const DEFAULT_QUESTIONS = [
  "Please describe one recent project and the hardest technical tradeoff?",
  "How would you debug a production latency regression?",
  "What would you improve in this system after the first release?",
  "Can you summarize the risks and next actions?"
];

function parseArgs(argv) {
  const options = {
    url: process.env.VIBELINK_URL || DEFAULT_URL,
    token: process.env.VIBELINK_TOKEN || process.env.MOBILE_AGENT_DEVICE_TOKEN || "",
    seconds: 600,
    intervalSeconds: 30,
    title: "Live Call 10 minute QA stress",
    source: "qa-stress",
    asrProvider: process.env.VIBELINK_ASR || "whisper-cpp",
    agent: "claude",
    model: "",
    workspaceId: "",
    pcmFile: "",
    dropRate: 0,
    jitterMs: 0,
    reconnectEverySeconds: 0,
    verify: true,
    stop: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++index];
    };
    if (arg === "--url") options.url = next();
    else if (arg === "--token") options.token = next();
    else if (arg === "--seconds") options.seconds = Math.max(1, Number(next()) || 600);
    else if (arg === "--interval-seconds") options.intervalSeconds = Math.max(1, Number(next()) || 30);
    else if (arg === "--title") options.title = next();
    else if (arg === "--source") options.source = next();
    else if (arg === "--asr-provider") options.asrProvider = next();
    else if (arg === "--agent") options.agent = next();
    else if (arg === "--model") options.model = next();
    else if (arg === "--workspace-id") options.workspaceId = next();
    else if (arg === "--pcm-file") options.pcmFile = next();
    else if (arg === "--drop-rate") options.dropRate = Math.min(0.9, Math.max(0, Number(next()) || 0));
    else if (arg === "--jitter-ms") options.jitterMs = Math.min(5000, Math.max(0, Number(next()) || 0));
    else if (arg === "--reconnect-every-seconds") options.reconnectEverySeconds = Math.max(0, Number(next()) || 0);
    else if (arg === "--weak-network") {
      options.dropRate = 0.05;
      options.jitterMs = 120;
      options.reconnectEverySeconds = 90;
    }
    else if (arg === "--no-verify") options.verify = false;
    else if (arg === "--no-stop") options.stop = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.url = options.url.replace(/\/+$/, "");
  return options;
}

function usage() {
  return `Usage: npm run live-call:qa-stress -- [options]

Options:
  --url URL                 VibeLink bridge URL. Default: ${DEFAULT_URL}
  --token TOKEN             Device token. Or set VIBELINK_TOKEN.
  --seconds N               Duration. Default: 600.
  --interval-seconds N      Transcript/level push interval. Default: 30.
  --asr-provider ID         ASR provider for the created session. Default: whisper-cpp.
  --agent ID                Assistant provider. Default: claude.
  --model ID                Optional assistant model.
  --workspace-id ID         Optional workspace id.
  --pcm-file PATH           Raw 16 kHz mono PCM16LE input, looped for the run.
  --weak-network            Simulate 5% loss, up to 120 ms jitter, and reconnects.
  --drop-rate N             Client-side frame loss ratio (0-0.9).
  --jitter-ms N             Random delay added to each 20 ms frame.
  --reconnect-every-seconds N  Force a recoverable socket reconnect interval.
  --no-verify               Skip final event assertions.
  --no-stop                 Keep the test session active after completion.
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

function levelPayload(channel, tick, bytes) {
  const phase = (tick % 8) / 8;
  const rms = channel === "remote" ? 0.04 + phase * 0.05 : 0.02 + phase * 0.03;
  return {
    channel,
    rms: Number(rms.toFixed(4)),
    peak: Number(Math.min(1, rms * 2.4).toFixed(4)),
    bytes,
    deviceName: channel === "remote" ? "qa-remote-loopback" : "qa-local-mic"
  };
}

function questionForTick(tick) {
  return DEFAULT_QUESTIONS[tick % DEFAULT_QUESTIONS.length];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function syntheticPcm() {
  const frame = Buffer.alloc(640);
  for (let index = 0; index < 320; index += 1) {
    frame.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 220 / 16000) * 8000), index * 2);
  }
  return frame;
}

function audioWebSocketUrl(options, sessionId) {
  const url = new URL(options.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/live-calls/${encodeURIComponent(sessionId)}/audio`;
  if (options.token) url.searchParams.set("token", options.token);
  return url.toString();
}

function connectAudio(options, sessionId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(audioWebSocketUrl(options, sessionId));
    const timer = setTimeout(() => reject(new Error("Audio WebSocket ready timeout.")), 10_000);
    socket.once("open", () => socket.send(JSON.stringify({ sampleRate: 16000, channels: 1, encoding: "pcm16le", device: "remote" })));
    socket.on("message", (value) => {
      let message;
      try { message = JSON.parse(value.toString("utf8")); } catch { return; }
      if (message.type === "ready") {
        clearTimeout(timer);
        resolve(socket);
      } else if (message.type === "error") {
        clearTimeout(timer);
        reject(new Error(`Audio WebSocket error: ${message.error}`));
      }
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function eventTypes(events) {
  return new Set((events || []).map((event) => event.type));
}

async function createSession(options) {
  const body = {
    title: options.title,
    source: options.source,
    asrProvider: options.asrProvider,
    agent: options.agent,
    model: options.model,
    workspaceId: options.workspaceId
  };
  const result = await request(options, "/api/live-calls", {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!result.session?.id) throw new Error("Live Call session was not created.");
  return result.session;
}

async function runStress(options) {
  const session = await createSession(options);
  const pcm = options.pcmFile ? fs.readFileSync(options.pcmFile) : syntheticPcm();
  if (!pcm.length || pcm.length % 2) throw new Error("PCM input must be non-empty PCM16LE data.");
  const startedAt = Date.now();
  const endAt = startedAt + options.seconds * 1000;
  const intervalMs = options.intervalSeconds * 1000;
  let tick = 0;
  let bytes = 0;
  let droppedFrames = 0;
  let reconnects = 0;
  let pauseResumeChecked = false;
  let nextLevelAt = startedAt;
  let nextReconnectAt = options.reconnectEverySeconds ? startedAt + options.reconnectEverySeconds * 1000 : Infinity;
  let pcmOffset = 0;
  let socket = await connectAudio(options, session.id);

  while (Date.now() < endAt) {
    if (Date.now() >= nextReconnectAt) {
      socket.close(1001, "qa-weak-network-reconnect");
      await sleep(100 + Math.floor(Math.random() * Math.max(1, options.jitterMs)));
      socket = await connectAudio(options, session.id);
      reconnects += 1;
      nextReconnectAt = Date.now() + options.reconnectEverySeconds * 1000;
    }

    const frame = Buffer.alloc(640);
    for (let copied = 0; copied < frame.length;) {
      const available = Math.min(frame.length - copied, pcm.length - pcmOffset);
      pcm.copy(frame, copied, pcmOffset, pcmOffset + available);
      copied += available;
      pcmOffset = (pcmOffset + available) % pcm.length;
    }
    if (Math.random() < options.dropRate) droppedFrames += 1;
    else {
      socket.send(frame);
      bytes += frame.length;
    }

    if (Date.now() >= nextLevelAt) {
      await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/level`, {
        method: "POST",
        body: JSON.stringify(levelPayload("remote", tick, bytes))
      });
      nextLevelAt = Date.now() + intervalMs;
    }

    if (!pauseResumeChecked && Date.now() - startedAt >= Math.min(60_000, Math.max(1000, options.seconds * 250))) {
      await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/pause`, {
        method: "POST",
        body: JSON.stringify({ reason: "qa-stress-midpoint" })
      });
      await sleep(100);
      await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/resume`, {
        method: "POST",
        body: JSON.stringify({ reason: "qa-stress-midpoint" })
      });
      pauseResumeChecked = true;
    }

    tick += 1;
    await sleep(20 + Math.floor(Math.random() * (options.jitterMs + 1)));
  }

  socket.send(JSON.stringify({ type: "flush" }));
  await sleep(500);
  socket.send(JSON.stringify({ type: "stop" }));
  await sleep(100);

  if (options.stop) {
    await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/stop`, {
      method: "POST",
      body: JSON.stringify({ reason: "qa-stress-complete" })
    });
  }

  const events = (await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/events/catch-up?limit=5000`)).items || [];
  if (options.verify) {
    const types = eventTypes(events);
    for (const type of ["live_call.started", "live_call.audio_level", "live_call.asr.provider", "live_call.audio_segment", "live_call.paused", "live_call.resumed"]) {
      if (!types.has(type)) throw new Error(`Verification failed: missing ${type}`);
    }
    if (options.pcmFile && !types.has("live_call.transcript.final")) throw new Error("Verification failed: real PCM produced no final transcript.");
    if (options.stop && !types.has("live_call.stopped")) throw new Error("Verification failed: missing live_call.stopped");
    if (tick < 1) throw new Error("Verification failed: no stress ticks were executed.");
  }

  const finalSession = (await request(options, `/api/live-calls/${encodeURIComponent(session.id)}`)).session;
  return {
    ok: true,
    durationSeconds: options.seconds,
    ticks: tick,
    sentBytes: bytes,
    droppedFrames,
    reconnects,
    pcmSource: options.pcmFile || "synthetic",
    session: finalSession,
    eventCount: events.length,
    eventTypes: [...eventTypes(events)]
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await runStress(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
