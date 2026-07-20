#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const seconds = Math.max(1, Number(process.env.VIBELINK_EVIDENCE_SECONDS || 600));
const outputDir = path.resolve(".tmp/release-evidence/live-call");
fs.mkdirSync(outputDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(outputDir, "bridge-data-"));
const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject).listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); }); });
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ host: "127.0.0.1", port, pairingToken: "EVIDENCE2", allowLegacyPairingTokenLogin: true }));
const bridgeOut = fs.openSync(path.join(outputDir, "bridge.stdout.log"), "w");
const bridgeErr = fs.openSync(path.join(outputDir, "bridge.stderr.log"), "w");
const bridge = spawn(process.execPath, ["src/server.js"], { windowsHide: true, stdio: ["ignore", bridgeOut, bridgeErr], env: { ...process.env, VIBELINK_DATA_DIR: dataDir, VIBELINK_ASR: "mock" } });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ready(url) {
  for (let attempt = 0; attempt < 180; attempt += 1) { try { if ((await fetch(`${url}/api/status`)).status) return; } catch {}; await wait(500); }
  throw new Error("Live Call evidence Bridge did not start.");
}
try {
  const url = `http://127.0.0.1:${port}`;
  await ready(url);
  const response = await fetch(`${url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pairingToken: "EVIDENCE2", deviceLabel: "live-call-evidence" }) });
  const login = await response.json();
  if (!response.ok || !login.token) throw new Error(`Live Call evidence login failed: ${JSON.stringify(login)}`);
  const resultFile = fs.openSync(path.join(outputDir, "quality.json"), "w");
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["tools/live-call/qa-stress.mjs", "--seconds", String(seconds), "--interval-seconds", "30", "--asr-provider", "mock", "--weak-network"], { windowsHide: true, stdio: ["ignore", resultFile, "inherit"], env: { ...process.env, VIBELINK_URL: url, VIBELINK_TOKEN: login.token } });
    child.once("error", reject); child.once("exit", resolve);
  });
  fs.closeSync(resultFile);
  if (code !== 0) throw new Error(`Live Call evidence exited ${code}`);
} finally {
  if (bridge.exitCode == null) { const exited = new Promise((resolve) => bridge.once("exit", resolve)); bridge.kill(); await Promise.race([exited, wait(5_000)]); }
  fs.closeSync(bridgeOut); fs.closeSync(bridgeErr);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
