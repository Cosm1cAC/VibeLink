#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import net from "node:net";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const port = process.env.VIBELINK_EVIDENCE_PORT ? Number(process.env.VIBELINK_EVIDENCE_PORT) : await freePort();
const output = process.env.VIBELINK_EVIDENCE_OUTPUT || ".tmp/release-evidence/browser";
const dataRoot = path.resolve(".tmp/release-evidence");
fs.mkdirSync(dataRoot, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(dataRoot, "bridge-data-"));
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ host: "127.0.0.1", port, pairingToken: "EVIDENCE1", allowLegacyPairingTokenLogin: true }));
const stdout = fs.openSync(path.resolve(".tmp/release-evidence/bridge.stdout.log"), "w");
const stderr = fs.openSync(path.resolve(".tmp/release-evidence/bridge.stderr.log"), "w");
const systemChrome = process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "";
const bridge = spawn(process.execPath, ["src/server.js"], {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: ["ignore", stdout, stderr],
  env: { ...process.env, VIBELINK_DATA_DIR: dataDir, MOBILE_AGENT_HOST: "127.0.0.1", MOBILE_AGENT_PORT: String(port), MOBILE_AGENT_TOKEN: "EVIDENCE1", ...(systemChrome && fs.existsSync(systemChrome) ? { VIBELINK_CHROMIUM_EXECUTABLE: systemChrome } : {}) }
});

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForBridge(url) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try { const response = await fetch(`${url}/api/status`); if (response.status > 0) return; } catch {}
    await wait(500);
  }
  throw new Error("Isolated Bridge did not start.");
}
async function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, env });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Evidence process exited ${code}`)));
  });
}

try {
  const url = `http://127.0.0.1:${port}`;
  await waitForBridge(url);
  const loginResponse = await fetch(`${url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pairingToken: "EVIDENCE1", deviceLabel: "release-evidence" }) });
  const login = await loginResponse.json();
  if (!loginResponse.ok || !login.token) throw new Error(`Evidence login failed: ${JSON.stringify(login)}`);
  await run(process.execPath, ["tools/release/browser-session-evidence.mjs", "--output", output], { ...process.env, VIBELINK_URL: url, VIBELINK_TOKEN: login.token });
} finally {
  if (bridge.exitCode == null) {
    const exited = new Promise((resolve) => bridge.once("exit", resolve));
    bridge.kill();
    await Promise.race([exited, wait(5_000)]);
  }
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
