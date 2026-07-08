import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { startBridgeDaemon } from "../packages/doubao-cli/src/lib/bridge-daemon.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(rootDir, "packages", "doubao-cli", "src", "bin", "doubao.mjs");

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: rootDir,
      env: { ...process.env, ...options.env },
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true
    });
    if (options.input) child.stdin.end(options.input);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function waitForLine(stream, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for daemon output.")), timeoutMs);
    stream.on("data", function onData(data) {
      buffer += data.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      stream.off("data", onData);
      clearTimeout(timer);
      resolve(buffer.slice(0, index).trim());
    });
  });
}

test("doubao doctor reports bridge offline as structured JSON", async () => {
  const result = await runCli(["doctor", "--json", "--port", "45991", "--token", "test-token"]);
  const payload = JSON.parse(result.stdout.trim());

  assert.equal(result.code, 1);
  assert.equal(payload.ok, false);
  assert.equal(payload.backend, "extension_bridge");
  assert.equal(payload.error.code, "BRIDGE_OFFLINE");
  assert.equal(payload.error.recoverable, true);
});

test("doubao doctor reports extension offline when bridge daemon is running", async () => {
  const daemon = await startBridgeDaemon({ port: 0, token: "test-token" });
  try {
    const result = await runCli(["doctor", "--json", "--port", String(daemon.port), "--token", "test-token"]);
    const payload = JSON.parse(result.stdout.trim());

    assert.equal(result.code, 1);
    assert.equal(payload.ok, false);
    assert.equal(payload.backend, "extension_bridge");
    assert.equal(payload.error.code, "EXTENSION_OFFLINE");
    assert.equal(payload.bridge.daemon, true);
  } finally {
    await daemon.close();
  }
});

test("doubao ask routes through a connected extension bridge", async () => {
  const daemon = await startBridgeDaemon({ port: 0, token: "test-token" });
  const extension = new WebSocket(`ws://127.0.0.1:${daemon.port}/extension?token=test-token`);
  extension.on("message", (data) => {
    const message = JSON.parse(data.toString());
    extension.send(JSON.stringify({
      id: message.id,
      ok: true,
      result: {
        provider: "doubao",
        text: `fake answer for ${message.params.prompt}`,
        url: "https://www.doubao.com/chat/"
      }
    }));
  });
  await new Promise((resolve) => extension.once("open", resolve));

  try {
    const result = await runCli(["ask", "--json", "--prompt", "hello", "--port", String(daemon.port), "--token", "test-token"]);
    const payload = JSON.parse(result.stdout.trim());

    assert.equal(result.code, 0);
    assert.equal(payload.ok, true);
    assert.equal(payload.backend, "extension_bridge");
    assert.equal(payload.provider, "doubao");
    assert.equal(payload.text, "fake answer for hello");
  } finally {
    extension.close();
    await daemon.close();
  }
});

test("doubao ask can read prompt from stdin", async () => {
  const daemon = await startBridgeDaemon({ port: 0, token: "test-token" });
  const extension = new WebSocket(`ws://127.0.0.1:${daemon.port}/extension?token=test-token`);
  extension.on("message", (data) => {
    const message = JSON.parse(data.toString());
    extension.send(JSON.stringify({
      id: message.id,
      ok: true,
      result: {
        provider: "doubao",
        text: `stdin answer for ${message.params.prompt.trim()}`,
        url: "https://www.doubao.com/chat/"
      }
    }));
  });
  await new Promise((resolve) => extension.once("open", resolve));

  try {
    const result = await runCli(["ask", "--stdin", "--json", "--port", String(daemon.port), "--token", "test-token"], {
      input: "hello from stdin\n"
    });
    const payload = JSON.parse(result.stdout.trim());

    assert.equal(result.code, 0);
    assert.equal(payload.text, "stdin answer for hello from stdin");
  } finally {
    extension.close();
    await daemon.close();
  }
});

test("doubao daemon run starts a bridge process", async () => {
  const child = spawn(process.execPath, [cliPath, "daemon", "run", "--json", "--port", "0", "--token", "test-token"], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  try {
    const ready = JSON.parse(await waitForLine(child.stdout));
    assert.equal(ready.ok, true);
    assert.equal(ready.event, "daemon_ready");
    assert.equal(typeof ready.port, "number");

    const result = await runCli(["doctor", "--json", "--port", String(ready.port), "--token", "test-token"]);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.error.code, "EXTENSION_OFFLINE");
  } finally {
    child.kill();
  }
});

test("doubao configure writes config and reports agent next actions", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-cli-home-"));
  const result = await runCli(["configure", "--json", "--no-daemon", "--no-open", "--port", "0"], {
    env: {
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming")
    }
  });
  const payload = JSON.parse(result.stdout.trim());
  const configPath = path.join(home, "AppData", "Roaming", "doubao-cli", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const extensionPath = path.join(home, "AppData", "Roaming", "doubao-cli", "extension");
  const generatedConfig = JSON.parse(fs.readFileSync(path.join(extensionPath, "generated-config.json"), "utf8"));

  assert.equal(result.code, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "configure");
  assert.equal(payload.configPath, configPath);
  assert.equal(config.bridge.port, 45771);
  assert.equal(typeof config.bridge.token, "string");
  assert.ok(config.bridge.token.length >= 32);
  assert.equal(payload.extension.path, extensionPath);
  assert.equal(fs.existsSync(path.join(extensionPath, "manifest.json")), true);
  assert.equal(generatedConfig.bridgeToken, config.bridge.token);
  assert.equal(generatedConfig.bridgeUrl, "ws://127.0.0.1:45771/extension");
  assert.equal(payload.manualActionRequired, true);
  assert.ok(payload.nextActions.some((action) => /Load unpacked/i.test(action)));
  assert.ok(payload.nextActions.some((action) => /doubao doctor --json/i.test(action)));
});
