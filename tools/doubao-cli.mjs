#!/usr/bin/env node
import { WebSocket } from "ws";

const DEFAULT_ENDPOINT = process.env.DOUBAO_CDP_ENDPOINT || "http://127.0.0.1:9222";
const DEFAULT_URL = process.env.DOUBAO_WEB_URL || "https://www.doubao.com/chat/";
const DEFAULT_TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 1000;
const STABLE_ANSWER_MS = 2500;

const setupHint = [
  "Start a dedicated logged-in Chrome session first:",
  "chrome.exe --remote-debugging-port=9222 --user-data-dir=%USERPROFILE%\\.vibelink\\doubao-chrome https://www.doubao.com/chat/"
].join(" ");

function parseArgs(argv) {
  const options = {
    command: "",
    json: false,
    prompt: "",
    endpoint: DEFAULT_ENDPOINT,
    url: DEFAULT_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    editorSelector: process.env.DOUBAO_EDITOR_SELECTOR || "",
    sendSelector: process.env.DOUBAO_SEND_SELECTOR || "",
    responseSelector: process.env.DOUBAO_RESPONSE_SELECTOR || ""
  };

  const items = [...argv];
  options.command = items.shift() || "help";
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const next = () => items[++index] || "";
    if (item === "--json") options.json = true;
    else if (item === "--prompt" || item === "-p") options.prompt = next();
    else if (item === "--endpoint") options.endpoint = next();
    else if (item === "--url") options.url = next();
    else if (item === "--timeout-ms") options.timeoutMs = Number(next()) || DEFAULT_TIMEOUT_MS;
    else if (item === "--editor-selector") options.editorSelector = next();
    else if (item === "--send-selector") options.sendSelector = next();
    else if (item === "--response-selector") options.responseSelector = next();
    else if (!options.prompt && options.command === "ask") options.prompt = item;
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactText(value, max = 20000) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(-max);
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function outputText(value) {
  process.stdout.write(`${String(value || "")}\n`);
}

function endpointUrl(endpoint, route) {
  return `${String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "")}${route}`;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function chromeVersion(endpoint) {
  return fetchJson(endpointUrl(endpoint, "/json/version"));
}

async function chromeTargets(endpoint) {
  return fetchJson(endpointUrl(endpoint, "/json/list"));
}

function isDoubaoTarget(target = {}) {
  return target.type === "page" && /doubao\.com/i.test(target.url || "");
}

async function createTarget(endpoint, url) {
  const targetUrl = endpointUrl(endpoint, `/json/new?${encodeURIComponent(url || DEFAULT_URL)}`);
  try {
    return await fetchJson(targetUrl, { method: "PUT" });
  } catch {
    return fetchJson(targetUrl);
  }
}

async function findOrCreateTarget(endpoint, url) {
  const targets = await chromeTargets(endpoint);
  const existing = targets.find(isDoubaoTarget) || targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (existing?.webSocketDebuggerUrl && isDoubaoTarget(existing)) return { target: existing, created: false };
  const created = await createTarget(endpoint, url);
  return { target: created, created: true };
}

class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(webSocketDebuggerUrl);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!message.id || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "CDP command failed."));
    else pending.resolve(message.result || {});
  }

  async send(method, params = {}, timeoutMs = 15000) {
    await this.opened;
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.ws.send(payload);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Best effort cleanup.
    }
  }
}

async function evaluate(client, fn, arg = {}, timeoutMs = 15000) {
  const expression = `(${fn})(${JSON.stringify(arg)})`;
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, timeoutMs);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation failed.";
    throw new Error(text);
  }
  return result.result?.value;
}

async function waitForPage(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(client, () => document.readyState !== "loading").catch(() => false);
    if (ready) return true;
    await sleep(300);
  }
  return false;
}

function pageStateScript(options) {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const editorSelector = options.editorSelector || "textarea,[contenteditable='true'],[role='textbox'],.ProseMirror";
  const editor = [...document.querySelectorAll(editorSelector)].find(visible);
  const text = document.body?.innerText || "";
  return {
    url: location.href,
    title: document.title,
    hasEditor: Boolean(editor),
    loginLikely: /登录|登陆|手机号|验证码|login|sign in/i.test(text) && !editor,
    text: text.slice(-20000)
  };
}

function insertPromptScript(options) {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const editorSelector = options.editorSelector || "textarea,[contenteditable='true'],[role='textbox'],.ProseMirror";
  const editor = [...document.querySelectorAll(editorSelector)].filter(visible).at(-1);
  if (!editor) return { ok: false, reason: "editor_not_found" };

  editor.focus();
  const prompt = options.prompt || "";
  if ("value" in editor) {
    editor.value = prompt;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, kind: "value" };
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand("delete");
  const inserted = document.execCommand("insertText", false, prompt);
  if (!inserted) editor.textContent = prompt;
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  return { ok: true, kind: "contenteditable" };
}

function clickSendScript(options) {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const explicit = options.sendSelector ? [...document.querySelectorAll(options.sendSelector)].find(visible) : null;
  const buttons = explicit ? [explicit] : [...document.querySelectorAll("button,[role='button']")].filter(visible);
  const sendButton = buttons.find((button) => {
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    const label = [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.textContent
    ].filter(Boolean).join(" ");
    return /发送|提交|send|submit/i.test(label);
  }) || buttons.filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true").at(-1);

  if (!sendButton) return { ok: false, reason: "send_button_not_found" };
  sendButton.click();
  return { ok: true };
}

function answerSnapshotScript(options) {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const selector = options.responseSelector || [
    "article",
    "[role='article']",
    "[data-testid*='message' i]",
    "[class*='message' i]",
    "[class*='answer' i]",
    "[class*='assistant' i]",
    "[class*='markdown' i]"
  ].join(",");
  const prompt = String(options.prompt || "").trim();
  const promptPrefix = prompt.slice(0, 160);
  const candidates = [...document.querySelectorAll(selector)]
    .filter(visible)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const className = String(element.className || "");
      const text = (element.innerText || element.textContent || "").trim();
      let score = rect.top + rect.height;
      if (/assistant|answer|markdown|message/i.test(className)) score += 10000;
      return { text, score };
    })
    .filter((item) => {
      if (!item.text || item.text.length < 2) return false;
      if (promptPrefix && item.text.includes(promptPrefix)) return false;
      if (/登录|验证码|手机号|继续使用/i.test(item.text) && item.text.length < 200) return false;
      return true;
    })
    .sort((a, b) => a.score - b.score);
  const last = candidates.at(-1)?.text || "";
  return {
    url: location.href,
    title: document.title,
    text: last,
    bodyText: document.body?.innerText?.slice(-20000) || ""
  };
}

function bodyDelta(before, after, prompt) {
  const previous = compactText(before);
  const current = compactText(after);
  if (!current || current === previous) return "";
  let delta = current;
  const shared = Math.min(previous.length, current.length);
  let index = 0;
  while (index < shared && previous[index] === current[index]) index += 1;
  if (index > 100) delta = current.slice(index);
  const promptPrefix = String(prompt || "").trim().slice(0, 160);
  if (promptPrefix && delta.includes(promptPrefix)) {
    delta = delta.slice(delta.lastIndexOf(promptPrefix) + promptPrefix.length);
  }
  return compactText(delta);
}

async function runDoctor(options) {
  const report = {
    ok: false,
    endpoint: options.endpoint,
    url: options.url,
    browser: null,
    target: null,
    setupHint
  };
  try {
    report.browser = await chromeVersion(options.endpoint);
    const targets = await chromeTargets(options.endpoint);
    const target = targets.find(isDoubaoTarget) || null;
    report.target = target
      ? { ok: true, id: target.id, title: target.title, url: target.url }
      : { ok: false, reason: "No Doubao tab found. It will be opened on first ask." };
    report.ok = true;
  } catch (error) {
    report.error = error.message;
  }
  outputJson(report);
  return report.ok ? 0 : 1;
}

async function runAsk(options) {
  if (!options.prompt) throw new Error("Doubao ask requires --prompt.");
  const timeoutMs = Math.max(5000, Math.min(Number(options.timeoutMs || DEFAULT_TIMEOUT_MS), 10 * 60 * 1000));
  const { target } = await findOrCreateTarget(options.endpoint, options.url);
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome target does not expose a DevTools WebSocket URL.");

  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    if (!isDoubaoTarget(target)) {
      await client.send("Page.navigate", { url: options.url });
    }
    await waitForPage(client, Math.min(timeoutMs, 30000));

    const before = await evaluate(client, pageStateScript, options);
    if (before.loginLikely) {
      throw new Error("Doubao appears to be on a login screen. Sign in in the controlled browser and retry.");
    }
    if (!before.hasEditor) {
      throw new Error("Could not find the Doubao prompt editor. Use --editor-selector if the web UI changed.");
    }

    const inserted = await evaluate(client, insertPromptScript, options);
    if (!inserted?.ok) throw new Error(`Could not insert prompt: ${inserted?.reason || "unknown"}.`);

    const clicked = await evaluate(client, clickSendScript, options);
    if (!clicked?.ok) {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }

    const deadline = Date.now() + timeoutMs;
    let latest = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      const snapshot = await evaluate(client, answerSnapshotScript, options).catch(() => null);
      const candidate = compactText(snapshot?.text || bodyDelta(before.text, snapshot?.bodyText || "", options.prompt));
      if (candidate && candidate !== latest) {
        latest = candidate;
        stableSince = Date.now();
      } else if (latest && Date.now() - stableSince >= STABLE_ANSWER_MS) {
        const payload = { type: "assistant", provider: "doubao", text: latest, result: latest, url: snapshot?.url || "" };
        if (options.json) outputJson(payload);
        else outputText(latest);
        return 0;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error("Timed out waiting for a stable Doubao answer.");
  } finally {
    client.close();
  }
}

function printHelp() {
  outputText("Usage: doubao-cli.mjs doctor --json | ask --json --prompt <text> [--endpoint http://127.0.0.1:9222]");
  outputText(setupHint);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    if (options.command === "doctor") return await runDoctor(options);
    if (options.command === "ask") return await runAsk(options);
    printHelp();
    return options.command === "help" || options.command === "--help" || options.command === "-h" ? 0 : 2;
  } catch (error) {
    if (options.json) outputJson({ type: "error", ok: false, error: error.message, setupHint });
    else process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

process.exitCode = await main();
