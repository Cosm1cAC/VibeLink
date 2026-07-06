import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "./config.js";

const appName = "VibeLink";
const secretDir = path.join(dataDir, "secrets");
const supportedKeys = ["openai", "anthropic", "zhipu"];

function serviceName(key) {
  return `${appName}:${key}`;
}

function secretFile(key) {
  return path.join(secretDir, `${key}.dpapi`);
}

function run(command, args, { env = {}, input = "" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => resolve({ ok: false, stdout, stderr: error.message, code: -1 }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr, code }));
    if (input) {
      child.stdin.end(input);
    }
  });
}

async function commandExists(command) {
  const checker = process.platform === "win32" ? "where.exe" : "which";
  const result = await run(checker, [command]);
  return result.ok;
}

export async function credentialBackend() {
  if (process.platform === "win32") {
    const available = await commandExists("powershell.exe");
    return {
      backend: "windows-dpapi",
      available,
      persistent: available,
      description: "Windows DPAPI user-protected secret file"
    };
  }

  if (process.platform === "darwin") {
    const available = await commandExists("security");
    return {
      backend: "macos-keychain",
      available,
      persistent: available,
      description: "macOS Keychain"
    };
  }

  const available = await commandExists("secret-tool");
  return {
    backend: available ? "libsecret" : "memory-only",
    available,
    persistent: available,
    description: available ? "Linux Secret Service" : "No supported OS credential helper found"
  };
}

async function writeWindowsSecret(key, value) {
  fs.mkdirSync(secretDir, { recursive: true });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$secure = ConvertTo-SecureString $env:VIBELINK_SECRET_VALUE -AsPlainText -Force",
    "$encrypted = $secure | ConvertFrom-SecureString",
    "Set-Content -LiteralPath $env:VIBELINK_SECRET_FILE -Value $encrypted -Encoding UTF8"
  ].join("; ");
  const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: {
      VIBELINK_SECRET_VALUE: value,
      VIBELINK_SECRET_FILE: secretFile(key)
    }
  });
  if (!result.ok) throw new Error(result.stderr || "Failed to store Windows secret.");
}

async function readWindowsSecret(key) {
  const filePath = secretFile(key);
  if (!fs.existsSync(filePath)) return "";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$encrypted = Get-Content -LiteralPath $env:VIBELINK_SECRET_FILE -Raw",
    "$secure = ConvertTo-SecureString $encrypted",
    "$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }"
  ].join("; ");
  const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { VIBELINK_SECRET_FILE: filePath }
  });
  return result.ok ? result.stdout.trim() : "";
}

async function writeMacSecret(key, value) {
  const account = os.userInfo().username || "default";
  const result = await run("security", ["add-generic-password", "-a", account, "-s", serviceName(key), "-w", value, "-U"]);
  if (!result.ok) throw new Error(result.stderr || "Failed to store macOS Keychain secret.");
}

async function readMacSecret(key) {
  const account = os.userInfo().username || "default";
  const result = await run("security", ["find-generic-password", "-a", account, "-s", serviceName(key), "-w"]);
  return result.ok ? result.stdout.trim() : "";
}

async function writeLinuxSecret(key, value) {
  const result = await run(
    "secret-tool",
    ["store", "--label", `${appName} ${key}`, "application", appName.toLowerCase(), "key", key],
    { input: value }
  );
  if (!result.ok) throw new Error(result.stderr || "Failed to store libsecret secret.");
}

async function readLinuxSecret(key) {
  const result = await run("secret-tool", ["lookup", "application", appName.toLowerCase(), "key", key]);
  return result.ok ? result.stdout.trim() : "";
}

export async function writeSecret(key, value) {
  if (!supportedKeys.includes(key) || !value) return false;
  const backend = await credentialBackend();
  if (!backend.available) return false;
  if (process.platform === "win32") await writeWindowsSecret(key, value);
  else if (process.platform === "darwin") await writeMacSecret(key, value);
  else await writeLinuxSecret(key, value);
  return true;
}

function envNameForKey(key) {
  const map = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", zhipu: "ZHIPU_API_KEY" };
  return map[key] || "";
}

export async function readSecret(key) {
  if (!supportedKeys.includes(key)) return "";
  const envName = envNameForKey(key);
  if (process.env[envName]) return process.env[envName];

  const backend = await credentialBackend();
  if (!backend.available) return "";
  if (process.platform === "win32") return readWindowsSecret(key);
  if (process.platform === "darwin") return readMacSecret(key);
  return readLinuxSecret(key);
}

export async function readApiKeys() {
  return {
    openai: await readSecret("openai"),
    anthropic: await readSecret("anthropic"),
    zhipu: await readSecret("zhipu")
  };
}

export async function writeApiKeys(apiKeys = {}) {
  const result = {};
  for (const key of supportedKeys) {
    const value = typeof apiKeys[key] === "string" ? apiKeys[key].trim() : "";
    if (!value) continue;
    result[key] = await writeSecret(key, value);
  }
  return result;
}
