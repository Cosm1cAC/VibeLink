import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  Archive,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  FileText,
  FilePlus2,
  Folder,
  FolderOpen,
  History,
  Image as ImageIcon,
  Menu,
  Monitor,
  MoreHorizontal,
  Plus,
  RotateCcw,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Square,
  Target,
  Terminal,
  X
} from "lucide-react";
import "./styles.css";

const savedToken = localStorage.getItem("mat.token") || "";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function bridgeConnectionError() {
  const lastUrl = localStorage.getItem("mat.lastBridgeUrl") || "";
  const suffix = lastUrl && lastUrl !== location.origin ? ` Latest known LAN URL: ${lastUrl}` : "";
  return new Error(`Cannot connect to the local bridge at ${location.origin}.${suffix} Reopen the current LAN/tunnel URL and make sure the bridge is running.`);
}

async function request(path, options = {}, token = savedToken) {
  const useAuth = options.auth !== false;
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(useAuth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
  } catch {
    throw bridgeConnectionError();
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
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

function formatDurationMs(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds}s`;
  if (!seconds) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function attachmentKind(file) {
  return file?.type?.startsWith("image/") ? "image" : "file";
}

function compact(value, fallback = "Untitled") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function providerLabel(provider) {
  return provider === "claude" ? "Claude" : "Codex";
}

function desktopBlockedByRemotePage(desktop) {
  return (desktop?.reason || "").includes("remote control page is open inside Codex Desktop");
}

function desktopRunningTurn(desktop) {
  return Boolean(desktop?.sidebarHasRunning || desktop?.sidebarRunningCount > 0) || /running a turn|Stop button|composer is unavailable/i.test(desktop?.reason || "");
}

function desktopStatusText(desktop) {
  if (!desktop) return "\u6b63\u5728\u76d1\u542c Codex Desktop \u72b6\u6001\u3002";
  if (desktop.ok === false && desktop.reason) return `Codex Desktop status check failed: ${desktop.reason}`;
  if (desktopBlockedByRemotePage(desktop)) {
    return "\u9065\u63a7\u9875\u6b63\u5f00\u5728 Codex \u5185\u7f6e\u6d4f\u89c8\u5668\u91cc\uff0c\u8bf7\u7528\u624b\u673a\u6216\u72ec\u7acb Chrome \u6253\u5f00\u3002";
  }
  if (desktop.minimized) return "Codex Desktop \u5df2\u6700\u5c0f\u5316\uff0c\u53d1\u9001\u65f6\u4f1a\u81ea\u52a8\u6062\u590d\u7a97\u53e3\u3002";
  if (desktop?.sidebarHasRunning || desktop?.sidebarRunningCount > 0) return `Codex \u5de6\u4fa7\u6700\u8fd1\u4f1a\u8bdd\u6709 ${desktop.sidebarRunningCount || 1} \u4e2a\u4efb\u52a1\u6b63\u5728\u8fd0\u884c\uff0c\u7b49\u5f85\u8f6c\u5708\u6d88\u5931\u540e\u63a5\u7ba1\u3002`;
  if (desktopRunningTurn(desktop)) return "Codex Desktop \u5f53\u524d composer \u663e\u793a Stop \u6309\u94ae\uff0c\u672c\u8f6e\u6267\u884c\u7ed3\u675f\u540e\u624d\u80fd\u63a5\u7ba1\u3002";
  if (desktop.ready) return "Codex Desktop \u7a7a\u95f2\uff0c\u53ef\u9065\u63a7\u53d1\u9001\u3002";
  if (desktop.found) return "Codex Desktop \u6682\u4e0d\u53ef\u8f93\u5165\uff0c\u6d88\u606f\u4f1a\u6392\u961f\u7b49\u5f85\u3002";
  return "\u672a\u627e\u5230 Codex Desktop \u7a97\u53e3\u3002";
}

function desktopMetaText(desktop) {
  if (desktop?.ok === false && desktop.reason) return "Codex Desktop status check failed. Refresh or restart the local bridge.";
  if (desktopBlockedByRemotePage(desktop)) {
    return "\u9065\u63a7\u9875\u5f00\u5728 Codex \u5185\u7f6e\u6d4f\u89c8\u5668\u91cc\uff0c\u8bf7\u7528\u624b\u673a\u6216\u72ec\u7acb Chrome";
  }
  if (desktop?.minimized) return "Codex Desktop \u5df2\u6700\u5c0f\u5316\uff0c\u53d1\u9001\u65f6\u4f1a\u81ea\u52a8\u6062\u590d";
  if (desktop?.sidebarHasRunning || desktop?.sidebarRunningCount > 0) return "Codex \u5de6\u4fa7\u6700\u8fd1\u4f1a\u8bdd\u6709\u4efb\u52a1\u5728\u8fd0\u884c";
  if (desktopRunningTurn(desktop)) return "Codex Desktop \u5f53\u524d composer \u6b63\u5728\u6267\u884c\uff0c\u7b49\u5f85\u672c\u8f6e\u7ed3\u675f";
  return desktop?.ready ? "\u8fdc\u7a0b\u8f93\u5165\u4f1a\u76f4\u63a5\u53d1\u9001\u5230 Codex Desktop" : "\u6d88\u606f\u4f1a\u6392\u961f\uff0c\u7b49\u5f85 Codex Desktop \u7a7a\u95f2";
}

function desktopPillLabel(desktop) {
  if (desktop?.ok === false && desktop.reason) return "Check failed";
  if (desktopBlockedByRemotePage(desktop)) return "\u8bf7\u6362\u6d4f\u89c8\u5668";
  if (desktop?.minimized) return "\u5df2\u6700\u5c0f\u5316";
  if (desktop?.sidebarHasRunning || desktop?.sidebarRunningCount > 0) return "\u6709\u4efb\u52a1\u8fd0\u884c";
  if (desktopRunningTurn(desktop)) return "\u672c\u8f6e\u6267\u884c\u4e2d";
  if (desktop?.ready) return "Codex \u7a7a\u95f2";
  if (desktop?.found) return "\u7b49\u5f85 Codex \u7a7a\u95f2";
  return "\u672a\u627e\u5230 Codex";
}

function desktopQueueLabel(desktopRemote) {
  const count = Number(desktopRemote?.pendingCount || 0);
  const desktop = desktopRemote?.desktop;
  if (count > 0) {
    if (desktop?.ready) return `${count} 条待发送`;
    if (desktop?.minimized) return `${count} 条已排队，发送时会恢复 Codex`;
    if (desktopRunningTurn(desktop)) return `${count} 条已排队，等待 Codex 空闲`;
    if (desktop?.found) return `${count} 条已排队`;
    return `${count} 条已排队，未找到 Codex`;
  }
  return desktopPillLabel(desktop);
}

function targetLabel({ isDesktop, selected, activeAgent }) {
  if (isDesktop || hasDesktopBinding(selected)) return "遥控 Codex";
  return `发送到 ${providerLabel(activeAgent)}`;
}

function permissionLabel(value) {
  const labels = {
    default: "默认权限",
    acceptEdits: "自动接受编辑",
    auto: "自动模式",
    dontAsk: "无需确认",
    plan: "计划模式",
    bypassPermissions: "完全访问"
  };
  return labels[value] || "默认权限";
}

function effortLabel(value) {
  const labels = {
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大"
  };
  return labels[value] || "默认";
}

function desktopListStatus(desktop) {
  if (desktop?.ok === false && desktop.reason) return "failed";
  if (desktop?.ready) return "ready";
  if (desktop?.minimized) return "minimized";
  if (desktop?.sidebarHasRunning || desktop?.sidebarRunningCount > 0) return "running";
  return desktop?.found ? "waiting" : "offline";
}

function hasDesktopBinding(conversation) {
  return conversation?.provider === "codex" && Number.isFinite(Number(conversation.desktopIndex));
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
    (typeof payload.message === "string" ? payload.message : "") ||
    payload.text ||
    payload.summary ||
    item.display ||
    item.summary ||
    ""
  );
}

function rawEntryRole(item) {
  const payload = item.payload || {};
  const message = item.message || payload.message || item;
  return item.role || message.role || payload.role || payload.type || item.type || "assistant";
}

function historyEntryKind(item) {
  const payload = item?.payload || {};
  const message = item?.message || payload.message || item || {};
  return String(item?.kind || message.type || payload.type || item?.type || "").toLowerCase();
}

function entryRole(item) {
  const raw = rawEntryRole(item);
  if (raw === "user" || raw === "stdin" || raw === "user_message") return "user";
  if (raw === "assistant" || raw === "json" || raw === "stdout" || raw === "agent_message" || raw === "assistant_message") return "assistant";
  if (raw === "error" || raw === "stderr") return "error";
  return "system";
}

function taskEventRole(event) {
  if (event.type === "stdin") return "user";
  if (event.type === "error") return "error";
  if (event.type === "stderr") {
    const text = event.text || "";
    if (/\bWARN\b/i.test(text)) return "debug";
    return /(\bERROR\b|\berror:|spawn|ENOENT|EPERM|EACCES|permission denied|unauthorized|not inside a trusted directory|git repo check)/i.test(text) ? "error" : "debug";
  }
  if (event.type === "system") return "system";
  if (event.type === "json" || event.type === "stdout") return "assistant";
  return "log";
}

function taskEventText(event) {
  if (event.type === "json" && event.text) return event.text;
  return event.text || "";
}

function messagesFromEvents(events = []) {
  return normalizeDisplayMessages(
    events
    .map((event) => ({ role: taskEventRole(event), text: taskEventText(event), typing: taskEventRole(event) === "assistant" }))
      .filter((item) => item.text && item.role !== "debug")
  );
}

function isHistoryNoise(item, text) {
  const raw = rawEntryRole(item);
  const kind = historyEntryKind(item);
  const value = String(text || "").trim();
  if (kind === "turn") {
    return (
      raw === "developer" ||
      raw === "system" ||
      isContextScaffoldText(value) ||
      /^<(model_switch|environment_context|permissions instructions|plugins_instructions|skills_instructions|collaboration_mode)>/i.test(value)
    );
  }
  return (
    item.type === "session_meta" ||
    item.type === "turn_context" ||
    INTERNAL_HISTORY_KINDS.has(kind) ||
    raw === "developer" ||
    raw === "system" ||
    isContextScaffoldText(value) ||
    isSyntheticHistoryText(value) ||
    /^<(model_switch|environment_context|permissions instructions|plugins_instructions|skills_instructions|collaboration_mode)>/i.test(value)
  );
}

const INTERNAL_HISTORY_KINDS = new Set([
  "attachment",
  "compacted",
  "context_compacted",
  "custom_tool_call",
  "custom_tool_call_output",
  "function_call",
  "function_call_output",
  "mcp_tool_call_end",
  "patch_apply_end",
  "permission-mode",
  "reasoning",
  "session",
  "session_meta",
  "summary",
  "token_count",
  "tool_result",
  "tool_use",
  "turn_context"
]);

function isContextScaffoldText(text) {
  const value = String(text || "").trim();
  return (
    /^Session started\b/i.test(value) ||
    /<(environment_context|permissions instructions|plugins_instructions|skills_instructions|collaboration_mode)>/i.test(value)
  );
}

function isSyntheticHistoryText(text) {
  const value = String(text || "").trim();
  return (
    /^AGENT\s+(assistant|reasoning|user|system)\s*:/i.test(value) ||
    /^reasoning:\s*(assistant|user|system)\s*:/i.test(value) ||
    /\breasoning:\s*(assistant|user|system)\s*:/i.test(value) ||
    /^summary:\s*(assistant|user|system)\s*:/i.test(value) ||
    /^conversation summary\b/i.test(value)
  );
}

function messagesFromHistoryEntries(entries = [], limit = 120) {
  const messages = [];
  const recentMessages = [];

  for (const item of entries) {
    const text = String(extractEntryText(item) || "").trim();
    if (!text || isHistoryNoise(item, text)) continue;

    const message = { role: entryRole(item), text };
    const normalizedText = normalizeMessageText(text);
    const duplicated = recentMessages.some((recent) => {
      if (recent.role !== message.role) return false;
      if (recent.text === normalizedText) return true;
      const shorter = Math.min(recent.text.length, normalizedText.length);
      return shorter > 60 && (recent.text.includes(normalizedText) || normalizedText.includes(recent.text));
    });
    if (duplicated) continue;

    messages.push(message);
    recentMessages.push({ role: message.role, text: normalizedText });
    if (recentMessages.length > 8) recentMessages.shift();
  }

  return normalizeDisplayMessages(messages.slice(-limit));
}

function messagesFromTranscript(transcript = [], limit = 180) {
  const messages = transcript
    .map((item) => ({
      role: item.role === "user" || item.role === "assistant" || item.role === "error" ? item.role : "system",
      text: item.text || "",
      typing: item.role === "assistant" && !INTERNAL_HISTORY_KINDS.has(historyEntryKind(item)),
      durationMs: item.durationMs || null,
      completedAt: item.completedAt || "",
      startedAt: item.startedAt || "",
      turnId: item.turnId || "",
      commandCount: item.commandCount || item.commands?.length || 0,
      commands: Array.isArray(item.commands) ? item.commands : [],
      parts: Array.isArray(item.parts) ? item.parts : [],
      source: item
    }))
    .filter((message) => message.text && !isHistoryNoise(message.source, message.text))
    .map(({ source, ...message }) => message);

  return normalizeDisplayMessages(messages).slice(-limit);
}

function messagesFromDesktopVisibleTranscript(transcript = [], limit = 40) {
  return normalizeDisplayMessages(
    transcript
      .slice(-limit)
      .map((item) => ({
        role: item.role === "user" || item.role === "assistant" || item.role === "error" ? item.role : "system",
        text: item.text || "",
        typing: item.role === "assistant"
      }))
      .filter((item) => item.text)
  );
}

function threadKeyFor(provider, sessionId) {
  return `history:${provider}:${sessionId}`;
}

function applyThreadMeta(item, threadState) {
  const meta = threadState?.items?.[item.key] || {};
  return {
    ...item,
    title: meta.title || item.title,
    group: meta.group || item.group || "",
    pinned: Boolean(meta.pinned),
    archived: Boolean(meta.archived),
    threadMeta: meta
  };
}

function sortManagedConversations(items) {
  return [...items].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const groupCompare = String(a.group || "").localeCompare(String(b.group || ""), "zh-CN");
    if (groupCompare) return groupCompare;
    return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
  });
}

function projectNameFromPath(value) {
  const clean = String(value || "").replace(/[\\/]+$/, "");
  if (!clean) return "No project";
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean;
}

function projectKeyFromPath(value) {
  const clean = String(value || "").trim();
  return clean ? `project:${clean.toLowerCase()}` : "project:none";
}

function splitDesktopConversationName(value) {
  const text = compact(value, "");
  const match = text.match(/^(.*?)(刚刚|\d+\s*(?:秒|分钟|分|小时|天|周|个月|月|年))$/);
  if (match?.[1]?.trim()) {
    return {
      title: match[1].trim(),
      relativeTime: match[2].trim()
    };
  }
  return { title: text, relativeTime: "" };
}

function normalizeConversationMatchText(value) {
  return splitDesktopConversationName(value)
    .title.normalize("NFKC")
    .replace(/[\s"'`“”‘’。，、,.!?！？:：;；()[\]{}<>《》【】\-_/\\…]+/g, "")
    .toLowerCase();
}

function desktopProjectMatchScore(desktopItem, candidate) {
  const desktopProject = normalizeConversationMatchText(desktopItem.projectTitle || desktopItem.cwd || "");
  if (!desktopProject || desktopProject === "noproject") return 0;

  const candidateProject = normalizeConversationMatchText(projectNameFromPath(candidate.cwd || ""));
  const candidatePath = normalizeConversationMatchText(candidate.cwd || "");
  if (candidateProject === desktopProject || candidatePath.includes(desktopProject)) return 24;
  return 0;
}

function desktopConversationMatchScore(desktopItem, candidate) {
  const desktopTitle = normalizeConversationMatchText(desktopItem.title || desktopItem.rawName);
  const candidateTitle = normalizeConversationMatchText(candidate.title);
  if (!desktopTitle || !candidateTitle) return 0;

  let score = 0;
  if (desktopTitle === candidateTitle) {
    score = 100;
  } else if (desktopTitle.length >= 6 && candidateTitle.includes(desktopTitle)) {
    score = 78;
  } else if (candidateTitle.length >= 6 && desktopTitle.includes(candidateTitle)) {
    score = 78;
  } else {
    return 0;
  }

  score += desktopProjectMatchScore(desktopItem, candidate);
  if (candidate.kind === "task") score += 2;
  return score;
}

function findDesktopConversationSource(desktopItem, candidates) {
  let best = null;
  let bestScore = 0;
  let bestTime = 0;

  for (const candidate of candidates) {
    if (candidate.provider !== "codex") continue;
    const score = desktopConversationMatchScore(desktopItem, candidate);
    const time = new Date(candidate.updatedAt || 0).getTime();
    if (score > bestScore || (score === bestScore && time > bestTime)) {
      best = candidate;
      bestScore = score;
      bestTime = time;
    }
  }

  return bestScore >= 78 ? best : null;
}

function conversationSourceSnapshot(source) {
  if (!source) return null;
  return {
    key: source.key,
    kind: source.kind,
    id: source.id,
    provider: source.provider,
    title: source.title,
    cwd: source.cwd || "",
    status: source.status || "",
    updatedAt: source.updatedAt || "",
    sessionId: source.sessionId || "",
    historyId: source.historyId || "",
    sourceId: source.sourceId || "",
    preview: source.preview || ""
  };
}

function buildConversationTree(items, expandedProjects) {
  const projects = new Map();
  const noProject = [];

  for (const item of items) {
    if (!item.cwd || item.kind === "fork") {
      noProject.push(item);
      continue;
    }

    const key = projectKeyFromPath(item.cwd);
    const existing = projects.get(key) || {
      key,
      kind: "project",
      provider: item.provider,
      title: projectNameFromPath(item.cwd),
      cwd: item.cwd,
      updatedAt: item.updatedAt,
      count: 0,
      children: []
    };
    existing.count += 1;
    existing.updatedAt = latestDate(existing.updatedAt, item.updatedAt);
    existing.children.push(item);
    projects.set(key, existing);
  }

  const nodes = [];
  for (const project of [...projects.values()].sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())) {
    const expanded = expandedProjects[project.key] ?? true;
    nodes.push({ ...project, expanded });
    if (expanded) nodes.push(...project.children.map((child) => ({ ...child, parentProjectKey: project.key, nested: true })));
  }

  if (noProject.length) {
    const key = "project:none";
    const expanded = expandedProjects[key] ?? true;
    nodes.push({
      key,
      kind: "project",
      provider: "codex",
      title: "No project",
      cwd: "",
      updatedAt: latestDate(...noProject.map((item) => item.updatedAt)),
      count: noProject.length,
      expanded,
      children: noProject
    });
    if (expanded) nodes.push(...noProject.map((child) => ({ ...child, parentProjectKey: key, nested: true })));
  }

  return nodes;
}

function filterConversationNodes(nodes, query) {
  const value = query.trim().toLowerCase();
  if (!value) return nodes;

  const visibleProjects = new Set();
  const matched = nodes.filter((item) => {
    const text = `${item.title} ${item.provider} ${item.cwd} ${item.sessionId}`.toLowerCase();
    if (item.kind !== "project" && text.includes(value)) {
      if (item.parentProjectKey) visibleProjects.add(item.parentProjectKey);
      return true;
    }
    return item.kind === "project" && text.includes(value);
  });

  return nodes.filter((item) => {
    if (matched.includes(item)) return true;
    return item.kind === "project" && visibleProjects.has(item.key);
  });
}

function normalizeMessageText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function messageIdentity(message) {
  if (message?.turnId) return `${message.role}\nturn:${message.turnId}`;
  return `${message.role}\n${normalizeMessageText(message.text)}`;
}

function mergeHistoryAndTaskMessages(historyMessages, taskMessages) {
  if (!historyMessages.length) return normalizeDisplayMessages(taskMessages);
  const seen = new Set(historyMessages.map(messageIdentity));
  const historyText = historyMessages.map((message) => message.text).join("\n");
  const taskOnly = taskMessages.filter((message) => {
    const text = String(message.text || "").trim();
    if (!text || seen.has(messageIdentity(message))) return false;
    if ((message.role === "user" || message.role === "assistant") && historyText.includes(text)) return false;
    return true;
  });
  return normalizeDisplayMessages([...historyMessages, ...taskOnly]);
}

function isSystemMessage(message) {
  return message?.role === "system" || message?.role === "log";
}

function mergeSystemText(previousText, nextText) {
  const current = String(previousText || "").trimEnd();
  const incoming = String(nextText || "").trim();
  if (!incoming) return current;
  if (!current) return incoming;
  return `${current}\n\n${incoming}`;
}

function normalizeDisplayMessages(items = []) {
  const normalized = [];
  const recentMessages = [];

  for (const item of items) {
    if (!item?.text || item.role === "debug") continue;

    const identity = messageIdentity(item);
    const normalizedText = normalizeMessageText(item.text);
    const duplicated = recentMessages.some((recent) => {
      if (recent.role !== item.role) return false;
      if (recent.identity === identity) return true;
      if (recent.turnId || item.turnId) return false;
      const shorter = Math.min(recent.text.length, normalizedText.length);
      return shorter > 80 && (recent.text.includes(normalizedText) || normalizedText.includes(recent.text));
    });
    if (duplicated) continue;

    const previous = normalized[normalized.length - 1];
    if (isSystemMessage(previous) && isSystemMessage(item)) {
      previous.role = previous.role === "error" || item.role === "error" ? "error" : "system";
      previous.text = mergeSystemText(previous.text, item.text);
      previous.typing = false;
      continue;
    }

    normalized.push({ ...item });
    recentMessages.push({ role: item.role, identity, text: normalizedText, turnId: item.turnId || "" });
    if (recentMessages.length > 8) recentMessages.shift();
  }

  return normalized;
}

function appendDisplayMessages(current, incoming) {
  return normalizeDisplayMessages([...current, ...incoming]);
}

function hasAssistantAfterLastUser(items) {
  const lastUserIndex = items.reduce((last, item, index) => (item.role === "user" ? index : last), -1);
  return items.slice(Math.max(lastUserIndex + 1, 0)).some((item) => item.role === "assistant" || item.role === "error");
}

function messagesForRender(items, running) {
  const normalized = normalizeDisplayMessages(items);
  const withPending = !running || hasAssistantAfterLastUser(normalized) ? normalized : [...normalized, { role: "assistant", text: "Thinking", pending: true }];
  return withPending.filter(shouldRenderMessage);
}

function shouldRenderMessage(message) {
  if (!message?.text || message.role === "debug") return false;
  if (message.role !== "system" && message.role !== "log") return true;
  return /(\bERROR\b|\berror\b|failed|failure|unauthorized|forbidden|spawn|ENOENT|EPERM|EACCES|permission|not found|refused|timed out|failed to|错误|失败|未找到|拒绝|超时|无权限)/i.test(
    message.text
  );
}

function sessionKey(provider, sessionId) {
  return `${provider}:${sessionId}`;
}

function latestDate(...values) {
  let bestValue = "";
  let bestTime = -Infinity;
  for (const value of values) {
    const time = new Date(value || 0).getTime();
    if (!Number.isNaN(time) && time > bestTime) {
      bestTime = time;
      bestValue = value;
    }
  }
  return bestValue || values.find(Boolean) || "";
}

function statusFromExitEvent(event) {
  if (event.type !== "system") return "";
  const text = event.text || "";
  if (/Exited with code 0/i.test(text)) return "done";
  if (/Exited with code/i.test(text)) return "failed";
  return "";
}

function isImagePath(value) {
  return /\.(?:png|jpe?g|gif|webp|avif)(?:[?#].*)?$/i.test(stripPathWrappers(value));
}

function stripPathWrappers(value) {
  return String(value || "").trim().replace(/^<|>$/g, "");
}

function localFileUrl(value, token = localStorage.getItem("mat.token") || savedToken) {
  const raw = stripPathWrappers(value);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\/api\/attachments\//i.test(raw)) {
    const joiner = raw.includes("?") ? "&" : "?";
    return `${raw}${joiner}token=${encodeURIComponent(token)}`;
  }
  if (/^file:\/\//i.test(raw)) return `/api/files?path=${encodeURIComponent(raw.replace(/^file:\/+/i, ""))}&token=${encodeURIComponent(token)}`;
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(raw)) return `/api/files?path=${encodeURIComponent(raw)}&token=${encodeURIComponent(token)}`;
  return raw;
}

function parseMessageParts(text) {
  const value = String(text || "");
  const parts = [];
  const pattern = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) pushTextParts(parts, value.slice(lastIndex, match.index));

    const isImage = match[0].startsWith("!");
    const label = isImage ? match[1] : match[3];
    const href = isImage ? match[2] : match[4];
    parts.push(isImage ? { type: "image", alt: label || "image", src: href } : { type: "link", text: label, href });

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < value.length) pushTextParts(parts, value.slice(lastIndex));
  return parts.length ? parts : [{ type: "text", text: value }];
}

function pushTextParts(parts, text) {
  const pattern = /(^|[\s:])((?:[A-Za-z]:[\\/]|\/)[^\r\n<>]*?\.(?:png|jpe?g|gif|webp|avif))/gi;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text))) {
    const prefix = match[1] || "";
    const pathText = match[2] || "";
    const textEnd = match.index + prefix.length;
    if (textEnd > lastIndex) parts.push({ type: "text", text: text.slice(lastIndex, textEnd) });
    parts.push({ type: "image", alt: pathText.split(/[\\/]/).pop() || "image", src: pathText });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) parts.push({ type: "text", text: text.slice(lastIndex) });
}

function MessageContent({ text, typing, token }) {
  const parts = parseMessageParts(text);
  const hasMedia = parts.some((part) => part.type !== "text");

  if (!hasMedia) return <TypingText text={text} active={Boolean(typing)} />;

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "image") {
          const src = localFileUrl(part.src, token);
          return (
            <a className="message-image-link" href={src} target="_blank" rel="noreferrer" key={`${index}-image`}>
              <img className="message-image" src={src} alt={part.alt} loading="lazy" />
            </a>
          );
        }

        if (part.type === "link") {
          const href = localFileUrl(part.href, token);
          return (
            <a className="message-link" href={href} target="_blank" rel="noreferrer" key={`${index}-link`}>
              {part.text}
            </a>
          );
        }

        return <React.Fragment key={`${index}-text`}>{part.text}</React.Fragment>;
      })}
    </>
  );
}

function TypingText({ text, active }) {
  const [shown, setShown] = useState(active ? "" : text);

  useEffect(() => {
    if (!active) {
      setShown(text);
      return undefined;
    }

    let index = 0;
    setShown("");
    const chars = [...String(text)];
    const timer = setInterval(() => {
      index += Math.max(1, Math.floor(chars.length / 180));
      setShown(chars.slice(0, index).join(""));
      if (index >= chars.length) clearInterval(timer);
    }, 12);
    return () => clearInterval(timer);
  }, [text, active]);

  return <span className={active && shown.length < text.length ? "typing-caret" : ""}>{shown}</span>;
}

function ThinkingIndicator({ text = "Thinking" }) {
  return (
    <span className="thinking-indicator">
      <span className="thinking-spinner" aria-hidden="true" />
      <span>{text}</span>
      <span className="thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}

function commandStatusLabel(status) {
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "done";
}

function CommandSummary({ commands = [] }) {
  const [expanded, setExpanded] = useState(false);
  const visibleCommands = commands.filter((item) => item?.command);
  if (!visibleCommands.length) return null;

  return (
    <div className="command-summary">
      <button className="command-toggle" type="button" onClick={() => setExpanded((value) => !value)}>
        <Terminal className="command-icon" size={16} aria-hidden="true" />
        <span>已运行 {visibleCommands.length} 条命令</span>
        <ChevronRight className={cx("turn-chevron", expanded && "open")} size={16} aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="command-list">
          {visibleCommands.map((command, index) => (
            <section className="command-item" key={`${command.id || command.command}-${index}`}>
              <div className="command-item-head">
                <strong>{command.name || "command"}</strong>
                <span className={cx("command-status", command.status)}>{commandStatusLabel(command.status)}</span>
              </div>
              {command.workdir ? <div className="command-workdir">{command.workdir}</div> : null}
              <pre className="command-code">{command.command}</pre>
              {command.output ? <pre className="command-output">{command.output}</pre> : null}
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Message({ role, text, typing, pending, token, durationMs, commands = [] }) {
  if (!text || role === "debug") return null;
  const label = role === "user" ? "You" : role === "assistant" ? "Agent" : role === "error" ? "Error" : "System";
  const durationLabel = role === "assistant" ? formatDurationMs(durationMs) : "";
  return (
    <article className={cx("message", role === "assistant" ? "assistant" : role, pending && "pending")}>
      {durationLabel ? <div className="turn-meta">已处理 {durationLabel}⌄</div> : null}
      <div className="message-role">{label}</div>
      <div className="message-bubble">
        {pending ? <ThinkingIndicator text={text} /> : <MessageContent text={text} typing={typing} token={token} />}
      </div>
      {role === "assistant" ? <CommandSummary commands={commands} /> : null}
    </article>
  );
}

function ChangeCard({ summary }) {
  if (!summary) return null;
  const files = summary.files || [];
  const title = summary.kind === "workspace" ? "Workspace changes" : "Task changes";
  return (
    <section className="change-card">
      <div className="change-card-head">
        <div>
          <h3>{title}</h3>
          <p>{summary.workspace?.title || summary.workspace?.path || summary.cwd || ""}</p>
        </div>
        <span className={cx("change-pill", summary.ok ? "ready" : "waiting")}>{summary.ok ? "Ready" : "Unavailable"}</span>
      </div>
      <div className="change-metrics">
        <span>{summary.changedCount ?? summary.fileCount ?? files.length} files</span>
        <span>{summary.lineCount || 0} diff lines</span>
        {summary.branch ? <span>{summary.branch}</span> : null}
      </div>
      {files.length ? (
        <div className="change-files">
          {files.slice(0, 6).map((file, index) => (
            <div className="change-file" key={`${file.path || file.oldPath || index}-${index}`}>
              <span>{file.status || "M"}</span>
              <strong>{file.path || file.oldPath}</strong>
            </div>
          ))}
          {files.length > 6 ? <div className="change-more">{files.length - 6} more files</div> : null}
        </div>
      ) : (
        <div className="change-empty">{summary.stderr || "No workspace diff"}</div>
      )}
    </section>
  );
}

function LoginView({ onLogin, initialError = "" }) {
  const [pairingToken, setPairingToken] = useState("");
  const [openai, setOpenai] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [rememberKeys, setRememberKeys] = useState(false);
  const [error, setError] = useState(initialError);

  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      const result = await request(
        "/api/login",
        {
          method: "POST",
          auth: false,
          body: JSON.stringify({
            pairingToken,
            deviceLabel: navigator.userAgent || "Browser",
            rememberKeys,
            apiKeys: { openai, anthropic }
          })
        },
        ""
      );
      const nextToken = result.token || pairingToken;
      localStorage.setItem("mat.token", nextToken);
      onLogin(nextToken);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="login-screen">
      <div className="brand-lockup">
        <div className="brand-mark">VL</div>
        <div>
          <h1>VibeLink</h1>
          <p>Codex / Claude Code</p>
        </div>
      </div>
      <form className="panel" onSubmit={submit}>
        <label>
          <span>Pairing token</span>
          <input value={pairingToken} onChange={(event) => setPairingToken(event.target.value)} autoComplete="one-time-code" />
        </label>
        <label>
          <span>OpenAI API Key</span>
          <input value={openai} onChange={(event) => setOpenai(event.target.value)} type="password" autoComplete="off" />
        </label>
        <label>
          <span>Anthropic API Key</span>
          <input value={anthropic} onChange={(event) => setAnthropic(event.target.value)} type="password" autoComplete="off" />
        </label>
        <label className="check-row">
          <input checked={rememberKeys} onChange={(event) => setRememberKeys(event.target.checked)} type="checkbox" />
          <span>Remember keys</span>
        </label>
        <button className="primary-button" type="submit">
          Connect
        </button>
        <p className="form-error" role="alert">
          {error}
        </p>
      </form>
    </section>
  );
}

function Sidebar({ conversations, selected, query, setQuery, onSelect, onNew, onRefresh, networkLine, open, loading, onManage, showArchived, setShowArchived, onToggleProject }) {
  return (
    <aside id="sidebar" className={cx("sidebar", open && "open")}>
      <div className="sidebar-top">
        <div className="brand-row">
          <div className="brand-mark small">VL</div>
          <div>
            <h1>VibeLink</h1>
            <p>Connected</p>
          </div>
        </div>
        <button className="new-chat-button" type="button" onClick={onNew}>
          New chat
        </button>
        <div className="sidebar-tools">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" />
          <button className={cx("icon-button", showArchived && "active")} title={showArchived ? "Show active chats" : "Show archived"} aria-label={showArchived ? "Show active chats" : "Show archived"} type="button" onClick={() => setShowArchived(!showArchived)}>
            <Archive size={18} />
          </button>
          <button className="icon-button" title="Refresh" aria-label="Refresh" type="button" onClick={onRefresh}>
            <RefreshCw size={18} />
          </button>
        </div>
      </div>
      <div className="conversation-list">
        {loading ? (
          <div className="conversation-item">
            <h3>Syncing chats</h3>
            <div className="conversation-meta">Reading local tasks and history</div>
          </div>
        ) : conversations.length ? (
          conversations.map((item) =>
            item.kind === "project" ? (
              <button key={item.key} className="project-item" type="button" onClick={() => onToggleProject(item.key)}>
                <span className={cx("project-chevron", item.expanded && "open")}>{">"}</span>
                <FolderOpen size={17} />
                <span className="project-title">{item.title}</span>
                <span className="project-count">{item.count}</span>
              </button>
            ) : (
            <button
              key={item.key}
              className={cx("conversation-item", item.nested && "nested", item.key === selected?.key && "active")}
              type="button"
              onClick={() => onSelect(item)}
            >
              <div className="conversation-title-row">
                <h3>{item.title}</h3>
                {item.kind !== "project" ? (
                  <span
                    className="conversation-more"
                    role="button"
                    tabIndex={0}
                    title="Manage chat"
                    onClick={(event) => {
                      event.stopPropagation();
                      onManage(item);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      onManage(item);
                    }}
                  >
                    <MoreHorizontal size={16} />
                  </span>
                ) : null}
              </div>
              <div className="conversation-meta">
                <span className={cx("badge", item.provider)}>{item.provider}</span>
                {item.status && item.status !== "history" && item.status !== "fork" ? <span className={cx("badge", item.status)}>{item.status}</span> : null}
                {item.pinned ? <span className="badge pinned">Pinned</span> : null}
                {item.group ? <span className="badge group">{item.group}</span> : null}
                <span>{item.displayTime || formatTime(item.updatedAt)}</span>
              </div>
            </button>
            )
          )
        ) : (
          <div className="conversation-item">
            <h3>No chats</h3>
            <div className="conversation-meta">Configured agents will appear here</div>
          </div>
        )}
      </div>
      <div className="sidebar-foot">{networkLine}</div>
    </aside>
  );
}

function Composer({
  providers,
  activeAgent,
  setActiveAgent,
  permissionMode,
  setPermissionMode,
  running,
  onSend,
  controlMode,
  setControlMode,
  desktopRemote,
  token,
  workspaces = [],
  activeModel,
  setActiveModel,
  reasoningEffort,
  setReasoningEffort,
  selected,
  runningTaskId,
  onRunningInput,
  onStop
}) {
  const [text, setText] = useState(() => localStorage.getItem("mat.composerDraft") || "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [workspaceTree, setWorkspaceTree] = useState({ workspaceId: "", dir: "", items: [], selected: {} });
  const [commandOpen, setCommandOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const textRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const isComposingRef = useRef(false);
  const isDesktop = controlMode === "desktop";
  const desktopBound = hasDesktopBinding(selected);
  const canSend = isDesktop || providers.length > 0;
  const uploading = attachments.some((item) => item.status === "uploading");
  const readyAttachments = attachments.filter((item) => item.status === "ready");
  const canSendWhileRunning = isDesktop || Boolean(runningTaskId);
  const canSubmit = canSend && (!running || canSendWhileRunning) && !uploading && (Boolean(text.trim()) || readyAttachments.length > 0);
  const canStop = running && !isDesktop && Boolean(runningTaskId);
  const placeholder = isDesktop ? "向 Codex Desktop 发送消息" : providers.length ? "向 Agent 发送消息" : "先在设置中添加 API key";
  const targetText = targetLabel({ isDesktop, selected, activeAgent });

  useEffect(() => {
    if (text.trim()) localStorage.setItem("mat.composerDraft", text);
    else localStorage.removeItem("mat.composerDraft");
  }, [text]);

  function submit(event) {
    event.preventDefault();
    const attachmentText = readyAttachments
      .map((item) => {
        if (item.kind === "workspace") return item.prompt || "";
        const fileUrl = item.url || item.path;
        const localPath = item.path && item.url ? `\nLocal file: ${item.path}` : "";
        const relativePath = item.relativePath ? `\nRelative path: ${item.relativePath}` : "";
        const preview = item.preview ? `\n\n<attachment_preview name="${item.name}">\n${item.preview.slice(0, 12000)}\n</attachment_preview>` : "";
        if (item.kind === "image") return `![${item.name}](${fileUrl})${localPath}${relativePath}${preview}`;
        return `[${item.name}](${fileUrl})${localPath}${relativePath}${preview}`;
      })
      .join("\n\n");
    const value = [text.trim(), attachmentText].filter(Boolean).join("\n\n");
    if (!value || !canSubmit) return;
    const shouldSendToRunningTask = running && runningTaskId && !isDesktop;
    const existingHistory = promptHistory();
    const nextHistory = [{ text: text.trim() || value.slice(0, 400), at: new Date().toISOString() }, ...existingHistory.filter((item) => item.text !== (text.trim() || value.slice(0, 400)))].slice(0, 30);
    localStorage.setItem("mat.promptHistory", JSON.stringify(nextHistory));
    attachments.forEach((item) => {
      if (item.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
    });
    setText("");
    localStorage.removeItem("mat.composerDraft");
    setAttachments([]);
    setUploadError("");
    setMenuOpen(false);
    setCommandOpen(false);
    setHistoryOpen(false);
    setWorkspacePickerOpen(false);
    setTargetMenuOpen(false);
    setModelMenuOpen(false);
    setPermissionMenuOpen(false);
    if (shouldSendToRunningTask) onRunningInput(runningTaskId, value);
    else onSend(value);
  }

  function updateText(value) {
    setText(value);
    requestAnimationFrame(() => {
      if (!textRef.current) return;
      textRef.current.style.height = "auto";
      textRef.current.style.height = `${Math.min(textRef.current.scrollHeight, 190)}px`;
    });
  }

  function togglePlan() {
    setPermissionMode(permissionMode === "plan" ? "default" : "plan");
    setMenuOpen(false);
    setTargetMenuOpen(false);
    setModelMenuOpen(false);
    setPermissionMenuOpen(false);
  }

  function filesFromTransfer(transfer, imagesOnly = false) {
    const allFiles = [...(transfer?.files || [])].filter((file) => !imagesOnly || file.type?.startsWith("image/"));
    if (allFiles.length) return allFiles;
    return [...(transfer?.items || [])]
      .filter((item) => item.kind === "file" && (!imagesOnly || item.type?.startsWith("image/")))
      .map((item) => item.getAsFile())
      .filter(Boolean);
  }

  async function uploadFiles(files, { imagesOnly = false } = {}) {
    const selectedFiles = files.filter((file) => !imagesOnly || file.type?.startsWith("image/"));
    if (!selectedFiles.length) return;
    setUploadError("");
    const pending = selectedFiles.map((file, index) => ({
      id: window.crypto?.randomUUID?.() || `${Date.now()}-${index}`,
      name: file.name || `image-${index + 1}.png`,
      kind: attachmentKind(file),
      previewUrl: file.type?.startsWith("image/") ? URL.createObjectURL(file) : "",
      status: "uploading",
      error: "",
      path: "",
      url: "",
      relativePath: file.webkitRelativePath || "",
      size: file.size || 0,
      mimeType: file.type || "application/octet-stream",
      file
    }));
    setAttachments((items) => [...items, ...pending]);

    await Promise.all(
      pending.map(async (item) => {
        try {
          const response = await fetch("/api/attachments", {
            method: "POST",
            headers: {
              "Content-Type": item.file.type || "application/octet-stream",
              "X-File-Name": encodeURIComponent(item.name),
              ...(item.relativePath ? { "X-Relative-Path": encodeURIComponent(item.relativePath) } : {}),
              ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            body: item.file
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
          setAttachments((items) => items.map((current) => (current.id === item.id ? { ...current, ...data, previewUrl: current.previewUrl, kind: data.kind || current.kind, status: "ready" } : current)));
        } catch (error) {
          setUploadError(error.message || "Upload failed.");
          setAttachments((items) => items.map((current) => (current.id === item.id ? { ...current, status: "failed", error: error.message || "Upload failed" } : current)));
        }
      })
    );
  }

  function handlePaste(event) {
    const files = filesFromTransfer(event.clipboardData, true);
    if (!files.length) return;
    event.preventDefault();
    uploadFiles(files, { imagesOnly: true }).catch((error) => setUploadError(error.message));
  }

  function handleDragOver(event) {
    const files = filesFromTransfer(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(event) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDragActive(false);
  }

  function handleDrop(event) {
    const files = filesFromTransfer(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    setDragActive(false);
    uploadFiles(files).catch((error) => setUploadError(error.message));
  }

  function openImagePicker() {
    setMenuOpen(false);
    setTargetMenuOpen(false);
    imageInputRef.current?.click();
  }

  function handleImageInputChange(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    uploadFiles(files, { imagesOnly: true }).catch((error) => setUploadError(error.message));
  }

  function openFilePicker() {
    setMenuOpen(false);
    setTargetMenuOpen(false);
    fileInputRef.current?.click();
  }

  function openFolderPicker() {
    setMenuOpen(false);
    setTargetMenuOpen(false);
    folderInputRef.current?.click();
  }

  function handleFileInputChange(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    uploadFiles(files).catch((error) => setUploadError(error.message));
  }

  function handleFolderInputChange(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    uploadFiles(files).catch((error) => setUploadError(error.message));
  }

  async function openWorkspacePicker() {
    setMenuOpen(false);
    setTargetMenuOpen(false);
    const workspace = workspaces[0];
    if (!workspace) {
      setUploadError("No workspace is available. Add an allowed root in Settings first.");
      return;
    }
    setWorkspacePickerOpen(true);
    await loadWorkspaceTree(workspace.id, "");
  }

  async function loadWorkspaceTree(workspaceId, dir = "") {
    const result = await request(`/api/workspaces/${workspaceId}/tree?dir=${encodeURIComponent(dir || "")}`, {}, token);
    setWorkspaceTree((current) => ({
      workspaceId,
      dir: result.dir || "",
      items: result.items || [],
      selected: current.workspaceId === workspaceId ? current.selected || {} : {}
    }));
  }

  function toggleWorkspacePath(item) {
    setWorkspaceTree((current) => {
      const selected = { ...(current.selected || {}) };
      if (selected[item.path]) delete selected[item.path];
      else selected[item.path] = item;
      return { ...current, selected };
    });
  }

  async function attachWorkspaceContext() {
    const paths = Object.keys(workspaceTree.selected || {});
    if (!workspaceTree.workspaceId || !paths.length) return;
    const result = await request(
      `/api/workspaces/${workspaceTree.workspaceId}/context`,
      {
        method: "POST",
        body: JSON.stringify({ paths })
      },
      token
    );
    const workspace = workspaces.find((item) => item.id === workspaceTree.workspaceId);
    setAttachments((items) => [
      ...items,
      {
        id: window.crypto?.randomUUID?.() || `workspace-${Date.now()}`,
        kind: "workspace",
        name: `${workspace?.title || "workspace"} context`,
        status: "ready",
        size: result.prompt?.length || 0,
        prompt: result.prompt || "",
        paths,
        error: result.errors?.map((item) => `${item.path}: ${item.error}`).join("; ") || ""
      }
    ]);
    setWorkspacePickerOpen(false);
  }

  function promptHistory() {
    try {
      return JSON.parse(localStorage.getItem("mat.promptHistory") || "[]");
    } catch {
      return [];
    }
  }

  function applyPromptHistory(value) {
    updateText(value);
    setHistoryOpen(false);
    textRef.current?.focus();
  }

  function setCommandText(nextText) {
    updateText(nextText);
    setCommandOpen(false);
    requestAnimationFrame(() => textRef.current?.focus());
  }

  function applySlashCommand(command) {
    const normalized = command.trim();
    if (normalized === "/image") return openImagePicker();
    if (normalized === "/file") return openFilePicker();
    if (normalized === "/folder") return openFolderPicker();
    if (normalized === "/workspace") return openWorkspacePicker().catch((error) => setUploadError(error.message));
    if (normalized === "/history") {
      setHistoryOpen(true);
      setCommandOpen(false);
      return undefined;
    }
    if (normalized === "/clear") {
      setCommandText("");
      return undefined;
    }
    if (normalized.startsWith("/agent ")) {
      const provider = normalized.split(/\s+/)[1];
      if (providers.includes(provider)) setActiveAgent(provider);
      setCommandText("");
      return undefined;
    }
    if (normalized.startsWith("/permissions ")) {
      setPermissionMode(normalized.split(/\s+/)[1] || "default");
      setCommandText("");
      return undefined;
    }
    if (normalized.startsWith("/model ")) {
      setActiveModel(normalized.replace(/^\/model\s+/, "").trim());
      setCommandText("");
      return undefined;
    }
    if (normalized.startsWith("/effort ")) {
      setReasoningEffort(normalized.split(/\s+/)[1] || "medium");
      setCommandText("");
      return undefined;
    }
    setCommandText(`${normalized} `);
    return undefined;
  }

  const slashCommands = [
    { command: "/image", title: "Attach image", detail: "Select or paste an image", icon: ImageIcon },
    { command: "/file", title: "Attach file", detail: "Upload PDF, text, data, or code", icon: FileText },
    { command: "/folder", title: "Attach folder", detail: "Upload files from a local folder", icon: Folder },
    { command: "/workspace", title: "Workspace context", detail: "Pick files from this computer", icon: FolderOpen },
    { command: "/permissions bypassPermissions", title: "Full access", detail: "Switch permission mode", icon: CheckSquare },
    { command: "/model gpt-5.5", title: "Model", detail: "Set Codex/Claude model", icon: SlidersHorizontal },
    { command: "/effort high", title: "Reasoning effort", detail: "Set low, medium, high, xhigh, max", icon: Target },
    { command: "/agent codex", title: "Agent", detail: "Switch provider", icon: Monitor },
    { command: "/history", title: "Prompt history", detail: "Reuse a previous prompt", icon: History },
    { command: "/clear", title: "Clear input", detail: "Remove current draft", icon: X }
  ].filter((item) => item.command.includes(text.trim()) || item.title.toLowerCase().includes(text.trim().replace(/^\//, "").toLowerCase()));

  function removeAttachment(id) {
    setAttachments((items) => {
      const target = items.find((item) => item.id === id);
      if (target?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(target.previewUrl);
      return items.filter((item) => item.id !== id);
    });
  }

  function attachmentPreviewUrl(item) {
    if (item.previewUrl) return item.previewUrl;
    return item.url ? `${item.url}?token=${encodeURIComponent(token || "")}` : "";
  }

  return (
    <form
      className={cx("composer-shell", dragActive && "drag-over")}
      onSubmit={submit}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={imageInputRef}
        className="hidden-file-input"
        type="file"
        accept="image/*"
        multiple
        onChange={handleImageInputChange}
        tabIndex={-1}
      />
      <input
        ref={fileInputRef}
        className="hidden-file-input"
        type="file"
        multiple
        onChange={handleFileInputChange}
        tabIndex={-1}
      />
      <input
        ref={folderInputRef}
        className="hidden-file-input"
        type="file"
        multiple
        webkitdirectory=""
        directory=""
        onChange={handleFolderInputChange}
        tabIndex={-1}
      />
      {attachments.length ? (
        <div className="attachment-strip">
          {attachments.map((item) => (
            <div className={cx("attachment-chip", item.status)} key={item.id}>
              {attachmentPreviewUrl(item) ? (
                <img src={attachmentPreviewUrl(item)} alt={item.name} />
              ) : (
                <div className={cx("attachment-thumb-placeholder", item.kind)}>
                  {item.kind === "workspace" ? <FolderOpen size={18} /> : item.relativePath ? <Folder size={18} /> : <FileText size={18} />}
                </div>
              )}
              <span>{item.name}</span>
              <small>{item.status === "uploading" ? "uploading" : item.status === "failed" ? item.error : item.relativePath || formatBytes(item.size) || "ready"}</small>
              <button type="button" aria-label="Remove image" onClick={() => removeAttachment(item.id)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {uploadError ? <div className="attachment-error">{uploadError}</div> : null}
      <div className="composer-input-row">
        <button
          className="round-button"
          title="添加"
          aria-label="添加"
          type="button"
          onClick={() => {
            setMenuOpen((value) => !value);
            setTargetMenuOpen(false);
            setModelMenuOpen(false);
            setPermissionMenuOpen(false);
            setCommandOpen(false);
            setHistoryOpen(false);
            setWorkspacePickerOpen(false);
          }}
        >
          <Plus size={22} />
        </button>
        <textarea
          ref={textRef}
          value={text}
          onChange={(event) => {
            updateText(event.target.value);
            setCommandOpen(event.target.value.trim().startsWith("/"));
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" && !text.trim()) {
              event.preventDefault();
              setHistoryOpen(true);
            }
            if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
              if (event.nativeEvent?.isComposing || isComposingRef.current) return;
              event.preventDefault();
              if (canSubmit) event.currentTarget.form?.requestSubmit();
            }
            if (event.key === "Escape") {
              setCommandOpen(false);
              setHistoryOpen(false);
              setWorkspacePickerOpen(false);
              setTargetMenuOpen(false);
              setModelMenuOpen(false);
              setPermissionMenuOpen(false);
            }
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          onPaste={handlePaste}
          rows={1}
          placeholder={placeholder}
          disabled={!canSend || (running && !canSendWhileRunning)}
        />
        {canStop ? (
          <button className="send-button stop-button" title="停止" aria-label="停止" type="button" onClick={() => onStop?.(runningTaskId)}>
            <Square size={16} fill="currentColor" />
          </button>
        ) : (
          <button className="send-button" title="发送" aria-label="发送" type="submit" disabled={!canSubmit}>
            <ArrowUp size={22} />
          </button>
        )}
      </div>
      <div className="composer-toolbar">
        <div className="toolbar-left">
          <button
            className="chip-button mode-chip target-chip"
            type="button"
            aria-pressed={targetMenuOpen}
            title={desktopBound ? "当前会话已绑定 Codex Desktop，会直接遥控发送" : "选择发送目标"}
            onClick={() => {
              setTargetMenuOpen((value) => !value);
              setMenuOpen(false);
              setCommandOpen(false);
              setHistoryOpen(false);
              setWorkspacePickerOpen(false);
              setModelMenuOpen(false);
              setPermissionMenuOpen(false);
            }}
          >
            {isDesktop ? <Monitor size={14} /> : <Terminal size={14} />}
            {targetText}
          </button>
          {isDesktop ? (
            <span className={cx("remote-pill", desktopRemote?.desktop?.ready ? "ready" : "waiting")}>
              {desktopPillLabel(desktopRemote?.desktop)}
            </span>
          ) : (
            <>
              <button
                className="chip-button mode-chip"
                type="button"
                aria-pressed={modelMenuOpen}
                onClick={() => {
                  setModelMenuOpen((value) => !value);
                  setPermissionMenuOpen(false);
                  setTargetMenuOpen(false);
                  setMenuOpen(false);
                  setCommandOpen(false);
                  setHistoryOpen(false);
                  setWorkspacePickerOpen(false);
                }}
              >
                <SlidersHorizontal size={14} />
                {activeModel || "默认模型"} · {effortLabel(reasoningEffort)}
              </button>
              <button
                className="chip-button mode-chip"
                type="button"
                aria-pressed={permissionMenuOpen || permissionMode === "plan"}
                onClick={() => {
                  setPermissionMenuOpen((value) => !value);
                  setModelMenuOpen(false);
                  setTargetMenuOpen(false);
                  setMenuOpen(false);
                  setCommandOpen(false);
                  setHistoryOpen(false);
                  setWorkspacePickerOpen(false);
                }}
              >
                <CheckSquare size={14} />
                {permissionLabel(permissionMode)}
              </button>
            </>
          )}
        </div>
        <div className={cx("run-state", (running || desktopRemote?.active) && "running")}>
          {isDesktop ? desktopQueueLabel(desktopRemote) : running ? "运行中" : targetText}
        </div>
      </div>
      {targetMenuOpen ? (
        <div className="composer-popover target-menu">
          <button
            className="add-menu-item"
            type="button"
            disabled={desktopBound}
            onClick={() => {
              setControlMode("agent");
              setTargetMenuOpen(false);
            }}
          >
            <span className="menu-icon">
              <Terminal size={17} />
            </span>
            <span>
              <strong>发送到 Agent</strong>
              <small>{desktopBound ? "当前会话已绑定 Codex Desktop" : "使用本机 CLI 执行或续跑"}</small>
            </span>
          </button>
          <button
            className="add-menu-item"
            type="button"
            onClick={() => {
              setControlMode("desktop");
              setTargetMenuOpen(false);
            }}
          >
            <span className="menu-icon">
              <Monitor size={17} />
            </span>
            <span>
              <strong>遥控 Codex</strong>
              <small>把消息输入到当前 Codex Desktop 窗口</small>
            </span>
          </button>
        </div>
      ) : null}
      {modelMenuOpen ? (
        <div className="composer-popover composer-settings-menu">
          <label className="composer-field-row">
            <span>Agent</span>
            <select value={activeAgent} onChange={(event) => setActiveAgent(event.target.value)} disabled={providers.length <= 1}>
              {providers.map((provider) => (
                <option key={provider} value={provider}>
                  {providerLabel(provider)}
                </option>
              ))}
            </select>
          </label>
          <label className="composer-field-row">
            <span>模型</span>
            <select value={activeModel} onChange={(event) => setActiveModel(event.target.value)}>
              <option value="">默认模型</option>
              {activeAgent === "claude" ? (
                <>
                  <option value="opus">opus</option>
                  <option value="sonnet">sonnet</option>
                  <option value="fable">fable</option>
                </>
              ) : (
                <>
                  <option value="gpt-5.5">gpt-5.5</option>
                  <option value="gpt-5.5[1m]">gpt-5.5[1m]</option>
                  <option value="gpt-5.4">gpt-5.4</option>
                </>
              )}
            </select>
          </label>
          <label className="composer-field-row">
            <span>推理强度</span>
            <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>
              <option value="">默认</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="xhigh">超高</option>
              {activeAgent === "claude" ? <option value="max">最大</option> : null}
            </select>
          </label>
        </div>
      ) : null}
      {permissionMenuOpen ? (
        <div className="composer-popover permission-menu">
          {[
            ["default", "默认权限", "按当前项目配置执行"],
            ["acceptEdits", "自动接受编辑", "允许直接应用文件编辑"],
            ["auto", "自动模式", "尽量自动执行安全操作"],
            ["dontAsk", "无需确认", "减少交互确认"],
            ["plan", "计划模式", "先规划再执行"],
            ["bypassPermissions", "完全访问", "允许本机完全访问"]
          ].map(([value, title, detail]) => (
            <button
              className="add-menu-item"
              type="button"
              key={value}
              aria-pressed={permissionMode === value}
              onClick={() => {
                setPermissionMode(value);
                setPermissionMenuOpen(false);
              }}
            >
              <span className="menu-icon">
                <CheckSquare size={17} />
              </span>
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {menuOpen ? (
        <div className="add-menu">
          <div className="add-menu-section-title">添加</div>
          <button className="add-menu-item" type="button" onClick={openImagePicker}>
            <span className="menu-icon">
              <ImageIcon size={17} />
            </span>
            <span>
              <strong>图片</strong>
              <small>选择或粘贴图片</small>
            </span>
          </button>
          <button className="add-menu-item" type="button" onClick={openFilePicker}>
            <span className="menu-icon">
              <FileText size={17} />
            </span>
            <span>
              <strong>文件和文件夹</strong>
              <small>选择文件，或上传文件夹</small>
            </span>
          </button>
          <button className="add-menu-item" type="button" onClick={openFolderPicker}>
            <span className="menu-icon">
              <Folder size={17} />
            </span>
            <span>
              <strong>上传文件夹</strong>
              <small>保留相对路径</small>
            </span>
          </button>
          <button className="add-menu-item" type="button" onClick={() => openWorkspacePicker().catch((error) => setUploadError(error.message))}>
            <span className="menu-icon">
              <FolderOpen size={17} />
            </span>
            <span>
              <strong>当前 workspace</strong>
              <small>选择电脑项目文件</small>
            </span>
          </button>
          <div className="add-menu-section-title">工作模式</div>
          <button
            className="add-menu-item"
            type="button"
            onClick={() => {
              setTargetMenuOpen(true);
              setMenuOpen(false);
            }}
          >
            <span className="menu-icon">
              {isDesktop ? <Monitor size={17} /> : <Terminal size={17} />}
            </span>
            <span>
              <strong>目标</strong>
              <small>{targetText}</small>
            </span>
          </button>
          <button
            className="add-menu-item"
            type="button"
            onClick={() => {
              updateText(`${text.trim()}${text.trim() ? "\n" : ""}Goal: `);
              setMenuOpen(false);
              textRef.current?.focus();
            }}
          >
            <span className="menu-icon">
              <Target size={17} />
            </span>
            <span>
              <strong>目标说明</strong>
              <small>为本轮添加明确目标</small>
            </span>
          </button>
          <button className="add-menu-item" type="button" onClick={togglePlan}>
            <span className="menu-icon">
              <CheckSquare size={17} />
            </span>
            <span>
              <strong>计划模式</strong>
              <small>{permissionMode === "plan" ? "已开启" : "先规划再执行"}</small>
            </span>
          </button>
          <div className="add-menu-section-title">插件</div>
          <button className="add-menu-item" type="button" disabled>
            <span className="menu-icon">
              <FileText size={17} />
            </span>
            <span>
              <strong>Documents / PDF / Sheets</strong>
              <small>待接入</small>
            </span>
          </button>
        </div>
      ) : null}
      {commandOpen ? (
        <div className="composer-popover command-palette">
          {slashCommands.length ? (
            slashCommands.slice(0, 8).map((item) => {
              const Icon = item.icon;
              return (
                <button className="add-menu-item" type="button" key={item.command} onClick={() => applySlashCommand(item.command)}>
                  <span className="menu-icon">
                    <Icon size={17} />
                  </span>
                  <span>
                    <strong>{item.command}</strong>
                    <small>{item.detail}</small>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="popover-empty">No matching command</div>
          )}
        </div>
      ) : null}
      {historyOpen ? (
        <div className="composer-popover prompt-history">
          {promptHistory().length ? (
            promptHistory()
              .slice(0, 8)
              .map((item, index) => (
                <button className="history-item" type="button" key={`${item.at || ""}-${index}`} onClick={() => applyPromptHistory(item.text || "")}>
                  <strong>{compact(item.text, "Prompt").slice(0, 72)}</strong>
                  <small>{formatTime(item.at)}</small>
                </button>
              ))
          ) : (
            <div className="popover-empty">No prompt history yet</div>
          )}
        </div>
      ) : null}
      {workspacePickerOpen ? (
        <div className="composer-popover workspace-picker">
          <div className="workspace-picker-head">
            <select value={workspaceTree.workspaceId} onChange={(event) => loadWorkspaceTree(event.target.value, "").catch((error) => setUploadError(error.message))}>
              {workspaces.map((workspace) => (
                <option value={workspace.id} key={workspace.id}>
                  {workspace.title || workspace.path}
                </option>
              ))}
            </select>
            <button className="secondary-button" type="button" onClick={() => setWorkspacePickerOpen(false)}>
              Close
            </button>
          </div>
          {workspaceTree.dir ? (
            <button className="workspace-row" type="button" onClick={() => loadWorkspaceTree(workspaceTree.workspaceId, workspaceTree.dir.split("/").slice(0, -1).join("/")).catch((error) => setUploadError(error.message))}>
              ..
            </button>
          ) : null}
          <div className="workspace-tree">
            {workspaceTree.items.map((item) => (
              <div className="workspace-row" key={item.path}>
                <button type="button" onClick={() => item.type === "directory" ? loadWorkspaceTree(workspaceTree.workspaceId, item.path).catch((error) => setUploadError(error.message)) : toggleWorkspacePath(item)}>
                  {item.type === "directory" ? <Folder size={15} /> : <FileText size={15} />}
                  <span>{item.name}</span>
                </button>
                <label className="workspace-check">
                  <input type="checkbox" checked={Boolean(workspaceTree.selected?.[item.path])} onChange={() => toggleWorkspacePath(item)} />
                </label>
              </div>
            ))}
          </div>
          <button className="primary-button" type="button" disabled={!Object.keys(workspaceTree.selected || {}).length} onClick={attachWorkspaceContext}>
            Attach selected context
          </button>
        </div>
      ) : null}
    </form>
  );
}

function SettingsDrawer({ settings, token, onClose, onSaved, network }) {
  const [openai, setOpenai] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [defaultCwd, setDefaultCwd] = useState(settings?.defaultCwd || "");
  const [claudeCommand, setClaudeCommand] = useState(settings?.claudeCommand || "claude");
  const [codexCommand, setCodexCommand] = useState(settings?.codexCommand || "auto");
  const [codexTemplate, setCodexTemplate] = useState(settings?.codexTemplate || "");
  const [probeRunning, setProbeRunning] = useState(false);
  const [probeResult, setProbeResult] = useState(null);
  const [probeError, setProbeError] = useState("");
  const [desktopRunning, setDesktopRunning] = useState("");
  const [desktopResult, setDesktopResult] = useState(null);
  const [desktopError, setDesktopError] = useState("");

  useEffect(() => {
    setDefaultCwd(settings?.defaultCwd || "");
    setClaudeCommand(settings?.claudeCommand || "claude");
    setCodexCommand(settings?.codexCommand || "auto");
    setCodexTemplate(settings?.codexTemplate || "");
  }, [settings]);

  async function runAppServerProbe() {
    setProbeRunning(true);
    setProbeError("");
    setProbeResult(null);

    try {
      const result = await request(
        "/api/codex-app-server/probe",
        {
          method: "POST",
          body: JSON.stringify({})
        },
        token
      );
      setProbeResult(result);
    } catch (err) {
      setProbeError(err.message);
    } finally {
      setProbeRunning(false);
    }
  }

  async function runDesktopAction(action) {
    setDesktopRunning(action);
    setDesktopError("");
    setDesktopResult(null);

    const testPrompt = "DESKTOP_UI_CONTROL_SEND_OK";
    const route =
      action === "status"
        ? "/api/codex-desktop/status"
        : action === "draft"
          ? "/api/codex-desktop/draft-probe"
          : "/api/codex-desktop/send";

    try {
      const result = await request(
        route,
        {
          method: action === "status" ? "GET" : "POST",
          body: action === "send" ? JSON.stringify({ prompt: testPrompt }) : JSON.stringify({})
        },
        token
      );
      setDesktopResult(result);
    } catch (err) {
      setDesktopError(err.message);
    } finally {
      setDesktopRunning("");
    }
  }

  async function submit(event) {
    event.preventDefault();
    const apiKeys = {};
    if (openai.trim()) apiKeys.openai = openai.trim();
    if (anthropic.trim()) apiKeys.anthropic = anthropic.trim();
    await request(
      "/api/settings",
      {
        method: "POST",
        body: JSON.stringify({
          defaultCwd,
          claudeCommand,
          codexCommand,
          codexTemplate,
          apiKeys
        })
      },
      token
    );
    setOpenai("");
    setAnthropic("");
    onSaved();
  }

  return (
    <aside className="settings-drawer">
      <div className="drawer-header">
        <button className="icon-button" title="Back" aria-label="Back" type="button" onClick={onClose}>
          <ChevronLeft size={22} />
        </button>
        <div>
          <h2>Settings</h2>
          <p>Local bridge service</p>
        </div>
      </div>
      <form className="panel" onSubmit={submit}>
        <label>
          <span>OpenAI API Key</span>
          <input value={openai} onChange={(event) => setOpenai(event.target.value)} type="password" placeholder={settings?.hasOpenAIKey ? "Saved; leave blank to keep" : "Not set"} />
        </label>
        <label>
          <span>Anthropic API Key</span>
          <input value={anthropic} onChange={(event) => setAnthropic(event.target.value)} type="password" placeholder={settings?.hasAnthropicKey ? "Saved; leave blank to keep" : "Not set"} />
        </label>
        <label>
          <span>Default cwd</span>
          <input value={defaultCwd} onChange={(event) => setDefaultCwd(event.target.value)} />
        </label>
        <label>
          <span>Claude command</span>
          <input value={claudeCommand} onChange={(event) => setClaudeCommand(event.target.value)} />
        </label>
        <label>
          <span>Codex command</span>
          <input value={codexCommand} onChange={(event) => setCodexCommand(event.target.value)} />
        </label>
        <label>
          <span>Codex template</span>
          <input value={codexTemplate} onChange={(event) => setCodexTemplate(event.target.value)} />
        </label>
        <button className="primary-button" type="submit">
          Save
        </button>
      </form>
      <div className="network-list">
        <section className="probe-panel">
          <div>
            <h3>Codex app-server probe</h3>
            <p>Starts a temporary app-server probe and checks whether a resumed client receives live output.</p>
          </div>
          <button className="primary-button" type="button" onClick={runAppServerProbe} disabled={probeRunning}>
            {probeRunning ? "Testing..." : "Run probe"}
          </button>
          {probeError ? <p className="form-error">{probeError}</p> : null}
          {probeResult ? (
            <div className={cx("probe-result", probeResult.ok ? "ok" : "failed")}>
              <div className="probe-result-title">{probeResult.ok ? "Passed" : "Failed"}</div>
              <dl>
                <div>
                  <dt>Thread</dt>
                  <dd>{probeResult.threadId || "-"}</dd>
                </div>
                <div>
                  <dt>B saw turn started</dt>
                  <dd>{probeResult.bSawTurnStarted ? "yes" : "no"}</dd>
                </div>
                <div>
                  <dt>B saw agent delta</dt>
                  <dd>{probeResult.bSawAgentDelta ? "yes" : "no"}</dd>
                </div>
                <div>
                  <dt>B saw completed</dt>
                  <dd>{probeResult.bSawTurnCompleted ? "yes" : "no"}</dd>
                </div>
                <div>
                  <dt>Live text</dt>
                  <dd>{probeResult.secondTurnB?.textSample || "-"}</dd>
                </div>
              </dl>
            </div>
          ) : null}
        </section>
        <section className="probe-panel">
          <div>
            <h3>Codex Desktop UI control</h3>
            <p>Uses Windows UIA to locate the real Codex Desktop composer and send control messages.</p>
          </div>
          <div className="probe-actions">
            <button className="secondary-button" type="button" onClick={() => runDesktopAction("status")} disabled={Boolean(desktopRunning)}>
              {desktopRunning === "status" ? "Checking..." : "Check window"}
            </button>
            <button className="secondary-button" type="button" onClick={() => runDesktopAction("draft")} disabled={Boolean(desktopRunning)}>
              {desktopRunning === "draft" ? "Testing..." : "Draft probe"}
            </button>
            <button className="primary-button" type="button" onClick={() => runDesktopAction("send")} disabled={Boolean(desktopRunning)}>
              {desktopRunning === "send" ? "Sending..." : "Send test"}
            </button>
          </div>
          {desktopError ? <p className="form-error">{desktopError}</p> : null}
          {desktopResult ? (
            <div className={cx("probe-result", desktopResult.ok ? "ok" : "failed")}>
              <div className="probe-result-title">{desktopResult.ok ? "Passed" : "Failed"}</div>
              <dl>
                <div>
                  <dt>Action</dt>
                  <dd>{desktopResult.action || "-"}</dd>
                </div>
                <div>
                  <dt>Window</dt>
                  <dd>{desktopResult.target?.windowTitle || desktopResult.afterSend?.windowTitle || "-"}</dd>
                </div>
                <div>
                  <dt>Input</dt>
                  <dd>{desktopResult.target?.inputName || "-"}</dd>
                </div>
                <div>
                  <dt>Send enabled</dt>
                  <dd>{String(desktopResult.target?.sendEnabled ?? desktopResult.afterSend?.sendEnabled ?? "-")}</dd>
                </div>
                <div>
                  <dt>Text</dt>
                  <dd>{desktopResult.text || desktopResult.readBack || "-"}</dd>
                </div>
                <div>
                  <dt>Result</dt>
                  <dd>{desktopResult.error || desktopResult.sendMethod || desktopResult.clickPoint || "-"}</dd>
                </div>
              </dl>
            </div>
          ) : null}
        </section>
        {network.map((item) => (
          <div className="network-item" key={item.url}>
            <h3>{item.url}</h3>
            <p>
              {item.name} 路 {item.address}
            </p>
          </div>
        ))}
      </div>
    </aside>
  );
}

function App() {
  const [token, setToken] = useState(savedToken);
  const [settings, setSettings] = useState(null);
  const [network, setNetwork] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [histories, setHistories] = useState([]);
  const [threadState, setThreadState] = useState({ items: {}, forks: [] });
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState({});
  const [activeAgent, setActiveAgent] = useState("codex");
  const [controlMode, setControlMode] = useState("agent");
  const [desktopRemote, setDesktopRemote] = useState(null);
  const [changeSummary, setChangeSummary] = useState(null);
  const [permissionMode, setPermissionMode] = useState("default");
  const [activeModel, setActiveModel] = useState(localStorage.getItem("mat.activeModel") || "gpt-5.5");
  const [reasoningEffort, setReasoningEffort] = useState(localStorage.getItem("mat.reasoningEffort") || "xhigh");
  const [workspaces, setWorkspaces] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(Boolean(savedToken));
  const [error, setError] = useState("");
  const [loginError, setLoginError] = useState("");
  const eventSourceRef = useRef(null);
  const pollRef = useRef(null);
  const desktopPollRef = useRef(null);
  const desktopObserverRef = useRef(null);
  const desktopObserverCursorRef = useRef(0);
  const listRef = useRef(null);

  const providers = useMemo(() => {
    const items = [];
    if (settings?.hasOpenAIKey) items.push("codex");
    if (settings?.hasAnthropicKey) items.push("claude");
    return items;
  }, [settings]);

  const conversations = useMemo(() => {
    const providerSet = new Set(providers);
    const historyBySession = new Map(
      histories
        .filter((item) => providerSet.has(item.provider))
        .map((item) => [sessionKey(item.provider, item.id), item])
    );
    const taskGroups = new Map();

    for (const task of tasks) {
      if (!providerSet.has(task.agent)) continue;
      const key = task.sessionId ? `thread:${sessionKey(task.agent, task.sessionId)}` : `task:${task.id}`;
      const existing = taskGroups.get(key);
      const taskTime = new Date(task.updatedAt || 0).getTime();
      const existingTime = new Date(existing?.updatedAt || 0).getTime();
      if (!existing || taskTime >= existingTime) taskGroups.set(key, task);
    }

    const groupedTasks = [...taskGroups.values()];
    const taskSessionIds = new Set(groupedTasks.map((task) => (task.sessionId ? sessionKey(task.agent, task.sessionId) : "")).filter(Boolean));
    const taskItems = groupedTasks.map((task) => {
      const history = task.sessionId ? historyBySession.get(sessionKey(task.agent, task.sessionId)) : null;
      const historyTime = new Date(history?.updatedAt || 0).getTime();
      const taskTime = new Date(task.updatedAt || 0).getTime();
      const staleCompletedTask = history && task.status !== "running" && historyTime > taskTime;
      return {
        key: task.sessionId ? `thread:${task.agent}:${task.sessionId}` : `task:${task.id}`,
        kind: staleCompletedTask ? "history" : "task",
        id: task.id,
        provider: task.agent,
        title: compact(history?.title || task.title, `${providerLabel(task.agent)} task`),
        cwd: task.cwd || history?.projectPath || "",
        status: staleCompletedTask ? "history" : task.status,
        updatedAt: latestDate(task.updatedAt, history?.updatedAt),
        sessionId: task.sessionId || "",
        historyId: history?.id || "",
        sourceId: staleCompletedTask ? history.id : "",
        preview: history?.preview || ""
      };
    });
    const historyItems = histories
      .filter((item) => providerSet.has(item.provider))
      .filter((item) => !taskSessionIds.has(sessionKey(item.provider, item.id)))
      .map((item) => ({
        key: threadKeyFor(item.provider, item.id),
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
    const forkItems = (threadState.forks || [])
      .filter((item) => providerSet.has(item.provider))
      .map((item) => ({
        key: `fork:${item.id}`,
        kind: "fork",
        id: item.id,
        provider: item.provider,
        title: compact(item.title, "Forked thread"),
        cwd: item.cwd || "",
        status: "fork",
        updatedAt: item.updatedAt || item.createdAt,
        sessionId: item.sourceId || "",
        sourceKey: item.sourceKey,
        sourceId: item.sourceId,
        group: item.group || "",
        pinned: Boolean(item.pinned),
        archived: Boolean(item.archived),
        preview: ""
      }));
    const localContextItems = sortManagedConversations([...taskItems, ...historyItems].map((item) => applyThreadMeta(item, threadState)));
    const desktopMatches = new Map();
    for (const [index, item] of (desktopRemote?.desktop?.conversations || []).entries()) {
      const parsed = splitDesktopConversationName(item.title || item.rawName);
      const baseDesktopItem = {
        title: compact(parsed.title, "Codex Desktop chat"),
        rawName: item.rawName || item.title || "",
        projectTitle: item.projectTitle || ""
      };
      const sourceItem = findDesktopConversationSource(baseDesktopItem, localContextItems);
      if (sourceItem?.key) {
        desktopMatches.set(sourceItem.key, {
          desktopIndex: item.index ?? index,
          desktopProjectIndex: item.projectIndex,
          desktopTitle: baseDesktopItem.title,
          displayTime: parsed.relativeTime,
          desktopRunning: Boolean(item.running)
        });
      }
    }

    const localItems = sortManagedConversations(
      [...taskItems, ...historyItems, ...forkItems]
        .map((item) => applyThreadMeta(item, threadState))
        .map((item) => {
          const desktopMatch = desktopMatches.get(item.key);
          if (!desktopMatch) return item;
          return {
            ...item,
            status: desktopMatch.desktopRunning ? "running" : item.status,
            desktopIndex: desktopMatch.desktopIndex,
            desktopProjectIndex: desktopMatch.desktopProjectIndex,
            desktopTitle: desktopMatch.desktopTitle,
            desktopLinked: true,
            displayTime: desktopMatch.displayTime || item.displayTime
          };
        })
    ).filter((item) =>
      showArchived ? item.archived : !item.archived
    );
    const projectNodes = buildConversationTree(localItems, expandedProjects);
    return filterConversationNodes(projectNodes, query);
  }, [tasks, histories, providers, query, desktopRemote, threadState, showArchived, expandedProjects]);

  useEffect(() => {
    if (!selected || selected.kind === "desktop" || query.trim()) return;
    const latestSelected = conversations.find((item) => item.kind !== "project" && item.key === selected.key);
    if (latestSelected) {
      setSelected((current) => {
        if (current?.key !== latestSelected.key) return current;
        const fields = ["desktopIndex", "desktopProjectIndex", "desktopLinked", "desktopTitle", "displayTime", "status", "cwd", "title"];
        const synced = fields.every((field) => current[field] === latestSelected[field]);
        return synced ? current : { ...current, ...latestSelected };
      });
      if (hasDesktopBinding(latestSelected) && controlMode !== "desktop") setControlMode("desktop");
      return;
    }
    setSelected(null);
    setRunning(false);
    setChangeSummary(null);
  }, [conversations, selected, query, controlMode]);

  const displayMessages = useMemo(() => messagesForRender(messages, running), [messages, running]);

  const desktopMessages = useMemo(() => {
    if (controlMode !== "desktop") return displayMessages;
    const items = [...messages];
    const desktop = desktopRemote?.desktop;
    const statusText = desktop
      ? [
          desktopStatusText(desktop),
          desktop.reason && !desktopBlockedByRemotePage(desktop) ? `Status: ${desktop.reason}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      : desktopStatusText(null);

    items.push({ role: "system", text: statusText });

    const liveMessages = [];
    if (liveMessages.length) {
      items.push({
        role: "system",
        text: `Codex Desktop live mirror\nVisible items: ${desktop.visibleTranscriptCount || liveMessages.length}\nUpdated: ${formatTime(desktopRemote?.updatedAt || desktop.updatedAt)}`
      });
      items.push(...liveMessages);
    } else if (false && desktop?.found && !desktop?.minimized) {
      items.push({ role: "assistant", text: "Reading Codex Desktop visible content", pending: true });
    }

    const queueItems = desktopRemote?.items || [];
    const recentQueue = queueItems.slice(-8);
    if (recentQueue.length) {
      items.push({
        role: "system",
        text: recentQueue
          .map((item) => {
            const label =
              item.status === "sent"
                ? "Sent"
                : item.status === "failed"
                  ? "Failed"
                  : item.status === "sending"
                    ? "Sending"
                    : item.status === "checking"
                      ? "Checking"
                      : "Waiting";
            return `${label} 路 ${formatTime(item.updatedAt)} 路 ${item.text}${item.error ? `\n  ${item.error}` : ""}`;
          })
          .join("\n\n")
      });
    }

    return messagesForRender(items, false);
  }, [controlMode, desktopRemote, displayMessages, messages]);

  const networkLine = useMemo(() => {
    const primary = network.find((item) => item.address?.startsWith("192.168.")) || network[0];
    return primary ? primary.url : location.origin;
  }, [network]);

  useEffect(() => {
    if (!providers.length) return;
    if (!providers.includes(activeAgent)) setActiveAgent(providers[0]);
  }, [providers, activeAgent]);

  useEffect(() => {
    localStorage.setItem("mat.activeModel", activeModel || "");
  }, [activeModel]);

  useEffect(() => {
    localStorage.setItem("mat.reasoningEffort", reasoningEffort || "");
  }, [reasoningEffort]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [desktopMessages]);

  async function refresh(options = {}) {
    try {
      const [status, history, thread] = await Promise.all([
        request("/api/status", {}, token),
        request("/api/histories", {}, token),
        request("/api/thread-state", {}, token)
      ]);
      setSettings(status.settings);
      setNetwork(status.network || []);
      setWorkspaces(status.workspaces || []);
      const primaryUrl = (status.network || []).find((item) => item.address?.startsWith("192.168."))?.url || status.network?.[0]?.url || location.origin;
      localStorage.setItem("mat.lastBridgeUrl", primaryUrl);
      setTasks(status.tasks || []);
      setPermissionMode(status.settings.permissionMode || "default");
      setHistories(history.items || []);
      setThreadState(thread);
      if (options.keepSelection && selected) {
        setSelected((current) => current);
      }
    } finally {
      setLoading(false);
    }
  }

  async function refreshDesktopRemote(fresh = false) {
    const state = await request(`/api/desktop-remote/status${fresh ? "?fresh=1" : ""}`, {}, token);
    setDesktopRemote(state);
    return state;
  }

  function applyDesktopObserverEvent(event) {
    if (!event?.desktop) return;
    if (event.cursor) desktopObserverCursorRef.current = Math.max(desktopObserverCursorRef.current || 0, Number(event.cursor) || 0);
    setDesktopRemote((current) => ({
      ...(current || {}),
      ok: true,
      mode: "desktop-remote",
      desktop: event.desktop,
      observerEvent: {
        type: event.type,
        cursor: event.cursor || 0,
        observedAt: event.observedAt || event.desktop.updatedAt || new Date().toISOString()
      },
      updatedAt: event.observedAt || event.desktop.updatedAt || new Date().toISOString(),
      items: current?.items || [],
      pendingCount: current?.pendingCount || 0,
      active: Boolean(current?.active)
    }));
  }

  function handleAuthExpired() {
    localStorage.removeItem("mat.token");
    setToken("");
    setSettings(null);
    setTasks([]);
    setHistories([]);
    setSelected(null);
    setMessages([]);
    setRunning(false);
    setLoginError("Pairing token changed or the session expired. Please reconnect with the latest pairing token.");
  }

  useEffect(() => {
    if (!token) return;
    refresh().catch(() => {
      handleAuthExpired();
    });
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    refreshDesktopRemote(true).catch((err) => setError(err.message));
    desktopObserverRef.current?.close();
    desktopObserverRef.current = null;

    try {
      const source = new EventSource(`/api/desktop-remote/events?token=${encodeURIComponent(token)}&after=${desktopObserverCursorRef.current || 0}`);
      desktopObserverRef.current = source;

      const handleDesktopEvent = (message) => {
        try {
          applyDesktopObserverEvent(JSON.parse(message.data));
        } catch (err) {
          setError(err.message);
        }
      };

      source.addEventListener("desktop.snapshot", handleDesktopEvent);
      source.addEventListener("desktop.visibleTranscript.delta", handleDesktopEvent);
      source.addEventListener("desktop.sidebar.running", handleDesktopEvent);
      source.addEventListener("desktop.selection.changed", handleDesktopEvent);
      source.onerror = () => {
        source.close();
        if (desktopObserverRef.current === source) desktopObserverRef.current = null;
      };
    } catch (err) {
      setError(err.message);
    }

    desktopPollRef.current = setInterval(() => {
      refreshDesktopRemote(false).catch((err) => setError(err.message));
    }, controlMode === "desktop" ? 15000 : 30000);
    return () => {
      desktopObserverRef.current?.close();
      desktopObserverRef.current = null;
      if (desktopPollRef.current) clearInterval(desktopPollRef.current);
      desktopPollRef.current = null;
    };
  }, [token, controlMode]);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  function stopTaskStream() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }

  function appendTaskEvents(events, seenCountRef) {
    const seenIds = seenCountRef.ids || new Set();
    const nextEvents = events.filter((event) => {
      if (event.id && seenIds.has(event.id)) return false;
      if (event.id) seenIds.add(event.id);
      return true;
    });
    seenCountRef.ids = seenIds;
    seenCountRef.current = Math.max(seenCountRef.current || 0, events.length);
    const nextMessages = messagesFromEvents(nextEvents);
    if (nextMessages.length) setMessages((items) => appendDisplayMessages(items, nextMessages));
  }

  function startTaskPolling(taskId, seenCountRef) {
    if (pollRef.current) clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const latest = await request(`/api/tasks/${taskId}`, {}, token);
        appendTaskEvents(latest.events || [], seenCountRef);
        setRunning(latest.status === "running");
        setSelected((current) => (current?.kind === "task" && current.id === taskId ? { ...current, status: latest.status } : current));
        if (latest.status !== "running") {
          stopTaskStream();
          refresh({ keepSelection: true }).catch(() => {});
        }
      } catch (err) {
        setError(err.message);
      }
    };

    poll().catch((err) => setError(err.message));
    pollRef.current = setInterval(poll, 1800);
  }

  function followRunningTask(task) {
    const seenCountRef = { current: (task.events || []).length, ids: new Set((task.events || []).map((event) => event.id).filter(Boolean)) };
    let opened = false;
    let fallbackTimer = null;

    const fallbackToPolling = () => {
      if (pollRef.current) return;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      startTaskPolling(task.id, seenCountRef);
    };

    try {
      const source = new EventSource(`/api/tasks/${task.id}/events?token=${encodeURIComponent(token)}`);
      eventSourceRef.current = source;
      fallbackTimer = setTimeout(fallbackToPolling, 6000);

      source.onopen = () => {
        opened = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (!pollRef.current) startTaskPolling(task.id, seenCountRef);
      };

      source.onerror = () => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        fallbackToPolling();
      };

      source.addEventListener("task", (message) => {
        const event = JSON.parse(message.data);
        if (event.id && seenCountRef.ids?.has(event.id)) return;
        if (event.id) seenCountRef.ids?.add(event.id);
        seenCountRef.current += 1;
        const role = taskEventRole(event);
        const text = taskEventText(event);
        if (text && role !== "debug") {
          setMessages((items) => appendDisplayMessages(items, [{ role, text, typing: role === "assistant" }]));
        }
        if (event.type === "system" && /Exited/.test(event.text || "")) {
          const finalStatus = statusFromExitEvent(event);
          setRunning(false);
          if (finalStatus) {
            setSelected((current) => (current?.kind === "task" && current.id === task.id ? { ...current, status: finalStatus } : current));
          }
          stopTaskStream();
          refresh({ keepSelection: true }).catch(() => {});
        }
      });
    } catch {
      fallbackToPolling();
    }
  }

  async function loadHistoryMessages(provider, sessionId) {
    if (!provider || !sessionId) return [];
    try {
      const detail = await request(`/api/histories/${provider}/${encodeURIComponent(sessionId)}`, {}, token);
      return detail.transcript?.length ? messagesFromTranscript(detail.transcript) : messagesFromHistoryEntries(detail.entries || []);
    } catch (err) {
      if (err.status !== 404) setError(err.message);
      return [];
    }
  }

  async function loadTaskChanges(taskId) {
    if (!taskId) return;
    try {
      const summary = await request(`/api/tasks/${taskId}/changes`, {}, token);
      setChangeSummary({ ...summary, kind: "task" });
    } catch {
      setChangeSummary(null);
    }
  }

  async function loadWorkspaceChanges() {
    try {
      const workspaceList = await request("/api/workspaces", {}, token);
      const workspace = workspaceList.items?.[0];
      if (!workspace) {
        setChangeSummary(null);
        return;
      }
      const status = await request(`/api/workspaces/${workspace.id}/git/status`, {}, token);
      setChangeSummary({ ...status, kind: "workspace" });
    } catch {
      setChangeSummary(null);
    }
  }

  async function patchThread(item, patch) {
    const state = await request(
      "/api/thread-state",
      {
        method: "POST",
        body: JSON.stringify({ key: item.key, patch })
      },
      token
    );
    setThreadState(state);
    setSelected((current) => (current?.key === item.key ? { ...current, ...patch, title: patch.title || current.title } : current));
    return state;
  }

  async function forkThread(item) {
    const title = window.prompt("Fork 鍚嶇О", `${item.title} fork`);
    if (!title) return;
    const result = await request(
      "/api/thread-state/forks",
      {
        method: "POST",
        body: JSON.stringify({
          sourceKey: item.key,
          sourceId: item.sessionId || item.id,
          provider: item.provider,
          title,
          cwd: item.cwd || "",
          group: item.group || ""
        })
      },
      token
    );
    setThreadState(result.state);
    setSelected({
      key: `fork:${result.fork.id}`,
      kind: "fork",
      id: result.fork.id,
      provider: result.fork.provider,
      title: result.fork.title,
      cwd: result.fork.cwd,
      status: "fork",
      sessionId: result.fork.sourceId,
      sourceKey: result.fork.sourceKey,
      sourceId: result.fork.sourceId
    });
    setActiveAgent(result.fork.provider);
    const historyMessages = await loadHistoryMessages(result.fork.provider, result.fork.sourceId);
    setMessages(historyMessages.length ? historyMessages : [{ role: "system", text: "Fork created. The next message will continue from the source context." }]);
    setControlMode("agent");
  }

  async function manageConversation(item) {
    const action = window.prompt("Action: rename / pin / archive / restore / group / fork", item.archived ? "restore" : "rename");
    if (!action) return;
    const normalized = action.trim().toLowerCase();
    if (normalized === "rename") {
      const title = window.prompt("New chat title", item.title);
      if (title) await patchThread(item, { title });
      return;
    }
    if (normalized === "pin") {
      await patchThread(item, { pinned: !item.pinned });
      return;
    }
    if (normalized === "archive") {
      if (window.confirm(`Archive "${item.title}"?`)) await patchThread(item, { archived: true });
      return;
    }
    if (normalized === "restore") {
      await patchThread(item, { archived: false });
      return;
    }
    if (normalized === "group") {
      const group = window.prompt("Group name; leave blank to remove from group", item.group || "");
      await patchThread(item, { group: group || "" });
      return;
    }
    if (normalized === "fork") {
      await forkThread(item);
      return;
    }
    setError("Unsupported chat action.");
  }

  async function focusDesktopConversation(conversation) {
    if (!Number.isFinite(Number(conversation?.desktopIndex))) return;
    try {
      const result = await request(
        "/api/desktop-remote/focus",
        {
          method: "POST",
          body: JSON.stringify({ index: conversation.desktopIndex || 0 })
        },
        token
      );
      setDesktopRemote((current) => ({ ...(current || {}), desktop: result.desktop || current?.desktop }));
      loadWorkspaceChanges().catch(() => {});
    } catch (err) {
      setError(err.message || "Failed to focus Codex Desktop chat");
    }
  }

  async function selectConversation(conversation) {
    stopTaskStream();
    setSelected(conversation);
    setSidebarOpen(false);
    setError("");
    setChangeSummary(null);

    if (!conversation) {
      setMessages([]);
      setRunning(false);
      return;
    }

    setActiveAgent(conversation.provider);
    setControlMode(hasDesktopBinding(conversation) ? "desktop" : "agent");
    setMessages([{ role: "system", text: "Reading local context." }]);

    if (conversation.kind === "task") {
      const task = await request(`/api/tasks/${conversation.id}`, {}, token);
      loadTaskChanges(conversation.id).catch(() => {});
      setSelected((current) =>
        current?.kind === "task" && current.id === task.id
          ? {
              ...current,
              key: task.sessionId ? `thread:${task.agent}:${task.sessionId}` : current.key,
              status: task.status,
              cwd: task.cwd || current.cwd,
              sessionId: task.sessionId || current.sessionId || "",
              provider: task.agent || current.provider
            }
          : current
      );
      const historyMessages = await loadHistoryMessages(task.agent || conversation.provider, task.sessionId || conversation.sessionId);
      const hasTurnHistory = historyMessages.some((message) => message.turnId);
      const taskMessages = !historyMessages.length || (task.status === "running" && !hasTurnHistory) ? messagesFromEvents(task.events || []) : [];
      const nextMessages = taskMessages.length ? mergeHistoryAndTaskMessages(historyMessages, taskMessages) : historyMessages;
      setMessages(nextMessages.length ? nextMessages : [{ role: "system", text: "Task started. Waiting for output." }]);
      setRunning(task.status === "running");
      focusDesktopConversation(conversation);

      if (task.status === "running") {
        followRunningTask(task);
      }
      return;
    }

    if (conversation.preview && !isSyntheticHistoryText(conversation.preview)) {
      setMessages([{ role: "assistant", text: conversation.preview, typing: true }]);
    }
    const detail = await request(`/api/histories/${conversation.provider}/${encodeURIComponent(conversation.sourceId || conversation.id)}`, {}, token);
    const entries = detail.transcript?.length ? messagesFromTranscript(detail.transcript) : messagesFromHistoryEntries(detail.entries || []);
    setMessages(entries.length ? entries : [{ role: "system", text: "This history item only has index metadata; no local preview is available yet." }]);
    focusDesktopConversation(conversation);
  }

  async function startTask(prompt) {
    if (!providers.length) return;
    const canResume =
      selected?.kind === "history" ||
      (selected?.kind === "task" && selected.sessionId && selected.status !== "running");
    const resumeSessionId = selected?.sessionId;
    let finalPrompt = prompt;
    if (selected?.kind === "fork") {
      const sourceMessages = await loadHistoryMessages(selected.provider, selected.sourceId || selected.sessionId);
      const context = sourceMessages
        .slice(-80)
        .map((message) => `${message.role}: ${message.text}`)
        .join("\n\n")
        .slice(-24000);
      finalPrompt = `Continue from this forked context as a new independent thread.\n\n<forked_context>\n${context}\n</forked_context>\n\nUser request:\n${prompt}`;
    }
    const payload = {
      agent: activeAgent,
      cwd: selected?.cwd || settings?.defaultCwd || "",
      mode: canResume ? "resume" : "new",
      sessionId: canResume ? resumeSessionId : "",
      prompt: finalPrompt,
      title: selected?.kind === "fork" ? selected.title : prompt,
      model: activeModel || "",
      reasoningEffort: reasoningEffort || ""
    };
    setMessages((items) => appendDisplayMessages(items, [{ role: "user", text: prompt }]));
    setRunning(true);
    const created = await request(
      "/api/tasks",
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      token
    );
    await refresh();
    const task = {
      key: canResume && resumeSessionId ? `thread:${activeAgent}:${resumeSessionId}` : `task:${created.id}`,
      kind: "task",
      id: created.id,
      provider: activeAgent,
      title: canResume ? selected?.title || prompt : prompt,
      cwd: selected?.cwd || "",
      status: "running",
      sessionId: canResume ? resumeSessionId : ""
    };
    await selectConversation(task);
  }

  async function sendDesktopRemote(prompt) {
    stopTaskStream();
    if (selected && selected.provider === "codex" && !hasDesktopBinding(selected)) {
      setError("这个会话当前没有在 Codex Desktop 可见侧边栏中定位到。请先在 Codex Desktop 打开该会话，或切到 Agent 模式用 CLI resume。");
      setMessages((items) =>
        appendDisplayMessages(items, [
          {
            role: "error",
            text: "未发送：无法确认 Codex Desktop 当前 composer 属于这个会话，避免把消息发错线程。"
          }
        ])
      );
      return;
    }
    if (selected?.provider === "codex") await focusDesktopConversation(selected);
    setRunning(false);
    setMessages((items) => appendDisplayMessages(items, [{ role: "user", text: prompt }]));
    const result = await request(
      "/api/desktop-remote/messages",
      {
        method: "POST",
        body: JSON.stringify({ text: prompt })
      },
      token
    );
    setDesktopRemote(result.state);
  }

  async function sendRunningInput(taskId, prompt) {
    setMessages((items) => appendDisplayMessages(items, [{ role: "user", text: prompt }]));
    const result = await request(
      `/api/tasks/${taskId}/input`,
      {
        method: "POST",
        body: JSON.stringify({ text: prompt })
      },
      token
    );
    if (!result.ok) {
      setMessages((items) =>
        appendDisplayMessages(items, [
          {
            role: "error",
            text: "当前 CLI 任务不接受实时 stdin。请等待本轮结束后继续，或切到“遥控 Codex”排队发送。"
          }
        ])
      );
    }
  }

  async function stopRunningTask(taskId) {
    if (!taskId) return;
    await request(
      `/api/tasks/${taskId}/stop`,
      {
        method: "POST",
        body: JSON.stringify({})
      },
      token
    );
    setRunning(false);
    setMessages((items) => appendDisplayMessages(items, [{ role: "system", text: "已请求停止当前任务。" }]));
    refresh({ keepSelection: true }).catch((err) => setError(err.message));
  }

  async function sendPrompt(prompt) {
    if (controlMode === "desktop" || hasDesktopBinding(selected)) {
      await sendDesktopRemote(prompt);
      return;
    }
    await startTask(prompt);
  }

  async function savePermissionMode(value) {
    setPermissionMode(value);
    await request(
      "/api/settings",
      {
        method: "POST",
        body: JSON.stringify({ permissionMode: value })
      },
      token
    ).catch((err) => setError(err.message));
  }

  if (!token) {
    return <LoginView initialError={loginError} onLogin={(value) => {
      setLoginError("");
      setToken(value);
    }} />;
  }

  const title = selected?.title || (controlMode === "desktop" ? "Remote current Codex window" : "New chat");
  const meta = selected
    ? [providerLabel(selected.provider), selected.kind === "task" ? selected.status : "history", selected.cwd].filter(Boolean).join(" · ")
    : controlMode === "desktop"
      ? desktopMetaText(desktopRemote?.desktop)
      : providers.length
      ? "Enter a task. The agent continues running on this computer."
      : "Add an API key in Settings first.";

  return (
    <section className="chat-layout">
      <Sidebar
        conversations={conversations}
        selected={selected}
        query={query}
        setQuery={setQuery}
        onSelect={selectConversation}
        onManage={(item) => manageConversation(item).catch((err) => setError(err.message))}
        showArchived={showArchived}
        setShowArchived={setShowArchived}
        onToggleProject={(key) => setExpandedProjects((current) => ({ ...current, [key]: !(current[key] ?? true) }))}
        onNew={() => selectConversation(null)}
        onRefresh={() => refresh({ keepSelection: true }).catch((err) => setError(err.message))}
        networkLine={networkLine}
        open={sidebarOpen}
        loading={loading}
      />
      <section className="chat-pane">
        <header className="chat-header">
          <button className="icon-button mobile-only" title="Menu" aria-label="Menu" type="button" onClick={() => setSidebarOpen(true)}>
            <Menu size={21} />
          </button>
          <div className="chat-title">
            <h2>{title}</h2>
            <p>{error || meta}</p>
          </div>
          <button className="icon-button" title="Settings" aria-label="Settings" type="button" onClick={() => setSettingsOpen(true)}>
            <Settings size={20} />
          </button>
        </header>
        <div className="message-list" ref={listRef} aria-live="polite">
          <ChangeCard summary={changeSummary} />
          {desktopMessages.length ? (
            desktopMessages.map((message, index) => <Message key={`${index}-${message.role}-${message.pending ? "pending" : "message"}`} token={token} {...message} />)
          ) : (
            <div className="empty-state">
              <h2>{loading ? "Syncing chats" : providers.length ? "Choose an agent" : "Connect an agent"}</h2>
              <p>{loading ? "Reading local tasks and history." : providers.length ? "Select a chat on the left or start a new task here." : "Add an OpenAI or Anthropic API key in Settings."}</p>
            </div>
          )}
        </div>
        <Composer
          providers={providers}
          activeAgent={activeAgent}
          setActiveAgent={(provider) => {
            setActiveAgent(provider);
            if (selected?.provider !== provider) selectConversation(null).catch((err) => setError(err.message));
          }}
          permissionMode={permissionMode}
          setPermissionMode={savePermissionMode}
          running={running}
          controlMode={controlMode}
          setControlMode={setControlMode}
          desktopRemote={desktopRemote}
          token={token}
          workspaces={workspaces}
          activeModel={activeModel}
          setActiveModel={setActiveModel}
          reasoningEffort={reasoningEffort}
          setReasoningEffort={setReasoningEffort}
          selected={selected}
          runningTaskId={running && selected?.kind === "task" ? selected.id : ""}
          onRunningInput={(taskId, prompt) => sendRunningInput(taskId, prompt).catch((err) => {
            setError(err.message);
            setMessages((items) => appendDisplayMessages(items, [{ role: "error", text: err.message || "Live input failed" }]));
          })}
          onStop={(taskId) => stopRunningTask(taskId).catch((err) => {
            setError(err.message);
            setMessages((items) => appendDisplayMessages(items, [{ role: "error", text: err.message || "Stop failed" }]));
          })}
          onSend={(prompt) => sendPrompt(prompt).catch((err) => {
            setRunning(false);
            if (err.status === 401) {
              handleAuthExpired();
              return;
            }
            setError(err.message);
            setMessages((items) => appendDisplayMessages(items, [{ role: "error", text: err.message || "Send failed" }]));
          })}
        />
      </section>
      {sidebarOpen ? <button className="sidebar-backdrop" aria-label="Close menu" type="button" onClick={() => setSidebarOpen(false)} /> : null}
      {settingsOpen ? (
        <SettingsDrawer
          settings={settings}
          token={token}
          network={network}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            refresh({ keepSelection: true }).catch((err) => setError(err.message));
          }}
        />
      ) : null}
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
