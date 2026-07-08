const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:45771/extension";
const DEFAULT_DOUBAO_URL = "https://www.doubao.com/chat/";

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
const activeRequests = new Map();

function isOpen(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

async function loadConfig() {
  const generated = await loadGeneratedConfig();
  const stored = await chrome.storage.local.get({
    bridgeUrl: DEFAULT_BRIDGE_URL,
    bridgeToken: "",
    doubaoUrl: DEFAULT_DOUBAO_URL
  });
  return {
    bridgeUrl: generated.bridgeUrl || stored.bridgeUrl || DEFAULT_BRIDGE_URL,
    bridgeToken: generated.bridgeToken || stored.bridgeToken || "",
    doubaoUrl: generated.doubaoUrl || stored.doubaoUrl || DEFAULT_DOUBAO_URL
  };
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

function clearHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat(ws) {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!isOpen(ws)) {
      clearHeartbeat();
      return;
    }
    ws.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
  }, 20000);
}

async function connectBridge() {
  if (isOpen(socket)) return;

  let config;
  try {
    config = await loadConfig();
  } catch {
    scheduleReconnect();
    return;
  }

  try {
    socket = new WebSocket(bridgeUrlWithToken(config.bridgeUrl, config.bridgeToken));
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => startHeartbeat(socket);
  socket.onmessage = (event) => handleBridgeMessage(event.data, config);
  socket.onclose = () => {
    clearHeartbeat();
    scheduleReconnect();
  };
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
  const manifest = chrome.runtime.getManifest();
  const declaredScript = manifest.content_scripts?.[0]?.js?.[0] || "src/content/doubao-content.js";
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [declaredScript]
  });

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function sendBridgeProgress(requestId, progress = {}) {
  if (!isOpen(socket)) return;
  socket.send(JSON.stringify({
    id: requestId,
    type: "progress",
    ok: true,
    progress
  }));
}

async function handleDoubaoRequest(message, config) {
  const tab = await findOrCreateDoubaoTab(config);
  const requestId = message.id;
  const keepAlive = setInterval(() => {
    sendBridgeProgress(requestId, {
      stage: "service_worker_waiting",
      ts: Date.now()
    });
  }, 10000);

  activeRequests.set(requestId, { keepAlive });
  try {
    return await sendToDoubaoContent(tab.id, {
      type: `${message.method}.v7`,
      requestId,
      params: message.params || {}
    });
  } finally {
    clearInterval(keepAlive);
    activeRequests.delete(requestId);
  }
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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "doubao.progress.v7" || !message.requestId) return false;
  const request = activeRequests.get(message.requestId);
  if (!request) return false;
  sendBridgeProgress(message.requestId, message.payload || {});
  return false;
});

function startBridgeConnection() {
  connectBridge().catch(() => scheduleReconnect());
}

chrome.runtime.onInstalled.addListener(startBridgeConnection);
chrome.runtime.onStartup.addListener(startBridgeConnection);

startBridgeConnection();
