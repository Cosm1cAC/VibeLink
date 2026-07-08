(() => {
if (globalThis.__DOUBAO_BRIDGE_CONTENT_VERSION__ >= 4) {
  return;
}
globalThis.__DOUBAO_BRIDGE_CONTENT_VERSION__ = 4;

const DEFAULT_TIMEOUT_MS = 120000;
const STABLE_ANSWER_MS = 2500;
const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:45771/extension";
const DEFAULT_DOUBAO_URL = "https://www.doubao.com/chat/";

let bridgeSocket = null;
let bridgeReconnectTimer = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function visible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

function compactText(value, max = 20000) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(-max);
}

async function loadGeneratedConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL("generated-config.json"));
    if (!response.ok) return {};
    return await response.json();
  } catch {
    return {};
  }
}

async function loadBridgeConfig() {
  const generated = await loadGeneratedConfig();
  const defaults = {
    bridgeUrl: generated.bridgeUrl || DEFAULT_BRIDGE_URL,
    bridgeToken: generated.bridgeToken || "",
    doubaoUrl: generated.doubaoUrl || DEFAULT_DOUBAO_URL
  };
  if (!chrome.storage?.local?.get) return defaults;
  return chrome.storage.local.get(defaults);
}

function bridgeUrlWithToken(url, token) {
  const bridgeUrl = new URL(url);
  if (token) bridgeUrl.searchParams.set("token", token);
  return bridgeUrl.toString();
}

function bridgeIsOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

function scheduleBridgeReconnect() {
  if (bridgeReconnectTimer) return;
  bridgeReconnectTimer = setTimeout(() => {
    bridgeReconnectTimer = null;
    connectBridge();
  }, 1500);
}

async function connectBridge() {
  if (typeof WebSocket === "undefined") return;
  if (bridgeIsOpen(bridgeSocket)) return;
  const config = await loadBridgeConfig();
  bridgeSocket = new WebSocket(bridgeUrlWithToken(config.bridgeUrl, config.bridgeToken));
  bridgeSocket.onmessage = (event) => handleBridgeMessage(event.data);
  bridgeSocket.onclose = () => scheduleBridgeReconnect();
  bridgeSocket.onerror = () => {
    try {
      bridgeSocket.close();
    } catch {
      // Best effort.
    }
  };
}

function comparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function findEditor() {
  const selector = "textarea,[contenteditable='true'],[role='textbox'],.ProseMirror";
  return [...document.querySelectorAll(selector)].filter(visible).at(-1) || null;
}

function diagnosePage() {
  const editor = findEditor();
  const text = document.body?.innerText || "";
  const candidates = answerCandidates("").slice(-8).map((item) => ({
    score: item.score,
    text: item.text.slice(-500)
  }));
  return {
    url: location.href,
    title: document.title,
    hasEditor: Boolean(editor),
    loginLikely: /登录|登陆|手机号|验证码|login|sign in/i.test(text) && !editor,
    bodyTail: compactText(text, 1000),
    candidateCount: candidates.length,
    candidates
  };
}

function insertPrompt(prompt) {
  const editor = findEditor();
  if (!editor) return { ok: false, reason: "EDITOR_NOT_FOUND" };

  editor.focus();
  if ("value" in editor) {
    editor.value = prompt;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
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
  return { ok: true };
}

function clickSend() {
  const buttons = [...document.querySelectorAll("button,[role='button']")].filter(visible);
  const sendButton = buttons.find((button) => {
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    const label = [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.textContent
    ].filter(Boolean).join(" ");
    return /发送|提交|send|submit/i.test(label);
  }) || buttons.filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true").at(-1);

  if (!sendButton) return { ok: false, reason: "SEND_BUTTON_NOT_FOUND" };
  sendButton.click();
  return { ok: true };
}

function answerCandidates(prompt) {
  const selector = [
    "article",
    "[role='article']",
    "[data-testid*='message' i]",
    "[class*='message' i]",
    "[class*='answer' i]",
    "[class*='assistant' i]",
    "[class*='markdown' i]"
  ].join(",");
  const promptPrefix = String(prompt || "").trim().slice(0, 160);
  const comparablePrompt = comparableText(promptPrefix);
  const candidates = [...document.querySelectorAll(selector)]
    .filter(visible)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const className = String(element.className || "");
      const text = compactText(element.innerText || element.textContent || "");
      let score = rect.top + rect.height;
      if (/assistant|answer|markdown|message/i.test(className)) score += 10000;
      return { text, score };
    })
    .filter((item) => {
      if (!item.text) return false;
      if (promptPrefix && item.text.includes(promptPrefix)) return false;
      return !comparablePrompt || !comparableText(item.text).includes(comparablePrompt);
    })
    .sort((a, b) => a.score - b.score);

  return candidates;
}

function answerSnapshot(prompt, ignoredAnswers = new Set()) {
  const candidates = answerCandidates(prompt)
    .filter((item) => !ignoredAnswers.has(item.text));

  return candidates.at(-1)?.text || "";
}

async function waitForAnswer(prompt, timeoutMs, ignoredAnswers = new Set()) {
  const deadline = Date.now() + Math.max(5000, Number(timeoutMs || DEFAULT_TIMEOUT_MS));
  let latest = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    const text = answerSnapshot(prompt, ignoredAnswers);
    if (text && text !== latest) {
      latest = text;
      stableSince = Date.now();
    } else if (latest && Date.now() - stableSince >= STABLE_ANSWER_MS) {
      return latest;
    }
    await sleep(1000);
  }
  throw new Error("Timed out waiting for a stable Doubao answer.");
}

async function askDoubao(params = {}) {
  const diagnosis = diagnosePage();
  if (diagnosis.loginLikely) throw new Error("Doubao page appears to require login.");
  if (!diagnosis.hasEditor) throw new Error("Could not find the Doubao prompt editor.");

  const prompt = String(params.prompt || "");
  const ignoredAnswers = new Set(answerCandidates(prompt).map((item) => item.text));
  const inserted = insertPrompt(prompt);
  if (!inserted.ok) throw new Error(inserted.reason);

  const clicked = clickSend();
  if (!clicked.ok) throw new Error(clicked.reason);

  const text = await waitForAnswer(prompt, params.timeoutMs, ignoredAnswers);
  return {
    provider: "doubao",
    text,
    url: location.href
  };
}

async function handleBridgeMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  try {
    if (message.method === "doubao.diagnose") {
      bridgeSocket?.send(JSON.stringify({
        id: message.id,
        ok: true,
        result: {
          ...diagnosePage(),
          scriptVersion: 4,
          bridgeClient: "content"
        }
      }));
      return;
    }

    if (message.method === "doubao.ask") {
      const result = await askDoubao(message.params || {});
      bridgeSocket?.send(JSON.stringify({
        id: message.id,
        ok: true,
        result: {
          ...result,
          scriptVersion: 4,
          bridgeClient: "content"
        }
      }));
      return;
    }

    bridgeSocket?.send(JSON.stringify({
      id: message.id,
      ok: false,
      error: {
        code: "UNSUPPORTED_METHOD",
        message: `Unsupported method: ${message.method}`,
        recoverable: false
      }
    }));
  } catch (error) {
    bridgeSocket?.send(JSON.stringify({
      id: message.id,
      ok: false,
      error: {
        code: "UNSUPPORTED_UI",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true
      }
    }));
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "doubao.diagnose.v4") {
    sendResponse({
      ...diagnosePage(),
      scriptVersion: 4
    });
    return false;
  }

  if (message?.type === "doubao.ask.v4") {
    askDoubao(message.params || {})
      .then((result) => sendResponse({
        ...result,
        scriptVersion: 4
      }))
      .catch((error) => sendResponse({
        ok: false,
        error: {
          code: "UNSUPPORTED_UI",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true
        }
      }));
    return true;
  }

  return false;
});

globalThis.__DOUBAO_BRIDGE_CONTENT_INTERNALS__ = {
  answerCandidates,
  answerSnapshot,
  waitForAnswer
};

connectBridge();
})();
