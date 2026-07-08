const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:45771/extension";
const DEFAULT_DOUBAO_URL = "https://www.doubao.com/chat/";

let socket = null;
let reconnectTimer = null;

function isOpen(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

async function loadConfig() {
  const generated = await loadGeneratedConfig();
  const config = await chrome.storage.local.get({
    bridgeUrl: generated.bridgeUrl || DEFAULT_BRIDGE_URL,
    bridgeToken: generated.bridgeToken || "",
    doubaoUrl: generated.doubaoUrl || DEFAULT_DOUBAO_URL
  });
  return config;
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

function bridgeUrlWithToken(url, token) {
  const bridgeUrl = new URL(url);
  if (token) bridgeUrl.searchParams.set("token", token);
  return bridgeUrl.toString();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, 1500);
}

async function connectBridge() {
  if (isOpen(socket)) return;
  const config = await loadConfig();
  socket = new WebSocket(bridgeUrlWithToken(config.bridgeUrl, config.bridgeToken));
  socket.onmessage = (event) => handleBridgeMessage(event.data, config);
  socket.onclose = () => scheduleReconnect();
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      // Best effort.
    }
  };
}

async function findOrCreateDoubaoTab(config) {
  const tabs = await chrome.tabs.query({ url: "https://www.doubao.com/*" });
  const existing = tabs.find((tab) => /doubao\.com/i.test(tab.url || ""));
  const tab = existing || await chrome.tabs.create({ url: config.doubaoUrl || DEFAULT_DOUBAO_URL, active: false });
  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    // autoDiscardable is not available in every browser/version.
  }
  return tab;
}

async function sendToDoubaoContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    const manifest = chrome.runtime.getManifest();
    const declaredScript = manifest.content_scripts?.[0]?.js?.[0] || "src/content/doubao-content.js";
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [declaredScript]
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function handleDoubaoRequest(message, config) {
  const tab = await findOrCreateDoubaoTab(config);
  return sendToDoubaoContent(tab.id, {
    type: message.method,
    params: message.params || {}
  });
}

async function handleBridgeMessage(raw, config) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  try {
    if (message.method === "doubao.ask" || message.method === "doubao.diagnose") {
      const result = await handleDoubaoRequest(message, config);
      if (result?.ok === false) {
        socket?.send(JSON.stringify({
          id: message.id,
          ok: false,
          error: result.error || {
            code: "UNSUPPORTED_UI",
            message: "Doubao content script reported a page error.",
            recoverable: true
          }
        }));
        return;
      }
      socket?.send(JSON.stringify({ id: message.id, ok: true, result }));
      return;
    }
    socket?.send(JSON.stringify({
      id: message.id,
      ok: false,
      error: {
        code: "UNSUPPORTED_METHOD",
        message: `Unsupported method: ${message.method}`,
        recoverable: false
      }
    }));
  } catch (error) {
    socket?.send(JSON.stringify({
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

chrome.runtime.onInstalled.addListener(() => {
  connectBridge();
});

chrome.runtime.onStartup.addListener(() => {
  connectBridge();
});

connectBridge();

