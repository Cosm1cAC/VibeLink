const state = {
  token: localStorage.getItem("mat.token") || "",
  settings: null,
  tasks: [],
  histories: [],
  conversations: [],
  selected: null,
  activeAgent: "codex",
  eventSource: null,
  typingTimers: new Set(),
  addMenuOpen: false
};

const $ = (selector) => document.querySelector(selector);

function on(selector, eventName, handler) {
  const element = $(selector);
  if (element) element.addEventListener(eventName, handler);
}

function authHeaders() {
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

async function api(path, options = {}) {
  const useAuth = options.auth !== false;
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(useAuth ? authHeaders() : {}),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function showLogin() {
  $('[data-view="login"]').classList.remove("hidden");
  $('[data-view="main"]').classList.add("hidden");
}

function showMain() {
  $('[data-view="login"]').classList.add("hidden");
  $('[data-view="main"]').classList.remove("hidden");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function compact(value, fallback = "未命名会话") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function availableProviders() {
  const providers = [];
  if (state.settings?.hasOpenAIKey) providers.push("codex");
  if (state.settings?.hasAnthropicKey) providers.push("claude");
  return providers;
}

function ensureActiveAgent() {
  const providers = availableProviders();
  if (providers.includes(state.activeAgent)) return;
  state.activeAgent = providers[0] || "codex";
}

function providerLabel(provider) {
  return provider === "claude" ? "Claude" : "Codex";
}

function firstTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content?.text === "string") return content.text;
  return "";
}

function extractEntryText(item) {
  const payload = item.payload || {};
  const message = item.message || payload.message || item;
  return (
    firstTextFromContent(message.content) ||
    firstTextFromContent(payload.content) ||
    firstTextFromContent(item.content) ||
    payload.text ||
    payload.summary ||
    item.display ||
    item.summary ||
    ""
  );
}

function entryRole(item) {
  const payload = item.payload || {};
  const message = item.message || payload.message || item;
  const raw = item.role || message.role || payload.role || payload.type || item.type || "assistant";
  if (raw === "user" || raw === "stdin") return "user";
  if (raw === "assistant" || raw === "json" || raw === "stdout") return "assistant";
  if (raw === "error" || raw === "stderr") return "error";
  return "system";
}

function taskEventRole(event) {
  if (event.type === "stdin") return "user";
  if (event.type === "error") return "error";
  if (event.type === "stderr") return /\berror\b|spawn|ENOENT|EPERM|EACCES|failed/i.test(event.text || "") ? "error" : "debug";
  if (event.type === "system") return "system";
  if (event.type === "json" || event.type === "stdout") return "assistant";
  return "log";
}

function taskEventText(event) {
  if (event.type === "json" && event.text) return event.text;
  return event.text || "";
}

function showToast(error) {
  const message = error instanceof Error ? error.message : String(error);
  $("#chatMeta").textContent = message;
}

function renderProviderControls() {
  const providers = availableProviders();
  const select = $("#agentSelect");
  select.innerHTML = providers
    .map((provider) => `<option value="${provider}">${providerLabel(provider)}</option>`)
    .join("");
  select.disabled = providers.length <= 1;
  ensureActiveAgent();
  select.value = state.activeAgent;
}

function renderSettings(status) {
  state.settings = status.settings;
  ensureActiveAgent();
  $("#connectionLine").textContent = `已连接 ${location.host}`;
  $("#defaultCwd").value = state.settings.defaultCwd || "";
  $("#claudeCommand").value = state.settings.claudeCommand || "claude";
  $("#codexCommand").value = state.settings.codexCommand || "auto";
  $("#codexTemplate").value = state.settings.codexTemplate || "";
  $("#permissionModeInline").value = state.settings.permissionMode || "default";
  $("#settingsOpenAIKey").placeholder = state.settings.hasOpenAIKey ? "已保存，留空不修改" : "未设置";
  $("#settingsAnthropicKey").placeholder = state.settings.hasAnthropicKey ? "已保存，留空不修改" : "未设置";
  renderProviderControls();

  const network = status.network || [];
  const primary = network.find((item) => item.address?.startsWith("192.168.")) || network[0];
  $("#networkLine").textContent = primary ? primary.url : location.origin;
  $("#networkList").innerHTML = network
    .map(
      (item) => `
        <div class="network-item">
          <h3>${escapeHtml(item.url)}</h3>
          <p>${escapeHtml(item.name)} · ${escapeHtml(item.address)}</p>
        </div>
      `
    )
    .join("");
}

function buildConversations() {
  const providers = new Set(availableProviders());
  const tasks = state.tasks
    .filter((task) => providers.has(task.agent))
    .map((task) => ({
      key: `task:${task.id}`,
      kind: "task",
      id: task.id,
      provider: task.agent,
      title: compact(task.title, `${task.agent} 任务`),
      cwd: task.cwd || "",
      status: task.status,
      updatedAt: task.updatedAt,
      sessionId: task.sessionId || ""
    }));

  const histories = state.histories
    .filter((item) => providers.has(item.provider))
    .map((item) => ({
      key: `history:${item.provider}:${item.id}`,
      kind: "history",
      id: item.id,
      provider: item.provider,
      title: compact(item.title, item.id),
      cwd: item.projectPath || "",
      status: "history",
      updatedAt: item.updatedAt,
      sessionId: item.id,
      preview: item.preview || ""
    }));

  state.conversations = [...tasks, ...histories].sort((a, b) => {
    const bt = new Date(b.updatedAt || 0).getTime();
    const at = new Date(a.updatedAt || 0).getTime();
    return bt - at;
  });
}

function filteredConversations() {
  const query = $("#conversationSearch").value.trim().toLowerCase();
  if (!query) return state.conversations;
  return state.conversations.filter((item) =>
    `${item.title} ${item.provider} ${item.cwd} ${item.sessionId}`.toLowerCase().includes(query)
  );
}

function renderConversationList() {
  const items = filteredConversations();
  const selectedKey = state.selected?.key || "";

  if (!availableProviders().length) {
    $("#conversationList").innerHTML = `
      <div class="conversation-item">
        <h3>需要 API Key</h3>
        <div class="conversation-meta">设置 OpenAI 或 Anthropic API Key 后显示对应会话</div>
      </div>
    `;
    return;
  }

  if (!items.length) {
    $("#conversationList").innerHTML = `
      <div class="conversation-item">
        <h3>没有可用会话</h3>
        <div class="conversation-meta">当前只显示已配置 API Key 的 Agent</div>
      </div>
    `;
    return;
  }

  $("#conversationList").innerHTML = items
    .map(
      (item) => `
        <button class="conversation-item ${item.key === selectedKey ? "active" : ""}" data-key="${escapeHtml(item.key)}" type="button">
          <h3>${escapeHtml(item.title)}</h3>
          <div class="conversation-meta">
            <span class="badge ${item.provider}">${item.provider}</span>
            ${item.kind === "task" ? `<span class="badge ${item.status}">${item.status}</span>` : ""}
            <span>${formatTime(item.updatedAt)}</span>
          </div>
        </button>
      `
    )
    .join("");
}

function closeEventSource() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function clearTyping() {
  for (const timer of state.typingTimers) clearTimeout(timer);
  state.typingTimers.clear();
}

function setHeader(conversation) {
  if (!conversation) {
    $("#chatTitle").textContent = "新会话";
    $("#chatMeta").textContent = availableProviders().length ? "输入任务，Agent 会在电脑上继续执行" : "先在设置中添加 API Key";
    $("#agentSelect").value = state.activeAgent;
    $("#composerInput").placeholder = availableProviders().length ? "向 Agent 发送消息" : "添加 API Key 后可发送";
    return;
  }

  state.activeAgent = conversation.provider;
  $("#agentSelect").value = conversation.provider;
  $("#chatTitle").textContent = conversation.title;
  $("#chatMeta").textContent = [
    providerLabel(conversation.provider),
    conversation.kind === "task" ? conversation.status : "历史上下文",
    conversation.cwd
  ]
    .filter(Boolean)
    .join(" · ");
  $("#composerInput").placeholder =
    conversation.kind === "task" && conversation.status === "running"
      ? "当前任务运行中，等待本轮完成"
      : "输入消息，接续这条会话";
}

function renderEmpty() {
  $("#messageList").innerHTML = `
    <div class="empty-state">
      <h2>${availableProviders().length ? "今天让哪个 Agent 接手？" : "先连接一个 Agent"}</h2>
      <p>${availableProviders().length ? "左侧选择会话可直接读取上下文；也可以从这里开始新任务。" : "设置 OpenAI API Key 后显示 Codex 会话；设置 Anthropic API Key 后显示 Claude 会话。"}</p>
    </div>
  `;
}

function messageHtml(role, text, typing = false) {
  if (!text && !typing) return "";
  if (role === "debug") return "";
  const label = role === "user" ? "你" : role === "assistant" ? "Agent" : role === "error" ? "错误" : "系统";
  const className = role === "assistant" ? "assistant" : role;
  return `
    <article class="message ${className}">
      <div class="message-role">${label}</div>
      <div class="message-bubble ${typing ? "typing-caret" : ""}">${escapeHtml(text)}</div>
    </article>
  `;
}

function scrollMessagesToEnd() {
  const list = $("#messageList");
  list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
}

function appendMessage(role, text, options = {}) {
  if (!text && !options.typing) return null;
  const container = $("#messageList");
  container.insertAdjacentHTML("beforeend", messageHtml(role, options.typing ? "" : text, options.typing));
  const bubble = container.querySelector(".message:last-child .message-bubble");

  if (options.typing && bubble) {
    typeIntoBubble(bubble, text, options.speed || 12);
  }

  scrollMessagesToEnd();
  return bubble;
}

function typeIntoBubble(bubble, text, speed) {
  const chars = [...String(text)];
  let index = 0;
  bubble.textContent = "";

  const tick = () => {
    index += Math.max(1, Math.floor(chars.length / 180));
    bubble.textContent = chars.slice(0, index).join("");
    scrollMessagesToEnd();

    if (index < chars.length) {
      const timer = setTimeout(tick, speed);
      state.typingTimers.add(timer);
    } else {
      bubble.classList.remove("typing-caret");
    }
  };

  tick();
}

function renderHistory(detail) {
  clearTyping();
  const entries = (detail.entries || [])
    .filter((item) => item.type !== "session_meta" && item.type !== "turn_context")
    .map((item) => ({ role: entryRole(item), text: extractEntryText(item) }))
    .filter((item) => item.text)
    .slice(-80);

  if (!entries.length && detail.preview) {
    entries.push({ role: "assistant", text: detail.preview });
  }

  $("#messageList").innerHTML = "";
  if (!entries.length) {
    appendMessage("system", "这条历史只有索引信息，暂无可预览的本地消息。");
    return;
  }

  for (const item of entries) appendMessage(item.role, item.text);
}

function renderTask(task) {
  clearTyping();
  const events = (task.events || [])
    .map((event) => ({ role: taskEventRole(event), text: taskEventText(event) }))
    .filter((item) => item.text && item.role !== "debug");

  $("#messageList").innerHTML = "";
  if (!events.length) {
    appendMessage("system", "任务已启动，等待输出。");
    return;
  }

  for (const item of events) appendMessage(item.role, item.text);
}

function appendTaskEvent(event) {
  const role = taskEventRole(event);
  const text = taskEventText(event);
  if (!text || role === "debug") return;
  appendMessage(role, text, { typing: role === "assistant" });
}

function setRunState(text, running = false) {
  $("#runState").textContent = text;
  $("#runState").classList.toggle("running", running);
}

async function selectConversation(conversation) {
  closeEventSource();
  clearTyping();
  state.selected = conversation;
  setHeader(conversation);
  renderConversationList();
  closeSidebar();

  if (!conversation) {
    renderEmpty();
    setRunState("就绪");
    return;
  }

  $("#messageList").innerHTML = "";
  appendMessage("system", "读取本地上下文中。");

  if (conversation.kind === "task") {
    const task = await api(`/api/tasks/${conversation.id}`);
    renderTask(task);
    setRunState(task.status === "running" ? "运行中" : task.status, task.status === "running");

    if (task.status === "running") {
      state.eventSource = new EventSource(`/api/tasks/${task.id}/events?token=${encodeURIComponent(state.token)}`);
      state.eventSource.addEventListener("task", (message) => {
        const event = JSON.parse(message.data);
        appendTaskEvent(event);
        if (event.type === "system" && /Exited/.test(event.text || "")) refreshAll({ keepSelection: true }).catch(() => {});
      });
    }
    return;
  }

  if (conversation.preview) {
    $("#messageList").innerHTML = "";
    appendMessage("assistant", conversation.preview, { typing: true, speed: 6 });
  }

  const detail = await api(`/api/histories/${conversation.provider}/${encodeURIComponent(conversation.id)}`);
  renderHistory(detail);
  setRunState("就绪");
}

async function refreshAll(options = {}) {
  const status = await api("/api/status");
  state.tasks = status.tasks || [];
  renderSettings(status);

  const histories = await api("/api/histories");
  state.histories = histories.items || [];
  buildConversations();
  renderConversationList();
  showMain();

  if (options.keepSelection && state.selected) {
    const updated = state.conversations.find((item) => item.key === state.selected.key);
    if (updated) state.selected = updated;
    setHeader(state.selected);
  }
}

async function startTask(prompt) {
  const selected = state.selected;
  const canResume =
    selected?.kind === "history" ||
    (selected?.kind === "task" && selected.sessionId && selected.status !== "running");
  const payload = {
    agent: state.activeAgent,
    cwd: selected?.cwd || state.settings?.defaultCwd || "",
    mode: canResume ? "resume" : "new",
    sessionId: canResume ? selected.sessionId : "",
    prompt
  };

  setRunState("启动中", true);
  const created = await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  await refreshAll();
  const taskConversation = state.conversations.find((item) => item.key === `task:${created.id}`);
  if (taskConversation) await selectConversation(taskConversation);
}

function openSidebar() {
  $("#sidebar").classList.add("open");
  $("#sidebarBackdrop").classList.remove("hidden");
}

function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#sidebarBackdrop").classList.add("hidden");
}

function openSettings() {
  $("#settingsDrawer").classList.remove("hidden");
}

function closeSettings() {
  $("#settingsDrawer").classList.add("hidden");
}

function toggleAddMenu(force) {
  state.addMenuOpen = typeof force === "boolean" ? force : !state.addMenuOpen;
  $("#addMenu").classList.toggle("hidden", !state.addMenuOpen);
}

function togglePlanMode() {
  const pressed = $("#planModeButton").getAttribute("aria-pressed") === "true";
  const next = !pressed;
  $("#planModeButton").setAttribute("aria-pressed", String(next));
  $("#permissionModeInline").value = next ? "plan" : state.settings?.permissionMode || "default";
  $("#permissionModeInline").dispatchEvent(new Event("change"));
  toggleAddMenu(false);
}

function syncComposerAvailability() {
  const hasProviders = availableProviders().length > 0;
  $("#sendButton").disabled = !hasProviders;
  $("#composerInput").disabled = !hasProviders;
}

function bindEvents() {
  on("#loginForm", "submit", async (event) => {
    event.preventDefault();
    $("#loginError").textContent = "";
    const pairingToken = $("#pairingToken").value.trim();
    state.token = pairingToken;

    try {
      await api("/api/login", {
        method: "POST",
        auth: false,
        body: JSON.stringify({
          pairingToken,
          rememberKeys: $("#rememberKeys").checked,
          apiKeys: {
            openai: $("#openaiKey").value.trim(),
            anthropic: $("#anthropicKey").value.trim()
          }
        })
      });
      localStorage.setItem("mat.token", pairingToken);
      await refreshAll();
      syncComposerAvailability();
      await selectConversation(null);
    } catch (error) {
      $("#loginError").textContent = error.message;
      showLogin();
    }
  });

  on("#newChatButton", "click", () => selectConversation(null).catch(showToast));
  on("#refreshButton", "click", () => refreshAll({ keepSelection: true }).catch(showToast));
  on("#conversationSearch", "input", renderConversationList);

  on("#conversationList", "click", (event) => {
    const button = event.target.closest("[data-key]");
    if (!button) return;
    const conversation = state.conversations.find((item) => item.key === button.dataset.key);
    if (conversation) selectConversation(conversation).catch(showToast);
  });

  on("#agentSelect", "change", () => {
    state.activeAgent = $("#agentSelect").value;
    if (state.selected && state.selected.provider !== state.activeAgent) {
      selectConversation(null).catch(showToast);
    } else {
      setHeader(state.selected);
    }
  });

  on("#permissionModeInline", "change", async () => {
    const permissionMode = $("#permissionModeInline").value;
    state.settings.permissionMode = permissionMode;
    $("#planModeButton").setAttribute("aria-pressed", String(permissionMode === "plan"));
    await api("/api/settings", {
      method: "POST",
      headers: { "If-Match": `"vibelink:settings:${Number(state.settings.revision || 0)}"` },
      body: JSON.stringify({ permissionMode, expectedRevision: Number(state.settings.revision || 0) })
    }).then((result) => { state.settings = result.settings || state.settings; }).catch(async (error) => {
      if (error.status === 409 && error.data?.current?.settings) {
        state.settings = error.data.current.settings;
        renderSettings({ settings: state.settings });
      }
      showToast(error);
    });
  });

  on("#planModeButton", "click", togglePlanMode);
  on("#planMenuItem", "click", togglePlanMode);
  on("#goalMenuItem", "click", () => {
    $("#composerInput").value = `${$("#composerInput").value.trim()} ${$("#composerInput").value.trim() ? "\n" : ""}目标：`;
    $("#composerInput").focus();
    toggleAddMenu(false);
  });
  on("#addButton", "click", () => toggleAddMenu());

  on("#composerInput", "input", () => {
    const box = $("#composerInput");
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 190)}px`;
  });

  on("#composerForm", "submit", async (event) => {
    event.preventDefault();
    const text = $("#composerInput").value.trim();
    if (!text || !availableProviders().length) return;
    $("#composerInput").value = "";
    $("#composerInput").style.height = "auto";
    toggleAddMenu(false);

    if (state.selected?.kind === "task" && state.selected.status === "running") {
      appendMessage("system", "当前任务仍在运行，等本轮完成后会自动接续下一条。");
      return;
    }

    appendMessage("user", text);
    await startTask(text).catch(showToast);
  });

  on("#settingsButton", "click", openSettings);
  on("#closeSettings", "click", closeSettings);
  on("#menuButton", "click", openSidebar);
  on("#sidebarBackdrop", "click", closeSidebar);

  on("#settingsForm", "submit", async (event) => {
    event.preventDefault();
    const draft = {
      defaultCwd: $("#defaultCwd").value.trim(),
      claudeCommand: $("#claudeCommand").value.trim(),
      codexCommand: $("#codexCommand").value.trim(),
      codexTemplate: $("#codexTemplate").value.trim()
    };
    const apiKeys = {};
    if ($("#settingsOpenAIKey").value.trim()) apiKeys.openai = $("#settingsOpenAIKey").value.trim();
    if ($("#settingsAnthropicKey").value.trim()) apiKeys.anthropic = $("#settingsAnthropicKey").value.trim();

    try {
      await api("/api/settings", {
        method: "POST",
        headers: { "If-Match": `"vibelink:settings:${Number(state.settings.revision || 0)}"` },
        body: JSON.stringify({ ...draft, apiKeys, expectedRevision: Number(state.settings.revision || 0) })
      });
    } catch (error) {
      if (error.status !== 409) throw error;
      state.settings = error.data?.current?.settings || (await api("/api/settings")).settings;
      renderSettings({ settings: state.settings });
      $("#defaultCwd").value = draft.defaultCwd;
      $("#claudeCommand").value = draft.claudeCommand;
      $("#codexCommand").value = draft.codexCommand;
      $("#codexTemplate").value = draft.codexTemplate;
      showToast("设置已在其他设备修改；已刷新基线并保留本机草稿，请检查后重试。");
      return;
    }
    $("#settingsOpenAIKey").value = "";
    $("#settingsAnthropicKey").value = "";
    closeSettings();
    await refreshAll({ keepSelection: true });
    syncComposerAvailability();
    if (state.selected && !availableProviders().includes(state.selected.provider)) await selectConversation(null);
  });
}

async function boot() {
  bindEvents();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  if (!state.token) {
    showLogin();
    return;
  }

  try {
    await refreshAll();
    syncComposerAvailability();
    await selectConversation(null);
  } catch {
    showLogin();
  }
}

boot();
