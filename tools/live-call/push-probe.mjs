#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_URL = "http://127.0.0.1:8787";
const DEFAULT_TEXT = "请介绍一下你最近做过的一个项目，以及你在里面解决的关键问题是什么？";

function parseArgs(argv) {
  const options = {
    url: process.env.VIBELINK_URL || DEFAULT_URL,
    token: process.env.VIBELINK_TOKEN || process.env.MOBILE_AGENT_DEVICE_TOKEN || "",
    probe: "",
    sessionId: "",
    title: "Windows Probe Live Call",
    source: "windows-audio-probe",
    text: DEFAULT_TEXT,
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
    else if (arg === "--probe") options.probe = next();
    else if (arg === "--session" || arg === "--session-id") options.sessionId = next();
    else if (arg === "--title") options.title = next();
    else if (arg === "--source") options.source = next();
    else if (arg === "--text") options.text = next();
    else if (arg === "--answer") options.answer = next();
    else if (arg === "--no-verify") options.verify = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.url = options.url.replace(/\/+$/, "");
  return options;
}

function usage() {
  return `Usage: npm run live-call:push-probe -- [options]

Options:
  --url URL          VibeLink bridge URL. Default: ${DEFAULT_URL}
  --token TOKEN      Device token. Or set VIBELINK_TOKEN.
  --probe PATH       probe.json path. Defaults to latest ready probe.
  --session ID       Existing live-call session id. Creates one if omitted.
  --text TEXT        Mock transcript text to push.
  --answer TEXT      Optional mock answer to push as live_call.agent.done.
  --no-verify        Skip event verification.
`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectProbeFiles(rootDir) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name === "probe.json") {
        try {
          const stat = fs.statSync(entryPath);
          results.push({ path: entryPath, mtimeMs: stat.mtimeMs });
        } catch {
          // Ignore files that disappear during traversal.
        }
      }
    }
  }
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findProbePath(explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  const rootDir = path.resolve(".agent-mobile-terminal", "audio-probes");
  const files = collectProbeFiles(rootDir);
  if (!files.length) throw new Error(`No probe.json files found under ${rootDir}`);

  for (const item of files) {
    try {
      if (readJson(item.path).ready === true) return item.path;
    } catch {
      // Keep looking for a readable ready probe.
    }
  }
  return files[0].path;
}

function pickNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function probeChannel(meta, channel) {
  const item = meta[channel] || {};
  const levels = item.levels || item.Levels || {};
  const device = item.device || item.Device || {};
  return {
    channel,
    bytes: pickNumber(item.bytes, item.Bytes),
    peak: pickNumber(levels.peak, levels.Peak),
    rms: pickNumber(levels.rms, levels.Rms),
    deviceName: String(device.name || device.Name || "").slice(0, 240)
  };
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

function eventTypes(events) {
  return new Set((events || []).map((event) => event.type));
}

function requireEvent(types, type) {
  if (!types.has(type)) throw new Error(`Verification failed: missing ${type}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const probePath = findProbePath(options.probe);
  const probe = readJson(probePath);
  const session = await createOrLoadSession(options);
  const remote = probeChannel(probe, "remote");
  const local = probeChannel(probe, "local");

  await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/level`, {
    method: "POST",
    body: JSON.stringify(remote)
  });
  await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/level`, {
    method: "POST",
    body: JSON.stringify(local)
  });
  if (options.text) {
    await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/transcript`, {
      method: "POST",
      body: JSON.stringify({ text: options.text, final: true, speaker: "remote" })
    });
  }
  if (options.answer) {
    await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ text: options.answer })
    });
  }

  const events = options.verify
    ? (await request(options, `/api/live-calls/${encodeURIComponent(session.id)}/events/catch-up?limit=500`)).items || []
    : [];

  if (options.verify) {
    const types = eventTypes(events);
    requireEvent(types, "live_call.started");
    requireEvent(types, "live_call.audio_level");
    if (options.text) requireEvent(types, "live_call.transcript.final");
    if (/[?？]|什么|如何|怎么|为什么|介绍|经验|项目|问题|请问|能否|是否|怎样|多少|哪里|哪/.test(options.text)) {
      requireEvent(types, "live_call.question.detected");
    }
    if (options.answer) requireEvent(types, "live_call.agent.done");
  }

  const finalSession = (await request(options, `/api/live-calls/${encodeURIComponent(session.id)}`)).session;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    probePath,
    probeReady: Boolean(probe.ready),
    session: finalSession,
    pushed: { remote, local, transcript: options.text, answer: options.answer },
    eventTypes: [...eventTypes(events)]
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
