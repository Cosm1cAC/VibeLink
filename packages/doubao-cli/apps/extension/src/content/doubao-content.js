(() => {
if (globalThis.__DOUBAO_BRIDGE_CONTENT_VERSION__ >= 6) {
  return;
}
globalThis.__DOUBAO_BRIDGE_CONTENT_VERSION__ = 6;

const DEFAULT_TIMEOUT_MS = 120000;
const STABLE_ANSWER_MS = 2500;
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "doubao.diagnose.v6") {
    sendResponse({
      ...diagnosePage(),
      scriptVersion: 6,
      bridgeClient: "service_worker"
    });
    return false;
  }

  if (message?.type === "doubao.ask.v6") {
    askDoubao(message.params || {})
      .then((result) => sendResponse({
        ...result,
        scriptVersion: 6,
        bridgeClient: "service_worker"
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
  diagnosePage,
  waitForAnswer
};

// Local bridge transport is owned by the MV3 service worker; this content script only manipulates the Doubao page and responds to versioned runtime messages.
})();
