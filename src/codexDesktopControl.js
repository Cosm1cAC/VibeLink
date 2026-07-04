import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "codexDesktopControl.ps1");
const lastResultPath = path.join(dataDir, "codex-desktop-control-last.json");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) throw new Error("Desktop control script produced no output.");

  try {
    return JSON.parse(text);
  } catch {
    const jsonStart = text.lastIndexOf("{");
    if (jsonStart >= 0) return JSON.parse(text.slice(jsonStart));
    throw new Error(`Desktop control script produced invalid JSON: ${text.slice(0, 500)}`);
  }
}

function runDesktopControl(action, payload = {}) {
  if (process.platform !== "win32") {
    return Promise.resolve({
      ok: false,
      action,
      error: "Codex Desktop UI control is only implemented on Windows."
    });
  }

  if (!fs.existsSync(scriptPath)) {
    return Promise.resolve({
      ok: false,
      action,
      error: `Desktop control script not found: ${scriptPath}`
    });
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const requestPath = path.join(dataDir, `codex-desktop-control-${crypto.randomUUID()}.json`);
  writeJson(requestPath, { action, ...payload });

  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath, requestPath],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      const result = {
        ok: false,
        action,
        error: "Desktop control timed out.",
        stderr: stderr.slice(0, 1000)
      };
      writeJson(lastResultPath, result);
      resolve(result);
    }, 45000);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = { ok: false, action, error: error.message, stderr: stderr.slice(0, 1000) };
      writeJson(lastResultPath, result);
      resolve(result);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      let result;
      try {
        result = parseJsonOutput(stdout);
      } catch (error) {
        result = {
          ok: false,
          action,
          exitCode: code,
          error: error.message,
          stdout: stdout.slice(0, 1000),
          stderr: stderr.slice(0, 1000)
        };
      }

      if (stderr.trim()) result.stderr = stderr.trim().slice(0, 1000);
      writeJson(lastResultPath, result);
      try {
        fs.unlinkSync(requestPath);
      } catch {
        // Best-effort cleanup only.
      }
      resolve(result);
    });
  });
}

export function getCodexDesktopStatus() {
  return runDesktopControl("status");
}

export function probeCodexDesktopDraft(text = "") {
  return runDesktopControl("draft", { text });
}

export function sendToCodexDesktop(prompt, options = {}) {
  return runDesktopControl("send", { text: prompt, ...options });
}

export function focusCodexDesktopConversation(index) {
  return runDesktopControl("focusConversation", { index });
}

export function restoreCodexDesktopWindow() {
  return runDesktopControl("restore");
}
