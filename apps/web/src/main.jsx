import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import {
  ArrowUp,
  Archive,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  Download,
  ExternalLink,
  File,
  FileText,
  FilePlus2,
  Folder,
  FolderOpen,
  History,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  LocateFixed,
  Menu,
  Maximize2,
  MessageCircle,
  Minimize2,
  Monitor,
  MoreHorizontal,
  Pencil,
  Phone,
  PhoneOff,
  Plus,
  RotateCcw,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Square,
  Target,
  Terminal,
  Trash2,
  Volume2,
  X
} from "lucide-react";
import "./styles.css";

const savedToken = localStorage.getItem("mat.token") || "";
const desktopObserverCursorKey = "mat.stream.desktopObserver.cursor";
const typedTextAnimationKeys = new Set();

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function streamCursorKey(kind, id) {
  return `mat.stream.${kind}.${id}.cursor`;
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
    error.data = data;
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

function cursorFromEvents(events = []) {
  return events.reduce((max, event) => Math.max(max, Number(event?.cursor || 0)), 0);
}

function rememberStreamCursor(key, value) {
  const cursor = Number(value || 0);
  if (cursor > 0) localStorage.setItem(key, String(cursor));
  return cursor;
}

function attachmentKind(file) {
  return file?.type?.startsWith("image/") ? "image" : "file";
}

function compact(value, fallback = "Untitled") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function providerLabel(provider) {
  const labels = { claude: "Claude", codex: "Codex", zhipu: "智谱" };
  return labels[provider] || provider;
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

function translateDesktopWaitReason(reason = "") {
  const value = String(reason || "");
  if (!value) return "";
  if (/model|permission|reasoning|settings|menus|CLI mode|Desktop settings/i.test(value)) {
    return "Desktop 遥控使用 Codex Desktop 当前设置；需要精确模型、权限或思考强度时请切到 Agent 模式";
  }
  if (/target_missing|bound visible|sidebar conversation|target/i.test(value)) return "未发送：无法确认目标 Codex Desktop 会话";
  if (/title no longer matches|project no longer matches/i.test(value)) return "未发送：Codex Desktop 侧栏会话或项目已不匹配";
  if (/post-send verification|cleared input|visible user message|thinking\/running/i.test(value)) return "已发送，但未确认输入框清空、消息可见和 Codex 进入运行状态";
  if (/remote control page/i.test(value)) return "遥控页开在 Codex 内置浏览器里，已阻止发送";
  if (/sidebar shows|running conversation/i.test(value)) return "Codex 左侧仍有任务在运行，等待当前回合结束";
  if (/already contains text|refusing to overwrite/i.test(value)) return "Codex 输入框里已有内容，等待输入框清空";
  if (/minimized/i.test(value)) return "Codex 已最小化，发送时会自动恢复窗口";
  if (/not found|window/i.test(value)) return "未找到可遥控的 Codex 窗口";
  if (/send button/i.test(value)) return "等待 Codex 发送按钮可用";
  if (/composer/i.test(value)) return "等待 Codex 输入区可用";
  return value;
}

function latestDesktopQueueItem(items = []) {
  return [...items].reverse().find((item) => item && item.status !== "cancelled") || null;
}

function desktopCommandSummaryFromTranscript(transcript = []) {
  let commandCount = 0;
  const commands = [];

  for (const item of transcript || []) {
    const text = String(item?.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    const countMatch =
      text.match(/已(?:运行|执行)\s*(\d+)\s*条命令/i) ||
      text.match(/Ran\s+(\d+)\s+commands?/i) ||
      text.match(/Executed\s+(\d+)\s+commands?/i);
    if (countMatch) {
      commandCount = Math.max(commandCount, Number(countMatch[1]) || 0);
      continue;
    }

    const commandMatch =
      text.match(/^(?:正在运行|Running)\s+(.{3,220})$/i) ||
      text.match(/^(?:已运行|Ran|Executed)\s+(.{3,220})$/i) ||
      text.match(/^(?:[$>])\s+(.{3,220})$/) ||
      text.match(/^`([^`]{3,220})`$/) ||
      text.match(/^((?:bash|cmd|powershell|pwsh|python|node|npm|pnpm|yarn|git|rg|sed|cat|ls|dir|Get-ChildItem|Select-String)\b.{2,220})$/i);
    if (commandMatch) {
      const command = commandMatch[1].trim();
      if (command && !commands.some((item) => item.command === command)) {
        const running = text.startsWith("正在运行") || /^Running/i.test(text);
        commands.push({
          command,
          name: running ? "running command" : "command",
          status: running ? "running" : /failed|error|失败/i.test(text) ? "failed" : "done"
        });
      }
    }
  }

  return {
    commandCount: Math.max(commandCount, commands.length),
    commands: commands.slice(-8),
    running: commands.some((item) => item.status === "running")
  };
}

function desktopTurnStatusMessage(queueItem, desktop) {
  const transcriptSummary = desktopCommandSummaryFromTranscript(desktop?.visibleTranscript || []);
  const isRunning = desktopRunningTurn(desktop) || Boolean(desktop?.sidebarHasRunning || desktop?.sidebarRunningCount > 0);

  if (!queueItem && isRunning) {
    return {
      role: "assistant",
      text: transcriptSummary.commandCount ? "Codex 正在处理并运行命令" : "Codex 正在思考",
      pending: true,
      ...transcriptSummary
    };
  }

  if (!queueItem) return null;
  const sentAt = new Date(queueItem.sentAt || queueItem.updatedAt || 0).getTime();
  const sentAge = Number.isFinite(sentAt) ? Date.now() - sentAt : 0;
  const base = {
    role: queueItem.status === "failed" ? "error" : "assistant",
    text: "",
    pending: true,
    ...transcriptSummary
  };

  if (queueItem.status === "queued") return { ...base, text: "已加入 Codex 遥控队列" };
  if (queueItem.status === "checking") return { ...base, text: "正在检查 Codex Desktop 状态" };
  if (queueItem.status === "sending") return { ...base, text: "正在发送到 Codex Desktop" };
  if (queueItem.status === "waiting") {
    return {
      ...base,
      text: translateDesktopWaitReason(queueItem.error) || "等待 Codex 空闲后继续发送"
    };
  }
  if (queueItem.status === "failed") {
    return {
      ...base,
      pending: false,
      text: queueItem.error || "发送到 Codex Desktop 失败"
    };
  }
  if (queueItem.status === "sent_unverified") {
    return {
      ...base,
      role: "error",
      pending: false,
      text: translateDesktopWaitReason(queueItem.error) || queueItem.error || "已发送，但未完成发送后验证"
    };
  }
  if (queueItem.status === "sent") {
    if (isRunning) {
      return {
        ...base,
        text: transcriptSummary.commandCount ? "Codex 正在处理并运行命令" : "Codex 正在思考"
      };
    }
    if (sentAge < 90000) {
      return {
        ...base,
        text: "已发送到 Codex，等待输出同步"
      };
    }
  }

  return null;
}

function isDesktopTranscriptNoise(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return true;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(value)) return true;
  if (/^(复制|复制消息|编辑消息|编辑|滚动到底部|启用自动换行|打开位置|撤销|审查)$/i.test(value)) return true;
  if (/^(已处理|正在处理|正在思考|已运行\s*\d+\s*条命令|正在运行\s*\d+\s*条命令)/i.test(value)) return true;
  if (/^(Codex|Agent|AGENT|SYSTEM|USER|You|系统|用户)$/.test(value)) return true;
  if (/^(Desktop 遥控|Codex 空闲|等待 Codex|运行中|就绪|ready)$/i.test(value)) return true;
  return false;
}

function desktopTranscriptKey(item, index) {
  return item?.trackId || item?.id || `${item?.role || "system"}:${item?.kind || "text"}:${item?.index ?? index}`;
}

function isDesktopCommandLine(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return (
    /^(已运行|正在运行|Ran|Running|Executed)\b/i.test(value) ||
    /^(?:[$>])\s+\S/.test(value) ||
    /^(?:bash|cmd|powershell|pwsh|python|node|npm|pnpm|yarn|git|rg|sed|cat|ls|dir|Get-ChildItem|Select-String)\b/i.test(value)
  );
}

function compactDesktopTranscriptEntries(items = []) {
  const byTrack = new Map();

  items.forEach((item, order) => {
    if (item.role === "user") return;
    const text = String(item.text || "").trim();
    const normalized = normalizeMessageText(text);
    if (!normalized || isDesktopTranscriptNoise(normalized)) return;
    if (isDesktopCommandLine(normalized) && normalized.length < 260) return;

    const key = desktopTranscriptKey(item, order);
    const previous = byTrack.get(key);
    const entry = {
      key,
      order,
      index: Number(item.index ?? order),
      role: item.role || "assistant",
      kind: item.kind || "text",
      text,
      normalized
    };

    if (!previous || normalized.length >= previous.normalized.length) byTrack.set(key, entry);
  });

  const entries = [...byTrack.values()].sort((a, b) => a.order - b.order);
  return entries.filter((entry, index) => {
    return !entries.some((other, otherIndex) => {
      if (index === otherIndex || other.role !== entry.role) return false;
      if (other.normalized.length <= entry.normalized.length + 40) return false;
      const sameTrack = other.key === entry.key;
      const nearby = Math.abs(other.index - entry.index) <= 1;
      const documentWrap = other.kind === "document" || entry.kind === "document";
      return (sameTrack || nearby || documentWrap) && other.normalized.includes(entry.normalized);
    });
  });
}

function desktopVisibleTurnFromTranscript(desktop, baseMessages = []) {
  const transcript = desktop?.visibleTranscript || [];
  if (!transcript.length) return null;

  const lastUser = [...baseMessages].reverse().find((item) => item.role === "user")?.text || "";
  const lastUserText = normalizeMessageText(lastUser).slice(0, 160);
  let startIndex = 0;
  if (lastUserText) {
    const matchedIndex = transcript.findLastIndex?.((item) => {
      if (item.role !== "user") return false;
      const text = normalizeMessageText(item.text);
      return text.includes(lastUserText) || lastUserText.includes(text.slice(0, 120));
    });
    if (Number.isFinite(matchedIndex) && matchedIndex >= 0) startIndex = matchedIndex + 1;
  }

  const summary = desktopCommandSummaryFromTranscript(transcript);
  const existingText = normalizeMessageText(baseMessages.map((item) => item.text).join("\n"));
  const liveEntries = compactDesktopTranscriptEntries(transcript.slice(startIndex));
  const chunks = liveEntries.map((item) => item.text);

  const text = chunks.join("\n\n").trim();
  if (!text) return null;
  const comparable = normalizeMessageText(text);
  if (comparable.length > 80 && existingText.includes(comparable.slice(0, 240))) return null;
  const liveKey = `desktop-live:${liveEntries.map((item) => item.key).join("|") || desktop.visibleTranscriptHash || "current"}`;

  return {
    role: "assistant",
    text: text.slice(-16000),
    typing: false,
    live: true,
    sourceKind: "desktop-observer",
    syncStage: "live",
    observedAt: desktop.updatedAt || "",
    liveKey,
    streaming: desktopRunningTurn(desktop),
    commandCount: summary.commandCount,
    commands: summary.commands,
    commandRunning: summary.running || desktopRunningTurn(desktop)
  };
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

function taskApprovalText(error) {
  const message = String(error?.message || "");
  return message.replace(/^Task requires explicit approval:\s*/i, "").trim();
}

function commandApprovalText(error) {
  const message = String(error?.message || "");
  return message.replace(/^Command requires explicit approval:\s*/i, "").trim();
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

function conversationHistoryId(conversation) {
  return conversation?.sourceId || conversation?.sessionId || conversation?.historyId || conversation?.id || "";
}

function historyToolTaskId(provider, sessionId) {
  return provider && sessionId ? `history:${provider}:${sessionId}` : "";
}

function desktopRemoteNeedsHistoryRefresh(desktopRemote) {
  const desktop = desktopRemote?.desktop;
  const latestItem = latestDesktopQueueItem(desktopRemote?.items || []);
  const latestAt = new Date(latestItem?.sentAt || latestItem?.updatedAt || 0).getTime();
  const recentlyTouched = ["sent", "sent_unverified", "sending", "checking", "waiting"].includes(latestItem?.status) && Number.isFinite(latestAt) && Date.now() - latestAt < 180000;
  return (
    Number(desktopRemote?.pendingCount || 0) > 0 ||
    Boolean(desktopRemote?.active) ||
    recentlyTouched ||
    desktopRunningTurn(desktop)
  );
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

function shouldAnimateLiveAssistant(agent, role) {
  return String(agent || "").toLowerCase() === "codex" && role === "assistant";
}

function messagesFromEvents(events = [], options = {}) {
  const animateAssistant = Boolean(options.animateAssistant && options.realtime);
  const typingKeyPrefix = options.typingKeyPrefix || "task-event";
  return normalizeDisplayMessages(
    events
      .map((event, index) => {
        const role = taskEventRole(event);
        const typing = animateAssistant && role === "assistant";
        return {
          role,
          text: taskEventText(event),
          typing,
          typingKey: typing ? `${typingKeyPrefix}:${event.id || event.cursor || index}` : ""
        };
      })
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
      durationMs: item.durationMs || null,
      completedAt: item.completedAt || "",
      startedAt: item.startedAt || "",
      turnId: item.turnId || "",
      commandCount: item.commandCount || item.commands?.length || 0,
      commands: Array.isArray(item.commands) ? item.commands : [],
      toolCallCount: item.toolCallCount || item.toolCalls?.length || 0,
      toolCalls: Array.isArray(item.toolCalls) ? item.toolCalls : [],
      parts: Array.isArray(item.parts) ? item.parts : [],
      sourceKind: "codex-jsonl",
      syncStage: "reconciled",
      reconciled: true,
      source: item
    }))
    .filter((message) => (message.text || message.commands?.length || message.toolCalls?.length) && (!message.text || !isHistoryNoise(message.source, message.text)))
    .map(({ source, ...message }) => message);

  return normalizeDisplayMessages(messages).slice(-limit);
}

function messagesFromDesktopVisibleTranscript(transcript = [], limit = 40) {
  return normalizeDisplayMessages(
    transcript
      .slice(-limit)
      .map((item) => ({
        role: item.role === "user" || item.role === "assistant" || item.role === "error" ? item.role : "system",
        text: item.text || ""
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

function normalizePathForMatch(value) {
  return String(value || "").replace(/[\\/]+$/, "").toLowerCase();
}

function workspaceMatchesPath(workspace, cwd) {
  const target = normalizePathForMatch(cwd);
  const root = normalizePathForMatch(workspace?.allowedRoot || workspace?.path || "");
  if (!target || !root) return false;
  return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`);
}

function chooseWorkspaceForPath(items = [], cwd = "") {
  const matches = items
    .filter((workspace) => workspaceMatchesPath(workspace, cwd))
    .sort((a, b) => normalizePathForMatch(b.allowedRoot || b.path).length - normalizePathForMatch(a.allowedRoot || a.path).length);
  return matches[0] || items[0] || null;
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

function desktopRemoteTargetSnapshot(source) {
  if (!hasDesktopBinding(source)) return null;
  return {
    key: source.key || "",
    id: source.id || "",
    sessionId: source.sessionId || "",
    historyId: source.historyId || "",
    sourceId: source.sourceId || "",
    title: source.title || "",
    cwd: source.cwd || "",
    desktopIndex: Number(source.desktopIndex),
    desktopProjectIndex: Number.isFinite(Number(source.desktopProjectIndex)) ? Number(source.desktopProjectIndex) : null,
    desktopTitle: source.desktopTitle || source.title || "",
    desktopProjectTitle: source.desktopProjectTitle || projectNameFromPath(source.cwd || "")
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

function parsePathReference(value = "") {
  const text = String(value || "").trim().replace(/^<|>$/g, "");
  const match = text.match(/((?:[A-Za-z]:[\\/]|\/)?[^\s"'`<>]+?\.[A-Za-z0-9]{1,12})(?::(\d+))?(?::(\d+))?$/);
  if (!match) return null;
  return {
    path: match[1].replaceAll("\\", "/"),
    line: Number(match[2] || 0),
    column: Number(match[3] || 0)
  };
}

function fileNameFromWorkspacePath(value = "") {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || value || "file";
}

function messageIdentity(message) {
  if (message?.liveKey) return `${message.role}\nlive:${message.liveKey}`;
  if (message?.turnId) return `${message.role}\nturn:${message.turnId}`;
  const toolIds = (message?.toolCalls || []).map((item) => item.id || item.callId || item.toolCallId).filter(Boolean).join(",");
  if (!message?.text && toolIds) return `${message.role}\ntools:${toolIds}`;
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

function commandDetailScore(commands = []) {
  return commands.reduce((score, command) => {
    return score + 1 + String(command.output || "").length + (Number.isFinite(Number(command.exitCode)) ? 20 : 0);
  }, 0);
}

function moreDetailedCommands(current = [], incoming = []) {
  return commandDetailScore(incoming) >= commandDetailScore(current) ? incoming : current;
}

function toolCallDetailScore(toolCalls = []) {
  return toolCalls.reduce((score, toolCall) => {
    return score + 1 + String(toolCall.output || "").length + (toolCall.status && toolCall.status !== "running" ? 20 : 0);
  }, 0);
}

function moreDetailedToolCalls(current = [], incoming = []) {
  return toolCallDetailScore(incoming) >= toolCallDetailScore(current) ? incoming : current;
}

function toolEventStatus(events = []) {
  const types = events.map((event) => event.type || "");
  if (types.includes("tool.failed") || types.includes("tool.error") || types.includes("approval.denied")) return "failed";
  if (types.includes("approval.expired")) return "expired";
  if (types.includes("tool.cancelled")) return "cancelled";
  if (types.includes("tool.cancel_requested")) return "cancelling";
  if (types.includes("tool.completed")) return "done";
  if (types.includes("approval.required")) return "approval_required";
  if (types.includes("tool.started") || types.includes("tool.output")) return "running";
  return "queued";
}

function toolEventLabel(events = []) {
  const created = events.find((event) => event.type === "tool.created") || events[0] || {};
  const payload = created.payload || {};
  return payload.toolName || created.toolName || "tool";
}

function registryDefinitionForTool(name = "", registry = {}) {
  if (!name) return null;
  if (registry[name]) return registry[name];
  const patterns = Object.values(registry).filter((item) => item?.name?.includes("*"));
  return patterns.find((item) => new RegExp(`^${item.name.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i").test(name)) || null;
}

function toolEventsToMessages(events = [], registry = {}) {
  const byRun = new Map();
  for (const event of events) {
    const runId = event.toolRunId || event.payload?.toolRunId || "";
    if (!runId) continue;
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId).push(event);
  }

  const toolCalls = [...byRun.entries()].map(([runId, runEvents]) => {
    const sorted = [...runEvents].sort((a, b) => Number(a.cursor || 0) - Number(b.cursor || 0));
    const created = sorted.find((event) => event.type === "tool.created") || sorted[0] || {};
    const started = sorted.find((event) => event.type === "tool.started") || {};
    const terminal = [...sorted].reverse().find((event) => /^tool\.(completed|failed|error)$/.test(event.type || "")) || {};
    const approval = sorted.find((event) => event.type === "approval.required") || null;
    const outputEvents = sorted.filter((event) => event.type === "tool.output");
    const outputText = outputEvents.map((event) => event.payload?.text || event.text || "").join("");
    const payload = created.payload || {};
    const name = toolEventLabel(sorted);
    const definition = payload.tool || registryDefinitionForTool(name, registry) || {};
    const createdInput = payload.input || {};
    const kind = definition.kind || createdInput.kind || payload.kind || (
      name.includes("git") ? "git" : name.includes("command") || name.includes("test") ? "shell" : "tool"
    );
    return {
      id: runId,
      name,
      label: definition.label || name,
      kind,
      permission: definition.permission || "",
      risk: definition.risk || "",
      description: definition.description || "",
      status: toolEventStatus(sorted),
      input: createdInput || started.payload?.input || payload,
      output: outputText || terminal.payload?.result || terminal.payload || null,
      outputEvents,
      approval: approval?.payload || null,
      cursor: Math.max(...sorted.map((event) => Number(event.cursor || 0))),
      events: sorted
    };
  });

  if (!toolCalls.length) return [];
  return [
    {
      role: "assistant",
      text: "",
      toolCalls,
      toolCallCount: toolCalls.length,
      syncStage: "tool-events"
    }
  ];
}

function resultFromToolRunEvents(events = [], fallback = {}) {
  const sorted = [...events].sort((a, b) => Number(a.cursor || 0) - Number(b.cursor || 0));
  const terminal = [...sorted].reverse().find((event) => /^tool\.(completed|failed|error|cancelled)$/.test(event.type || "")) || null;
  const outputEvents = sorted.filter((event) => event.type === "tool.output");
  const stdout = outputEvents.filter((event) => (event.payload?.stream || "stdout") === "stdout").map((event) => event.payload?.text || event.text || "").join("");
  const stderr = outputEvents.filter((event) => event.payload?.stream === "stderr").map((event) => event.payload?.text || event.text || "").join("");
  const terminalResult = terminal?.payload?.result || null;
  if (!terminal && !outputEvents.length) return fallback;
  return {
    ...fallback,
    ...(terminalResult || {}),
    stdout: terminalResult?.stdout ?? stdout,
    stderr: terminalResult?.stderr ?? stderr,
    ok: terminal?.type === "tool.completed" ? true : terminal ? false : fallback.ok ?? null,
    status: terminal?.type === "tool.completed"
      ? "completed"
      : terminal?.type === "tool.cancelled"
        ? "cancelled"
        : terminal
          ? "failed"
          : "running"
  };
}

function mergeMessageDetails(current, incoming) {
  const commands = moreDetailedCommands(current.commands || [], incoming.commands || []);
  const toolCalls = moreDetailedToolCalls(current.toolCalls || [], incoming.toolCalls || []);
  const isReconciled = Boolean(incoming.completedAt || incoming.reconciled || incoming.syncStage === "reconciled");
  return {
    ...current,
    ...incoming,
    text: incoming.text || current.text,
    typing: isReconciled ? false : Boolean(incoming.typing),
    commandCount: Math.max(Number(current.commandCount || 0), Number(incoming.commandCount || 0), commands.length),
    commands,
    toolCallCount: Math.max(Number(current.toolCallCount || 0), Number(incoming.toolCallCount || 0), toolCalls.length),
    toolCalls
  };
}

function textOverlapsEnough(left, right, threshold = 80) {
  const a = normalizeMessageText(left);
  const b = normalizeMessageText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  return shorter > threshold && (a.includes(b) || b.includes(a));
}

function reconciledMessageCoversLive(liveMessage, reconciledMessage) {
  if (!liveMessage?.live || reconciledMessage?.role !== liveMessage.role) return false;
  if (reconciledMessage?.turnId && liveMessage?.turnId && reconciledMessage.turnId === liveMessage.turnId) return true;
  if (textOverlapsEnough(liveMessage.text, reconciledMessage.text, 60)) return true;
  return (
    commandDetailScore(reconciledMessage.commands || []) > commandDetailScore(liveMessage.commands || []) &&
    Number(reconciledMessage.commandCount || 0) >= Number(liveMessage.commandCount || 0)
  ) || (
    toolCallDetailScore(reconciledMessage.toolCalls || []) > toolCallDetailScore(liveMessage.toolCalls || []) &&
    Number(reconciledMessage.toolCallCount || 0) >= Number(liveMessage.toolCallCount || 0)
  );
}

function mergeDisplayMessagesWithUpdates(current = [], incoming = []) {
  const reconciledIncoming = incoming.filter((message) => message?.reconciled || message?.syncStage === "reconciled" || message?.turnId);
  const merged = current.filter((message) => !message?.live || !reconciledIncoming.some((incomingMessage) => reconciledMessageCoversLive(message, incomingMessage)));

  for (const message of incoming) {
    if (!message?.text && !message?.commands?.length && !message?.toolCalls?.length) continue;
    const identity = messageIdentity(message);
    const index = merged.findIndex((item) => messageIdentity(item) === identity);
    if (index >= 0) {
      merged[index] = mergeMessageDetails(merged[index], message);
      continue;
    }
    merged.push(message);
  }

  return normalizeDisplayMessages(merged);
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
    if ((!item?.text && !item?.commands?.length && !item?.toolCalls?.length) || item.role === "debug") continue;

    const identity = messageIdentity(item);
    const normalizedText = normalizeMessageText(item.text);
    const duplicated = recentMessages.some((recent) => {
      if (recent.role !== item.role) return false;
      if (recent.identity === identity) return true;
      if ((recent.turnId || item.turnId) && !recent.live && !item.live) return false;
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
    recentMessages.push({ role: item.role, identity, text: normalizedText, turnId: item.turnId || "", live: Boolean(item.live) });
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
  if ((!message?.text && !message?.commands?.length && !message?.toolCalls?.length) || message.role === "debug") return false;
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

function urlBase64ToUint8Array(value = "") {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

function pathBaseName(value) {
  return stripPathWrappers(value).split(/[\\/]/).filter(Boolean).pop() || "file";
}

function fileExtension(value) {
  const clean = stripPathWrappers(value).replace(/[?#].*$/, "");
  const [, ext = ""] = clean.match(/\.([A-Za-z0-9]+)$/) || [];
  return ext.toLowerCase();
}

function isArtifactPath(value) {
  const ext = fileExtension(value);
  return Boolean(ext && !["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(ext));
}

function artifactKind(value) {
  const ext = fileExtension(value);
  if (["pdf"].includes(ext)) return "PDF";
  if (["doc", "docx", "odt"].includes(ext)) return "Document";
  if (["xls", "xlsx", "csv", "tsv"].includes(ext)) return "Spreadsheet";
  if (["ppt", "pptx", "key"].includes(ext)) return "Presentation";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "Archive";
  if (["md", "txt", "json", "jsonl", "yaml", "yml", "toml", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "ps1", "sh"].includes(ext)) return "Text";
  return ext ? ext.toUpperCase() : "File";
}

function normalizeMarkdownText(text) {
  return String(text || "").replace(/(^|[\s(:：])((?:[A-Za-z]:[\\/]|\/)[^\r\n<>)]*?\.(?:png|jpe?g|gif|webp|avif)(?:[?#][^\s)]*)?)/gi, (full, prefix, imagePath, offset, input) => {
    if (prefix.includes("(") && input[offset - 1] === "]") return full;
    return `${prefix}![${pathBaseName(imagePath)}](${imagePath})`;
  });
}

function stripUserAttachmentMetadata(text) {
  return String(text || "")
    .replace(/<attachment_preview\b[^>]*>[\s\S]*?<\/attachment_preview>/gi, "")
    .replace(/^\s*(?:Local file|Relative path):[^\r\n]*(?:\r?\n)?/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractArtifactLinks(text, token) {
  const value = String(text || "");
  const results = [];
  const seen = new Set();
  const add = (label, href) => {
    const raw = stripPathWrappers(href);
    if (!raw || !isArtifactPath(raw) || seen.has(raw)) return;
    seen.add(raw);
    results.push({
      label: compact(label || pathBaseName(raw), pathBaseName(raw)),
      href: localFileUrl(raw, token),
      raw,
      kind: artifactKind(raw)
    });
  };

  const markdownPattern = /!?\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = markdownPattern.exec(value))) {
    if (match[0].startsWith("!")) continue;
    add(match[1], match[2]);
  }

  const localPathPattern = /(^|[\s(:：])((?:[A-Za-z]:[\\/]|\/)[^\r\n<>)]*?\.[A-Za-z0-9]{2,8}(?:[?#][^\s)]*)?)/g;
  while ((match = localPathPattern.exec(value))) {
    add(pathBaseName(match[2]), match[2]);
  }

  return results.slice(0, 8);
}

function extractImageLinks(text, token) {
  const value = String(text || "");
  const results = [];
  const seen = new Set();
  const add = (label, href) => {
    const raw = stripPathWrappers(href);
    if (!raw || !isImagePath(raw) || seen.has(raw)) return;
    seen.add(raw);
    results.push({
      label: compact(label || pathBaseName(raw), pathBaseName(raw)),
      href: localFileUrl(raw, token),
      raw
    });
  };

  const markdownPattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = markdownPattern.exec(value))) add(match[1], match[2]);

  const localPathPattern = /(^|[\s(:：])((?:[A-Za-z]:[\\/]|\/)[^\r\n<>)]*?\.(?:png|jpe?g|gif|webp|avif)(?:[?#][^\s)]*)?)/gi;
  while ((match = localPathPattern.exec(value))) add(pathBaseName(match[2]), match[2]);

  return results.slice(0, 12);
}

async function copyText(value) {
  const text = String(value || "");
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
  return true;
}

function useTypedText(text, active, animationKey = "") {
  const fullText = String(text || "");
  const key = animationKey ? String(animationKey) : "";
  const alreadyAnimated = Boolean(key && typedTextAnimationKeys.has(key));
  const [shown, setShown] = useState(active && !alreadyAnimated ? "" : fullText);

  useEffect(() => {
    if (!active || (key && typedTextAnimationKeys.has(key))) {
      setShown(fullText);
      return undefined;
    }

    const chars = [...fullText];
    let index = 0;
    setShown((current) => {
      const currentText = String(current || "");
      const prefix = fullText.startsWith(currentText) ? currentText : "";
      index = [...prefix].length;
      return prefix;
    });

    if (index >= chars.length) {
      if (key) typedTextAnimationKeys.add(key);
      setShown(fullText);
      return undefined;
    }

    const step = Math.max(1, Math.floor(chars.length / 180));
    const timer = setInterval(() => {
      index += step;
      const next = chars.slice(0, index).join("");
      setShown(next);
      if (index >= chars.length) {
        if (key) typedTextAnimationKeys.add(key);
        clearInterval(timer);
      }
    }, 12);
    return () => clearInterval(timer);
  }, [fullText, active, key]);

  return shown;
}

function TypingText({ text, active }) {
  const shown = useTypedText(text, active);
  return <span className={active && shown.length < String(text || "").length ? "typing-caret" : ""}>{shown}</span>;
}

function CodeBlock({ code, language = "" }) {
  const [copied, setCopied] = useState(false);
  const label = language || "text";

  async function copyCode() {
    await copyText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="code-card">
      <div className="code-card-head">
        <span><Code2 size={14} /> {label}</span>
        <button type="button" onClick={copyCode} title="复制代码">
          {copied ? <CheckSquare size={14} /> : <Copy size={14} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="markdown-pre">
        <code className={language ? `language-${language}` : ""}>{code}</code>
      </pre>
    </div>
  );
}

function MessageImage({ src, alt, token }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const imageUrl = localFileUrl(src, token);

  if (failed) {
    return (
      <a className="message-image-fallback" href={imageUrl} target="_blank" rel="noreferrer">
        <ImageOff size={18} />
        <span>{alt || pathBaseName(src) || "Image failed to load"}</span>
      </a>
    );
  }

  return (
    <>
      <button className="message-image-link" type="button" onClick={() => setOpen(true)} title="放大图片">
        <img className="message-image" src={imageUrl} alt={alt || "image"} loading="lazy" onError={() => setFailed(true)} />
      </button>
      {open ? (
        <div className="image-lightbox" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <div className="image-lightbox-bar" onClick={(event) => event.stopPropagation()}>
            <span>{alt || pathBaseName(src)}</span>
            <a href={imageUrl} download={pathBaseName(src)} title="下载图片">
              <Download size={17} />
            </a>
            <a href={imageUrl} target="_blank" rel="noreferrer" title="新窗口打开">
              <ExternalLink size={17} />
            </a>
            <button type="button" onClick={() => setOpen(false)} title="关闭">
              <X size={18} />
            </button>
          </div>
          <img src={imageUrl} alt={alt || "image"} onClick={(event) => event.stopPropagation()} />
        </div>
      ) : null}
    </>
  );
}

function ImageGallery({ images = [] }) {
  const [openIndex, setOpenIndex] = useState(-1);
  if (images.length < 2) return null;
  const active = images[openIndex] || null;
  return (
    <div className="image-gallery">
      {images.map((image, index) => (
        <button type="button" key={image.raw} onClick={() => setOpenIndex(index)} title="打开图库">
          <img src={image.href} alt={image.label || "image"} loading="lazy" />
        </button>
      ))}
      {active ? (
        <div className="image-lightbox" role="dialog" aria-modal="true" onClick={() => setOpenIndex(-1)}>
          <div className="image-lightbox-bar" onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => setOpenIndex((value) => (value <= 0 ? images.length - 1 : value - 1))} title="上一张">
              <ChevronLeft size={18} />
            </button>
            <span>{active.label || pathBaseName(active.raw)}</span>
            <button type="button" onClick={() => setOpenIndex((value) => (value + 1) % images.length)} title="下一张">
              <ChevronRight size={18} />
            </button>
            <a href={active.href} download={pathBaseName(active.raw)} title="下载图片">
              <Download size={17} />
            </a>
            <button type="button" onClick={() => setOpenIndex(-1)} title="关闭">
              <X size={18} />
            </button>
          </div>
          <img src={active.href} alt={active.label || "image"} onClick={(event) => event.stopPropagation()} />
        </div>
      ) : null}
    </div>
  );
}

function MarkdownLink({ href, children, token, onOpenFilePath }) {
  const url = localFileUrl(href || "", token);
  const ref = parsePathReference(href || "");
  if (ref && onOpenFilePath) {
    return (
      <button className="message-path-link" type="button" onClick={() => onOpenFilePath(ref)}>
        {children}
      </button>
    );
  }
  return (
    <a className={cx("message-link", isArtifactPath(href) && "artifact-inline-link")} href={url} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function MarkdownCode({ inline, className, children, node, ...props }) {
  const code = String(children || "").replace(/\n$/, "");
  const match = /language-([A-Za-z0-9_-]+)/.exec(className || "");
  if (inline || (!match && !code.includes("\n"))) {
    return <code className={className} {...props}>{children}</code>;
  }
  return <CodeBlock code={code} language={match?.[1] || ""} />;
}

function ArtifactPreview({ artifact, onClose }) {
  if (!artifact) return null;
  const canInline = ["PDF", "Text"].includes(artifact.kind);
  return (
    <div className="artifact-preview-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="artifact-preview" onClick={(event) => event.stopPropagation()}>
        <div className="artifact-preview-head">
          <FileText size={17} />
          <span>
            <strong>{artifact.label}</strong>
            <small>{artifact.kind}</small>
          </span>
          <a href={artifact.href} target="_blank" rel="noreferrer" title="新窗口打开">
            <ExternalLink size={17} />
          </a>
          <a href={artifact.href} download={pathBaseName(artifact.raw)} title="下载文件">
            <Download size={17} />
          </a>
          <button type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
        {canInline ? (
          <iframe title={artifact.label} src={artifact.href} />
        ) : (
          <div className="artifact-preview-empty">
            <File size={34} />
            <strong>{artifact.kind} preview</strong>
            <p>浏览器不能直接预览时，可下载或在新窗口打开。</p>
          </div>
        )}
      </section>
    </div>
  );
}

function ArtifactList({ artifacts = [] }) {
  const [preview, setPreview] = useState(null);
  if (!artifacts.length) return null;
  return (
    <>
      <div className="artifact-list">
        {artifacts.map((item) => (
          <div className="artifact-card" key={item.raw}>
            <File size={17} />
            <span>
              <strong>{item.label}</strong>
              <small>{item.kind}</small>
            </span>
            <button type="button" onClick={() => setPreview(item)} title="预览">
              <Maximize2 size={15} />
            </button>
            <a href={item.href} target="_blank" rel="noreferrer" title="新窗口打开">
              <ExternalLink size={15} />
            </a>
          </div>
        ))}
      </div>
      <ArtifactPreview artifact={preview} onClose={() => setPreview(null)} />
    </>
  );
}

function MessageContent({ text, typing, token, typingKey = "", onOpenFilePath }) {
  const shown = useTypedText(text, Boolean(typing), typingKey);
  const markdown = normalizeMarkdownText(shown);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          a: ({ href, children }) => <MarkdownLink href={href} token={token} onOpenFilePath={onOpenFilePath}>{children}</MarkdownLink>,
          img: ({ src, alt }) => <MessageImage src={src} alt={alt} token={token} />,
          pre: ({ children }) => <>{children}</>,
          code: MarkdownCode,
          input: ({ checked, node, ...props }) => <input type="checkbox" checked={Boolean(checked)} readOnly {...props} />
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
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
  if (status === "queued" || status === "pending") return "queued";
  if (status === "approval_required") return "needs approval";
  if (status === "expired") return "expired";
  if (status === "rejected") return "rejected";
  if (status === "cancelled") return "cancelled";
  if (status === "cancelling") return "stopping";
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "done";
}

function commandMetaText(command) {
  return [
    command.namespace ? `${command.namespace}.${command.name || "tool"}` : command.name || "tool",
    command.callId ? `call ${command.callId}` : "",
    command.toolCallId ? `tool ${command.toolCallId}` : "",
    Number.isFinite(Number(command.exitCode)) ? `exit ${command.exitCode}` : ""
  ]
    .filter(Boolean)
    .join(" · ");
}

function CommandSummary({ commands = [], commandCount = 0, running = false }) {
  const [expanded, setExpanded] = useState(false);
  const visibleCommands = commands.filter((item) => item?.command);
  const count = Math.max(Number(commandCount || 0), visibleCommands.length);
  if (!count) return null;

  return (
    <div className="command-summary">
      <button className="command-toggle" type="button" onClick={() => setExpanded((value) => !value)}>
        <Terminal className="command-icon" size={16} aria-hidden="true" />
        <span>{running ? "正在运行" : "已运行"} {count} 条命令</span>
        {visibleCommands.length ? <ChevronRight className={cx("turn-chevron", expanded && "open")} size={16} aria-hidden="true" /> : null}
      </button>
      {expanded && visibleCommands.length ? (
        <div className="command-list">
          {visibleCommands.map((command, index) => (
            <section className="command-item" key={`${command.id || command.command}-${index}`}>
              <div className="command-item-head">
                <strong>{command.name || "command"}</strong>
                <span className={cx("command-status", command.status)}>{commandStatusLabel(command.status)}</span>
              </div>
              {commandMetaText(command) ? <div className="command-meta">{commandMetaText(command)}</div> : null}
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

function toolKindLabel(kind) {
  if (kind === "approval") return "审批";
  if (kind === "browser") return "浏览器";
  if (kind === "file") return "文件";
  if (kind === "git") return "Git";
  if (kind === "shell") return "命令";
  if (kind === "plugin") return "插件";
  return "工具";
}

function formatToolPayload(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Convert ANSI escape sequences to HTML spans.
 * Supports basic colors: 30-37 (foreground), 0 (reset), 1 (bold), 2 (dim).
 * Non-color control sequences stripped.
 */
function ansiToHtml(text) {
  if (!text) return "";
  const colorMap = { 31: "ansi-red", 32: "ansi-green", 33: "ansi-yellow", 34: "ansi-blue" };
  let html = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  html = html.replace(/\x1b\[(?:(\d+)(?:;(\d+))?)m/g, (_, code, code2) => {
    const codes = [code, code2].filter(Boolean).map(Number);
    const spans = codes.map((c) => {
      if (c === 0) return "</span>";
      if (c === 1) return `<span class="ansi-bold">`;
      if (c === 2) return `<span class="ansi-dim">`;
      if (colorMap[c]) return `<span class="${colorMap[c]}">`;
      return "";
    });
    return spans.filter(Boolean).join("");
  }).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""); // strip remaining CSI sequences
  // Close unclosed spans
  const openCount = (html.match(/<span/g) || []).length;
  const closeCount = (html.match(/<\/span>/g) || []).length;
  if (openCount > closeCount) html += "</span>".repeat(openCount - closeCount);
  return html;
}

function ToolCallCards({ toolCalls = [] }) {
  const [expanded, setExpanded] = useState({});
  const outputRefs = useRef({});
  const visibleTools = toolCalls.filter((item) => item?.name || item?.kind);
  if (!visibleTools.length) return null;

  // Auto-open running tool calls and scroll output
  const runningIds = visibleTools
    .filter((t) => t.status === "started" || t.status === "running")
    .map((t) => t.id || t.callId || t.toolCallId || `${t.name}-0`)
    .filter(Boolean);

  useEffect(() => {
    if (!runningIds.length) return;
    setExpanded((current) => {
      const next = { ...current };
      let changed = false;
      for (const id of runningIds) {
        if (!next[id]) { next[id] = true; changed = true; }
      }
      return changed ? next : current;
    });
  }, [runningIds.join(",")]);

  // Auto-scroll output area when new output arrives
  useEffect(() => {
    for (const tool of visibleTools) {
      const key = tool.id || tool.callId || tool.toolCallId || `${tool.name}-0`;
      const container = outputRefs.current[key];
      if (container) container.scrollTop = container.scrollHeight;
    }
  }, [visibleTools.map((t) => t.cursor).join(",")]);

  return (
    <div className="tool-call-list">
      {visibleTools.map((toolCall, index) => {
        const key = toolCall.id || toolCall.callId || toolCall.toolCallId || `${toolCall.name}-${index}`;
        const open = Boolean(expanded[key]);
        const input = formatToolPayload(toolCall.input);
        const output = formatToolPayload(toolCall.output);
        const isRunning = toolCall.status === "started" || toolCall.status === "running";
        const statusLabel = commandStatusLabel(toolCall.status);

        function outputEventsContent(events = []) {
          if (!events.length) {
            if (output) return <pre className="tool-call-output-text">{output}</pre>;
            return null;
          }
          return (
            <div className="tool-call-output" ref={(el) => { if (el) outputRefs.current[key] = el; }}>
              {events.map((ev, i) => (
                <div key={ev.cursor || i} className="tool-call-output-stream">
                  {ev.stream === "stderr" ? <span className="stderr-marker">stderr</span> : null}
                  <span className="output-text">{ev.payload?.text || ev.text || ""}</span>
                </div>
              ))}
            </div>
          );
        }

        return (
          <section className={cx("tool-call-card", toolCall.status)} key={key}>
            <button className="tool-call-head" type="button" onClick={() => setExpanded((current) => ({ ...current, [key]: !current[key] }))}>
              <Square size={13} />
              <strong>{toolCall.label || (toolCall.namespace ? `${toolCall.namespace}.${toolCall.name}` : toolCall.name || "tool")}</strong>
              <span>{toolKindLabel(toolCall.kind)}</span>
              <em className={cx("tool-status", toolCall.status)}>{statusLabel}</em>
              {isRunning ? <Loader2 size={12} className="spin" /> : null}
              <ChevronRight className={cx("turn-chevron", open && "open")} size={15} />
            </button>
            {open ? (
              <div className="tool-call-body">
                {toolCall.name || toolCall.permission || toolCall.risk ? (
                  <div className="tool-call-meta">
                    {toolCall.name ? <span>{toolCall.name}</span> : null}
                    {toolCall.permission ? <span>{toolCall.permission}</span> : null}
                    {toolCall.risk ? <span>risk: {toolCall.risk}</span> : null}
                  </div>
                ) : null}
                {input ? <pre>{input}</pre> : null}
                {outputEventsContent(toolCall.outputEvents)}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function Message({
  role,
  text,
  typing,
  typingKey = "",
  pending,
  token,
  durationMs,
  commands = [],
  commandCount = 0,
  toolCalls = [],
  toolCallCount = 0,
  commandRunning = false,
  running: commandsRunning = false,
  live = false,
  streaming = false,
  turnId = "",
  liveKey = "",
  messageKey = "",
  located = false,
  onEdit,
  onDelete,
  onRegenerate,
  onLocate,
  onOpenFilePath
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const displayText = role === "user" ? stripUserAttachmentMetadata(text) : text;
  const label = role === "user" ? "You" : role === "assistant" ? "Agent" : role === "error" ? "Error" : "System";
  const durationLabel = role === "assistant" ? formatDurationMs(durationMs) : "";
  const artifacts = pending ? [] : extractArtifactLinks(displayText, token);
  const galleryImages = pending ? [] : extractImageLinks(displayText, token);
  const preview = compact(displayText, "").slice(0, 180);
  const operationMessage = { role, text, turnId, liveKey, pending, live };
  const canOperate = !pending && !live;
  const canEdit = canOperate && role === "user" && Boolean(onEdit);
  const canRegenerate = canOperate && role === "assistant" && Boolean(onRegenerate);
  const canDelete = canOperate && !isSystemMessage({ role }) && Boolean(onDelete);

  useEffect(() => {
    if (!editing) setDraft(displayText);
  }, [displayText, editing]);

  if ((!text && !commands.length && !toolCalls.length) || role === "debug" || (!displayText && !commands.length && !toolCalls.length)) return null;

  async function copyMessage() {
    await copyText(displayText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  function startEditing() {
    setDraft(displayText);
    setCollapsed(false);
    setEditing(true);
  }

  function saveEdit() {
    const nextText = draft.trim();
    if (!nextText) return;
    onEdit?.(operationMessage, nextText);
    setEditing(false);
  }

  return (
    <article
      className={cx("message", role === "assistant" ? "assistant" : role, pending && "pending", live && "live", streaming && "streaming", located && "located")}
      data-message-key={messageKey}
    >
      {durationLabel ? (
        <div className="turn-meta">
          <span>已处理 {durationLabel}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </div>
      ) : null}
      <div className="message-topline">
        <div className="message-role">{live ? `${label} · live` : label}</div>
        <div className="message-actions">
          <button type="button" onClick={copyMessage} title="复制消息">
            {copied ? <CheckSquare size={14} /> : <Copy size={14} />}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
          <button type="button" onClick={() => onLocate?.(messageKey)} title="定位消息">
            <LocateFixed size={14} />
            <span>定位</span>
          </button>
          {canEdit ? (
            <button type="button" onClick={startEditing} title="编辑消息">
              <Pencil size={14} />
              <span>编辑</span>
            </button>
          ) : null}
          {canRegenerate ? (
            <button type="button" onClick={() => onRegenerate?.(operationMessage)} title="重新生成">
              <RotateCcw size={14} />
              <span>重试</span>
            </button>
          ) : null}
          {canDelete ? (
            <button type="button" onClick={() => onDelete?.(operationMessage)} title="删除消息">
              <Trash2 size={14} />
              <span>删除</span>
            </button>
          ) : null}
          <button type="button" onClick={() => setCollapsed((value) => !value)} title={collapsed ? "展开消息" : "折叠消息"}>
            {collapsed ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
            <span>{collapsed ? "展开" : "折叠"}</span>
          </button>
        </div>
      </div>
      <div className="message-bubble">
        {collapsed ? (
          <div className="message-collapsed">{preview || "已折叠"}</div>
        ) : pending ? (
          <ThinkingIndicator text={displayText} />
        ) : editing ? (
          <div className="message-editor">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={Math.min(10, Math.max(3, draft.split(/\r?\n/).length))} />
            <div className="message-editor-actions">
              <button type="button" onClick={() => setEditing(false)}>取消</button>
              <button type="button" onClick={saveEdit} disabled={!draft.trim()}>保存</button>
            </div>
          </div>
        ) : (
          <>
            <MessageContent text={displayText} typing={typing && !live} typingKey={typingKey || messageKey} token={token} onOpenFilePath={onOpenFilePath} />
            {live && streaming ? <span className="typing-caret live-stream-caret" aria-hidden="true" /> : null}
            <ImageGallery images={galleryImages} />
            <ArtifactList artifacts={artifacts} />
          </>
        )}
      </div>
      {role === "assistant" ? <CommandSummary commands={commands} commandCount={commandCount} running={commandRunning || commandsRunning} /> : null}
      {role === "assistant" ? <ToolCallCards toolCalls={toolCalls} toolCallCount={toolCallCount} /> : null}
    </article>
  );
}

function parseDiffHeaderPath(value = "") {
  const clean = String(value || "").trim();
  if (clean === "/dev/null") return "";
  return clean.replace(/^(a|b)\//, "").replace(/^"|"$/g, "");
}

function parseUnifiedDiff(diff = "") {
  const files = [];
  let current = null;
  let currentHunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of String(diff || "").split(/\r?\n/)) {
    const fileMatch = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      current = {
        oldPath: fileMatch[1],
        path: fileMatch[2],
        status: "M",
        additions: 0,
        deletions: 0,
        hunks: []
      };
      files.push(current);
      currentHunk = null;
      continue;
    }

    if (!current) continue;
    if (/^new file mode\b/.test(rawLine)) current.status = "A";
    if (/^deleted file mode\b/.test(rawLine)) current.status = "D";
    if (/^rename from\b/.test(rawLine)) current.status = "R";
    if (rawLine.startsWith("--- ")) {
      current.oldPath = parseDiffHeaderPath(rawLine.slice(4)) || current.oldPath;
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      current.path = parseDiffHeaderPath(rawLine.slice(4)) || current.path;
      continue;
    }

    const hunkMatch = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]) || 0;
      newLine = Number(hunkMatch[2]) || 0;
      currentHunk = {
        header: rawLine,
        lines: []
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;
    const prefix = rawLine[0] || " ";
    const body = rawLine.slice(1);
    if (prefix === "+") {
      current.additions += 1;
      currentHunk.lines.push({ type: "add", oldLine: "", newLine: newLine++, text: body });
    } else if (prefix === "-") {
      current.deletions += 1;
      currentHunk.lines.push({ type: "del", oldLine: oldLine++, newLine: "", text: body });
    } else if (prefix === "\\") {
      currentHunk.lines.push({ type: "meta", oldLine: "", newLine: "", text: rawLine });
    } else {
      currentHunk.lines.push({ type: "ctx", oldLine: oldLine++, newLine: newLine++, text: body });
    }
  }

  return files;
}

function mergeChangeFiles(summaryFiles = [], diffFiles = []) {
  const byPath = new Map();
  for (const file of diffFiles) {
    const key = file.path || file.oldPath;
    byPath.set(key, { ...file });
  }
  for (const file of summaryFiles || []) {
    const key = file.path || file.oldPath;
    if (!key) continue;
    byPath.set(key, {
      ...(byPath.get(key) || {}),
      ...file,
      path: file.path || byPath.get(key)?.path || key,
      oldPath: file.oldPath || byPath.get(key)?.oldPath || file.path || key
    });
  }
  return [...byPath.values()];
}

function workspaceFilePath(root, relPath) {
  const base = String(root || "").replace(/[\\/]+$/, "");
  const rel = String(relPath || "").replace(/^[\\/]+/, "");
  if (!base) return rel;
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base}${separator}${rel.replace(/[\\/]+/g, separator)}`;
}

function filePatchText(file) {
  if (!file) return "";
  const pathLabel = file.path || file.oldPath || "file";
  const hunks = Array.isArray(file.hunks) ? file.hunks : [];
  if (!hunks.length) return file.preview || pathLabel;
  const lines = [`--- ${file.oldPath || pathLabel}`, `+++ ${file.path || pathLabel}`];
  for (const hunk of hunks) {
    lines.push(hunk.header || "");
    for (const line of hunk.lines || []) {
      const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : line.type === "meta" ? "\\" : " ";
      lines.push(`${prefix}${line.text || ""}`);
    }
  }
  return lines.filter((line) => line !== null && line !== undefined).join("\n");
}

function DiffLine({ line }) {
  return (
    <div className={cx("diff-line", line.type)}>
      <span className="diff-gutter">{line.oldLine}</span>
      <span className="diff-gutter">{line.newLine}</span>
      <code>{line.type === "add" ? "+" : line.type === "del" ? "-" : line.type === "meta" ? "\\" : " "}{line.text}</code>
    </div>
  );
}

function DiffViewer({ file }) {
  if (!file?.hunks?.length) {
    return <div className="change-empty">这个文件当前没有可显示的 patch，可能是二进制文件或未跟踪文件超过预览限制。</div>;
  }
  return (
    <div className="diff-viewer">
      {file.hunks.map((hunk, index) => (
        <section className="diff-hunk" key={`${file.path}-${index}`}>
          <div className="diff-hunk-head">{hunk.header}</div>
          <div className="diff-lines">
            {hunk.lines.slice(0, 480).map((line, lineIndex) => <DiffLine line={line} key={`${index}-${lineIndex}`} />)}
            {hunk.lines.length > 480 ? <div className="diff-truncated">已截断 {hunk.lines.length - 480} 行，完整 diff 仍保留在 API 响应中。</div> : null}
          </div>
        </section>
      ))}
    </div>
  );
}

function ChangeCard({ summary, token, onUpdated, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [activePath, setActivePath] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState("");
  const [copiedPatch, setCopiedPatch] = useState(false);
  const diffFiles = useMemo(() => parseUnifiedDiff(summary?.diff || ""), [summary?.diff]);
  const files = useMemo(() => mergeChangeFiles(summary?.files || [], diffFiles), [summary?.files, diffFiles]);
  const activeFile = files.find((file) => (file.path || file.oldPath) === activePath) || files[0] || null;
  const additions = files.reduce((sum, file) => sum + Number(file.additions || 0), 0);
  const deletions = files.reduce((sum, file) => sum + Number(file.deletions || 0), 0);
  const title = summary?.kind === "workspace" ? "Workspace changes" : "Task changes";
  const workspaceId = summary?.workspace?.id || "";
  const activeKey = activeFile?.path || activeFile?.oldPath || "";
  const activeFullPath = workspaceFilePath(summary?.cwd || summary?.workspace?.path || "", activeKey);
  const canMutate = Boolean(workspaceId && activeKey && summary?.kind === "workspace");

  useEffect(() => {
    if (!files.length) {
      setActivePath("");
      return;
    }
    if (!files.some((file) => (file.path || file.oldPath) === activePath)) setActivePath(files[0].path || files[0].oldPath);
  }, [files, activePath]);

  if (!summary) return null;

  async function copyActivePatch() {
    await copyText(filePatchText(activeFile));
    setCopiedPatch(true);
    setTimeout(() => setCopiedPatch(false), 1200);
  }

  async function runFileAction(action) {
    if (!canMutate) return;
    if (action === "reject" && !window.confirm(`Reject changes in ${activeKey}?`)) return;
    const actionKey = `${action}:${activeKey}`;
    setBusyAction(actionKey);
    setNotice("");
    try {
      const result = await request(
        `/api/workspaces/${workspaceId}/git/file-action`,
        {
          method: "POST",
          body: JSON.stringify({ path: activeKey, action })
        },
        token
      );
      setNotice(action === "accept" ? "已接受并暂存该文件" : "已拒绝并还原该文件");
      onUpdated?.(result);
    } catch (err) {
      setNotice(err.message || "文件操作失败");
      onError?.(err.message || "文件操作失败");
    } finally {
      setBusyAction("");
    }
  }

  async function stageAll() {
    if (!workspaceId) return;
    setBusyAction("stage-all");
    setNotice("");
    try {
      const result = await request(
        `/api/workspaces/${workspaceId}/git/action`,
        {
          method: "POST",
          body: JSON.stringify({ action: "stage-all" })
        },
        token
      );
      setNotice("已暂存全部变更");
      onUpdated?.(result);
    } catch (err) {
      setNotice(err.message || "暂存失败");
      onError?.(err.message || "暂存失败");
    } finally {
      setBusyAction("");
    }
  }

  return (
    <section className="change-card">
      <div className="change-card-head">
        <div>
          <h3>{title}</h3>
          <p>{summary.workspace?.title || summary.workspace?.path || summary.cwd || ""}</p>
        </div>
        <div className="change-actions">
          <span className={cx("change-pill", summary.ok ? "ready" : "waiting")}>{summary.ok ? "Ready" : "Unavailable"}</span>
          {canMutate && files.length ? (
            <button className="change-expand" type="button" disabled={Boolean(busyAction)} onClick={stageAll}>
              <CheckSquare size={14} />
              {busyAction === "stage-all" ? "暂存中" : "全部暂存"}
            </button>
          ) : null}
          {summary.diff ? (
            <button className="change-expand" type="button" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收起 diff" : "查看 diff"}
              <ChevronRight className={cx("turn-chevron", expanded && "open")} size={15} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="change-metrics">
        <span>{summary.changedCount ?? summary.fileCount ?? files.length} files</span>
        <span>{summary.lineCount || 0} diff lines</span>
        {additions || deletions ? <span className="change-plus-minus">+{additions} -{deletions}</span> : null}
        {summary.branch ? <span>{summary.branch}</span> : null}
      </div>
      {files.length ? (
        <div className="change-files">
          {files.slice(0, expanded ? files.length : 8).map((file, index) => {
            const key = file.path || file.oldPath || `${index}`;
            return (
              <button className={cx("change-file", activeFile && key === (activeFile.path || activeFile.oldPath) && "active")} type="button" key={`${key}-${index}`} onClick={() => {
                setActivePath(key);
                setExpanded(true);
              }}>
                <span>{file.status || "M"}</span>
                <strong>{key}</strong>
                <small>+{file.additions || 0} -{file.deletions || 0}</small>
              </button>
            );
          })}
          {!expanded && files.length > 8 ? <div className="change-more">{files.length - 8} more files</div> : null}
        </div>
      ) : (
        <div className="change-empty">{summary.stderr || summary.error || "No workspace diff"}</div>
      )}
      {expanded && activeFile ? (
        <div className="change-diff-panel">
          <div className="change-diff-head">
            <strong>{activeFile.path || activeFile.oldPath}</strong>
            <div className="change-diff-actions">
              <span>+{activeFile.additions || 0} -{activeFile.deletions || 0}</span>
              <button type="button" onClick={copyActivePatch} title="复制 patch">
                {copiedPatch ? <CheckSquare size={14} /> : <Copy size={14} />}
                {copiedPatch ? "已复制" : "复制"}
              </button>
              {activeFullPath ? (
                <a href={localFileUrl(activeFullPath, token)} target="_blank" rel="noreferrer" title="打开文件">
                  <ExternalLink size={14} />
                  打开
                </a>
              ) : null}
              {canMutate ? (
                <>
                  <button type="button" disabled={Boolean(busyAction)} onClick={() => runFileAction("accept")} title="接受并暂存该文件">
                    <CheckSquare size={14} />
                    {busyAction === `accept:${activeKey}` ? "处理中" : "接受"}
                  </button>
                  <button type="button" disabled={Boolean(busyAction)} onClick={() => runFileAction("reject")} title="拒绝并还原该文件">
                    <X size={14} />
                    {busyAction === `reject:${activeKey}` ? "处理中" : "拒绝"}
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <DiffViewer file={activeFile} />
        </div>
      ) : null}
      {notice ? <div className="change-notice">{notice}</div> : null}
    </section>
  );
}

function WorkspaceWorkbench({
  workspaces = [],
  selected,
  token,
  toolEvents = [],
  onError,
  onSummary,
  onToolEventsChanged,
  openRequest,
  onOpenHandled
}) {
  const defaultWorkspace = useMemo(() => chooseWorkspaceForPath(workspaces, selected?.cwd || ""), [workspaces, selected?.cwd]);
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspace?.id || "");
  const [tree, setTree] = useState({ dir: "", items: [] });
  const [file, setFile] = useState(null);
  const [activeTab, setActiveTab] = useState("files");
  const [terminalCommand, setTerminalCommand] = useState("git status --short --branch");
  const [terminalResult, setTerminalResult] = useState(null);
  const [testCommand, setTestCommand] = useState("npm test");
  const [testResult, setTestResult] = useState(null);
  const [commitMessage, setCommitMessage] = useState("Update project files");
  const [busy, setBusy] = useState("");
  const [runningCommand, setRunningCommand] = useState(null);
  const [panelCollapsed, setPanelCollapsed] = useState(() => {
    if (typeof localStorage === "undefined") return true;
    const stored = localStorage.getItem("mat.workspace.collapsed");
    if (stored === "0") return false;
    return true; // 默认收起
  });

  function togglePanelCollapsed() {
    setPanelCollapsed((current) => {
      const next = !current;
      try { localStorage.setItem("mat.workspace.collapsed", next ? "1" : "0"); } catch {}
      return next;
    });
  }

  const workspace = workspaces.find((item) => item.id === workspaceId) || defaultWorkspace || workspaces[0] || null;
  const activeWorkspaceId = workspace?.id || "";
  const activeTaskId = selected?.kind === "task" ? selected.id : "";

  useEffect(() => {
    if (!workspaceId && defaultWorkspace?.id) setWorkspaceId(defaultWorkspace.id);
  }, [workspaceId, defaultWorkspace?.id]);

  useEffect(() => {
    if (!activeWorkspaceId || activeTab !== "files") return;
    loadTree(tree.dir || "").catch((err) => onError?.(err.message));
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!openRequest?.path || !activeWorkspaceId) return;
    openWorkspacePath(openRequest.path, openRequest.line || 0).catch((err) => onError?.(err.message));
    if (panelCollapsed) {
      setPanelCollapsed(false);
      try { localStorage.setItem("mat.workspace.collapsed", "0"); } catch {}
    }
    onOpenHandled?.();
  }, [openRequest?.id, activeWorkspaceId, panelCollapsed]);

  useEffect(() => {
    if (!runningCommand?.toolRunId) return;
    const events = toolEvents.filter((event) => event.toolRunId === runningCommand.toolRunId);
    if (!events.length) return;
    const current = runningCommand.kind === "test" ? testResult : terminalResult;
    const next = resultFromToolRunEvents(events, {
      ...(current || {}),
      command: runningCommand.command,
      toolRunId: runningCommand.toolRunId
    });
    if (runningCommand.kind === "test") setTestResult(next);
    else setTerminalResult(next);
    if (["completed", "failed", "cancelled"].includes(next.status)) {
      setRunningCommand(null);
    }
  }, [toolEvents, runningCommand?.toolRunId]);

  useEffect(() => {
    if (!runningCommand?.toolRunId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await request(`/api/tool-runs/${encodeURIComponent(runningCommand.toolRunId)}?limit=1000`, {}, token);
        if (cancelled) return;
        const current = runningCommand.kind === "test" ? testResult : terminalResult;
        const next = resultFromToolRunEvents(result.events || [], {
          ...(current || {}),
          ...(result.toolRun?.result || {}),
          command: runningCommand.command,
          toolRunId: runningCommand.toolRunId,
          status: result.toolRun?.status || current?.status || "running"
        });
        if (runningCommand.kind === "test") setTestResult(next);
        else setTerminalResult(next);
        if (["completed", "failed", "cancelled"].includes(next.status)) {
          setRunningCommand(null);
        }
      } catch (err) {
        if (!cancelled) onError?.(err.message);
      }
    };
    const timer = setInterval(load, 1200);
    load();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runningCommand?.toolRunId]);

  if (!workspaces.length) return null;

  async function loadTree(dir = "") {
    if (!activeWorkspaceId) return;
    const result = await request(`/api/workspaces/${activeWorkspaceId}/tree?dir=${encodeURIComponent(dir)}`, {}, token);
    setTree({ dir: result.dir || "", items: result.items || [] });
  }

  async function openFile(pathValue, line = 0) {
    if (!activeWorkspaceId || !pathValue) return;
    setBusy(`file:${pathValue}`);
    try {
      const result = await request(`/api/workspaces/${activeWorkspaceId}/file?path=${encodeURIComponent(pathValue)}`, {}, token);
      setFile({ ...result, line });
      setActiveTab("files");
      window.setTimeout(() => {
        if (line > 0) {
          document.querySelector(`[data-file-line="${line}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 80);
    } finally {
      setBusy("");
    }
  }

  async function openWorkspacePath(pathValue, line = 0) {
    const normalized = String(pathValue || "").replaceAll("\\", "/");
    const root = String(workspace?.path || "").replaceAll("\\", "/").replace(/\/+$/, "");
    const rel = root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      ? normalized.slice(root.length + 1)
      : normalized.replace(/^\/+/, "");
    await openFile(rel, line);
  }

  async function refreshGitSummary() {
    if (!activeWorkspaceId) return null;
    const [status, diff] = await Promise.all([
      request(`/api/workspaces/${activeWorkspaceId}/git/status`, {}, token),
      request(`/api/workspaces/${activeWorkspaceId}/git/diff`, {}, token)
    ]);
    const summary = {
      ...diff,
      branch: status.branch || diff.branch || "",
      files: diff.files?.length ? diff.files : status.files || [],
      changedCount: status.changedCount ?? diff.fileCount ?? diff.files?.length ?? 0,
      statusFiles: status.files || [],
      kind: "workspace",
      cwd: workspace?.path || diff.cwd || "",
      workspace: diff.workspace || status.workspace || workspace
    };
    onSummary?.(summary);
    return summary;
  }

  async function runGitAction(action) {
    if (!activeWorkspaceId) return;
    const payload = { action };
    if (action === "commit") payload.message = commitMessage;
    setBusy(action);
    try {
      const result = await request(
        `/api/workspaces/${activeWorkspaceId}/git/action`,
        { method: "POST", body: JSON.stringify(payload) },
        token
      );
      onSummary?.({
        ...result.summary,
        workspace: result.workspace || workspace,
        cwd: result.cwd || workspace?.path || "",
        kind: "workspace"
      });
      setTerminalResult({
        ok: true,
        command: `git ${action}`,
        stdout: result.stdout || "",
        stderr: result.stderr || ""
      });
      onToolEventsChanged?.();
    } catch (err) {
      onError?.(err.message);
      setTerminalResult({ ok: false, command: `git ${action}`, stderr: err.message });
      onToolEventsChanged?.();
    } finally {
      setBusy("");
    }
  }

  async function runTerminal(kind = "terminal") {
    if (!activeWorkspaceId) return;
    const command = kind === "test" ? testCommand : terminalCommand;
    if (!command.trim()) return;
    setBusy(kind);
    const payload = { command, kind, taskId: activeTaskId, timeoutMs: kind === "test" ? 180000 : 120000, background: true };
    try {
      const result = await request(
        `/api/workspaces/${activeWorkspaceId}/command`,
        { method: "POST", body: JSON.stringify(payload) },
        token
      );
      if (result.background && result.toolRunId) {
        const pending = { ok: null, command, stdout: "", stderr: "", status: "running", toolRunId: result.toolRunId };
        setRunningCommand({ kind, toolRunId: result.toolRunId, command });
        if (kind === "test") setTestResult(pending);
        else setTerminalResult(pending);
        onToolEventsChanged?.();
        return;
      }
      if (kind === "test") setTestResult(result);
      else setTerminalResult(result);
      onToolEventsChanged?.();
    } catch (err) {
      if (err.status === 428) {
        const approvalId = err.data?.approvalId || err.data?.approval?.id || "";
        const reason = commandApprovalText(err) || err.data?.approval?.reason || "this command may mutate files, system state, or execute remote code";
        const approved = window.confirm(`Approve this workspace command?\n\n${command}\n\n${reason}`);
        if (!approved) {
          if (approvalId) {
            try {
              await request(
                `/api/approvals/${encodeURIComponent(approvalId)}/decision`,
                { method: "POST", body: JSON.stringify({ decision: "deny", reason: "Denied in workspace panel." }) },
                token
              );
            } catch {
              // The visible result below is more important than surfacing a denial sync failure here.
            }
          }
          const result = { ok: false, command, stderr: `Command was not run because approval was denied: ${reason}` };
          if (kind === "test") setTestResult(result);
          else setTerminalResult(result);
          onToolEventsChanged?.();
          return;
        }
        try {
          if (!approvalId) throw new Error("Approval request was not returned by the server.");
          const approvedResponse = await request(
            `/api/approvals/${encodeURIComponent(approvalId)}/decision`,
            { method: "POST", body: JSON.stringify({ decision: "approve", reason: "Approved in workspace panel." }) },
            token
          );
          const result = approvedResponse.result || approvedResponse;
          if (approvedResponse.background && approvedResponse.toolRunId) {
            const pending = { ok: null, command, stdout: "", stderr: "", status: "running", toolRunId: approvedResponse.toolRunId };
            setRunningCommand({ kind, toolRunId: approvedResponse.toolRunId, command });
            if (kind === "test") setTestResult(pending);
            else setTerminalResult(pending);
            onToolEventsChanged?.();
            return;
          }
          if (kind === "test") setTestResult(result);
          else setTerminalResult(result);
          onToolEventsChanged?.();
          return;
        } catch (approvedErr) {
          onError?.(approvedErr.message);
          const result = { ok: false, command, stderr: approvedErr.message };
          if (kind === "test") setTestResult(result);
          else setTerminalResult(result);
          onToolEventsChanged?.();
          return;
        }
      }
      onError?.(err.message);
      const result = { ok: false, command, stderr: err.message };
      if (kind === "test") setTestResult(result);
      else setTerminalResult(result);
      onToolEventsChanged?.();
    } finally {
      setBusy("");
    }
  }

  async function stopWorkspaceCommand() {
    if (!runningCommand?.toolRunId) return;
    setBusy(`stop:${runningCommand.kind}`);
    try {
      await request(
        `/api/tool-runs/${encodeURIComponent(runningCommand.toolRunId)}/stop`,
        { method: "POST", body: JSON.stringify({ reason: "Stopped from workspace panel." }) },
        token
      );
      const stopped = { ok: false, command: runningCommand.command, stderr: "Stop requested.", status: "stopping", toolRunId: runningCommand.toolRunId };
      if (runningCommand.kind === "test") setTestResult((current) => ({ ...(current || stopped), ...stopped }));
      else setTerminalResult((current) => ({ ...(current || stopped), ...stopped }));
      setRunningCommand(null);
      onToolEventsChanged?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy("");
    }
  }

  const fileLines = file?.text ? file.text.split(/\r?\n/) : [];
  const pathLabel = file?.path || "";
  const parentDir = tree.dir ? tree.dir.split("/").slice(0, -1).join("/") : "";
  const commandOutput = [terminalResult?.stdout, terminalResult?.stderr].filter(Boolean).join("\n");
  const testOutput = [testResult?.stdout, testResult?.stderr].filter(Boolean).join("\n");

  return (
    <section className={cx("workspace-panel", panelCollapsed && "collapsed")}>
      <div className="workspace-panel-head">
        <div>
          <h3>Workspace</h3>
          <p>{workspace?.title || workspace?.path || "Select a workspace"}</p>
        </div>
        <div className="workspace-panel-actions">
          {panelCollapsed ? null : (
            <select value={activeWorkspaceId} onChange={(event) => {
              setWorkspaceId(event.target.value);
              setTree({ dir: "", items: [] });
              setFile(null);
            }}>
              {workspaces.map((item) => <option value={item.id} key={item.id}>{item.title || item.path}</option>)}
            </select>
          )}
          {panelCollapsed ? null : (
            <button type="button" onClick={() => refreshGitSummary().catch((err) => onError?.(err.message))}>
              <RefreshCw size={14} />
              刷新
            </button>
          )}
          <button type="button" className="workspace-collapse-toggle" title={panelCollapsed ? "展开工作区" : "收起工作区"} aria-label={panelCollapsed ? "展开工作区" : "收起工作区"} onClick={togglePanelCollapsed}>
            {panelCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
      </div>
      {panelCollapsed ? null : (
        <>
          <div className="workspace-tabs">
            {[
              ["files", "文件树", FolderOpen],
              ["git", "Git", CheckSquare],
              ["terminal", "终端", Terminal],
              ["tests", "测试", Target]
            ].map(([key, label, Icon]) => (
              <button type="button" className={cx(activeTab === key && "active")} onClick={() => setActiveTab(key)} key={key}>
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>

      {activeTab === "files" ? (
        <div className="workspace-files-layout">
          <div className="workspace-file-tree">
            <div className="workspace-path-row">
              <button type="button" disabled={!tree.dir} onClick={() => loadTree(parentDir).catch((err) => onError?.(err.message))}>
                <ChevronLeft size={14} />
              </button>
              <span>{tree.dir || "."}</span>
            </div>
            <div className="workspace-tree-list">
              {tree.items.map((item) => (
                <button type="button" className="workspace-tree-item" key={item.path} onClick={() => {
                  if (item.type === "directory") loadTree(item.path).catch((err) => onError?.(err.message));
                  else openFile(item.path).catch((err) => onError?.(err.message));
                }}>
                  {item.type === "directory" ? <Folder size={15} /> : <FileText size={15} />}
                  <span>{item.name}</span>
                  <small>{item.type === "file" ? formatBytes(item.size) : ""}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="workspace-file-viewer">
            {file ? (
              <>
                <div className="workspace-file-head">
                  <strong>{pathLabel}</strong>
                  <a href={localFileUrl(file.absolutePath, token)} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} />
                    打开
                  </a>
                </div>
                {file.binary ? (
                  <div className="workspace-empty">二进制或过大的文件暂不内嵌预览。</div>
                ) : (
                  <pre className="workspace-code-view">
                    {fileLines.map((line, index) => {
                      const number = index + 1;
                      return (
                        <div className={cx("workspace-code-line", file.line === number && "located")} data-file-line={number} key={number}>
                          <span>{number}</span>
                          <code>{line || " "}</code>
                        </div>
                      );
                    })}
                  </pre>
                )}
              </>
            ) : (
              <div className="workspace-empty">选择左侧文件进行预览。</div>
            )}
          </div>
        </div>
      ) : null}

      {activeTab === "git" ? (
        <div className="workspace-git-panel">
          <div className="workspace-git-actions">
            <button type="button" disabled={Boolean(busy)} onClick={() => runGitAction("stage-all")}>Stage all</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => runGitAction("unstage-all")}>Unstage all</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => runGitAction("pull")}>Pull</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => runGitAction("push")}>Push</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => runGitAction("pr")}>PR</button>
          </div>
          <div className="workspace-commit-row">
            <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Commit message" />
            <button type="button" disabled={Boolean(busy) || !commitMessage.trim()} onClick={() => runGitAction("commit")}>
              Commit
            </button>
          </div>
        </div>
      ) : null}

      {activeTab === "terminal" ? (
        <div className="workspace-command-panel">
          <div className="workspace-command-row">
            <input value={terminalCommand} onChange={(event) => setTerminalCommand(event.target.value)} />
            <button type="button" disabled={busy === "terminal"} onClick={() => runTerminal("terminal")}>
              <Terminal size={14} />
              运行
            </button>
            {runningCommand?.kind === "terminal" ? (
              <button type="button" className="danger" disabled={busy === "stop:terminal"} onClick={stopWorkspaceCommand}>
                <Square size={14} />
                停止
              </button>
            ) : null}
          </div>
          <pre className={cx("workspace-command-output", terminalResult?.ok === false && "failed")} dangerouslySetInnerHTML={{ __html: ansiToHtml(commandOutput) || "No command output yet." }}></pre>
          {runningCommand?.kind === "terminal" ? <small className="workspace-command-run workspace-command-running">⏳ running ({runningCommand.command?.slice(0, 40)})</small> : null}
          {!runningCommand && terminalResult?.toolRunId ? <small className="workspace-command-run">tool run {terminalResult.toolRunId.slice(0, 8)} · output streams through tool events</small> : null}
        </div>
      ) : null}

      {activeTab === "tests" ? (
        <div className="workspace-command-panel">
          <div className="workspace-command-row">
            <input value={testCommand} onChange={(event) => setTestCommand(event.target.value)} />
            <button type="button" disabled={busy === "test"} onClick={() => runTerminal("test")}>
              <Target size={14} />
              测试
            </button>
            {runningCommand?.kind === "test" ? (
              <button type="button" className="danger" disabled={busy === "stop:test"} onClick={stopWorkspaceCommand}>
                <Square size={14} />
                停止
              </button>
            ) : null}
          </div>
          {testResult?.test ? (
            <div className={cx("test-summary", testResult.test.ok ? "ok" : "failed")}>
              <span>{testResult.test.ok ? "通过" : "失败"}</span>
              <span>{testResult.test.passed || 0} passed</span>
              <span>{testResult.test.failed || 0} failed</span>
            </div>
          ) : null}
          {testResult?.test?.failures?.length ? (
            <details className="test-failures" open>
              <summary>失败定位</summary>
              {testResult.test.failures.map((item, index) => {
                const ref = parsePathReference(item);
                return (
                  <button type="button" key={`${item}-${index}`} onClick={() => ref ? openWorkspacePath(ref.path, ref.line).catch((err) => onError?.(err.message)) : null}>
                    {item}
                  </button>
                );
              })}
            </details>
          ) : null}
          <details className="workspace-log-details" open={!testResult?.test?.ok}>
            <summary>日志</summary>
            <pre className={cx("workspace-command-output", testResult?.ok === false && "failed")} dangerouslySetInnerHTML={{ __html: ansiToHtml(testOutput) || "No test output yet." }}></pre>
          </details>
          {testResult?.toolRunId ? <small className="workspace-command-run">tool run {testResult.toolRunId.slice(0, 8)} · output streams through tool events</small> : null}
        </div>
      ) : null}
        </>
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
  const params = new URLSearchParams(location.search);
  const [pairingSession, setPairingSession] = useState(() => {
    const id = params.get("pair") || "";
    const code = params.get("code") || "";
    return id ? { id, code, status: "pending" } : null;
  });
  const [pairingQrSvg, setPairingQrSvg] = useState("");
  const [pairingUrl, setPairingUrl] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);

  function completeLogin(result) {
    const nextToken = result.token || pairingToken;
    localStorage.setItem("mat.token", nextToken);
    onLogin(nextToken);
  }

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
      completeLogin(result);
    } catch (err) {
      setError(err.message);
    }
  }

  async function createPairing() {
    setPairingBusy(true);
    setError("");
    try {
      const result = await request(
        "/api/pairing-sessions",
        {
          method: "POST",
          auth: false,
          body: JSON.stringify({ deviceLabel: navigator.userAgent || "Browser" })
        },
        ""
      );
      setPairingSession({ ...result.session, code: result.session.code });
      setPairingQrSvg(result.qrSvg || "");
      setPairingUrl(result.pairingUrl || "");
    } catch (err) {
      setError(err.message);
    } finally {
      setPairingBusy(false);
    }
  }

  async function claimPairing(session = pairingSession) {
    if (!session?.id || !session?.code) return;
    try {
      const result = await request(
        `/api/pairing-sessions/${encodeURIComponent(session.id)}/claim`,
        {
          method: "POST",
          auth: false,
          body: JSON.stringify({ code: session.code, deviceLabel: navigator.userAgent || "Browser" })
        },
        ""
      );
      completeLogin(result);
    } catch (err) {
      if (err.status !== 409) setError(err.message);
    }
  }

  useEffect(() => {
    if (!pairingSession?.id) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await request(`/api/pairing-sessions/${encodeURIComponent(pairingSession.id)}`, { auth: false }, "");
        if (cancelled) return;
        setPairingSession((current) => ({ ...(current || {}), ...(result.session || {}), code: current?.code || pairingSession.code || "" }));
        if (result.session?.status === "approved") await claimPairing({ ...result.session, code: pairingSession.code });
      } catch (err) {
        if (!cancelled && err.status !== 404) setError(err.message);
      }
    };
    poll().catch(() => {});
    const timer = setInterval(() => {
      poll().catch(() => {});
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pairingSession?.id, pairingSession?.code]);

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
        <div className="pairing-card">
          <div>
            <strong>QR pairing</strong>
            <small>{pairingSession ? `Status: ${pairingSession.status || "pending"}` : "Create a short-lived pairing session, then approve it from an existing device."}</small>
          </div>
          {pairingQrSvg ? <div className="qr-box" dangerouslySetInnerHTML={{ __html: pairingQrSvg }} /> : null}
          {pairingSession?.code ? <code className="pairing-code">{pairingSession.code}</code> : null}
          {pairingUrl ? <small className="pairing-url">{pairingUrl}</small> : null}
          <button className="secondary-button" type="button" onClick={createPairing} disabled={pairingBusy}>
            {pairingBusy ? "Creating..." : "Create pairing QR"}
          </button>
          {pairingSession?.id && pairingSession?.code ? (
            <button className="secondary-button" type="button" onClick={() => claimPairing()}>
              Claim after approval
            </button>
          ) : null}
        </div>
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
  const agentOptions = isDesktop && !providers.includes("codex") ? ["codex", ...providers] : providers;
  const modelAgent = isDesktop ? "codex" : activeAgent;

  useEffect(() => {
    if (text.trim()) localStorage.setItem("mat.composerDraft", text);
    else localStorage.removeItem("mat.composerDraft");
  }, [text]);

  function attachmentPromptText(item, { display = false } = {}) {
    if (item.kind === "workspace") {
      return display ? `Attached workspace context: ${item.name}` : item.prompt || "";
    }

    const fileUrl = item.url || item.path;
    const markdown = item.kind === "image" ? `![${item.name}](${fileUrl})` : `[${item.name}](${fileUrl})`;
    if (display) return markdown;

    const localPath = item.path && item.url ? `\nLocal file: ${item.path}` : "";
    const relativePath = item.relativePath ? `\nRelative path: ${item.relativePath}` : "";
    const preview = item.preview ? `\n\n<attachment_preview name="${item.name}">\n${item.preview.slice(0, 12000)}\n</attachment_preview>` : "";
    return `${markdown}${localPath}${relativePath}${preview}`;
  }

  function submit(event) {
    event.preventDefault();
    const attachmentText = readyAttachments.map((item) => attachmentPromptText(item)).join("\n\n");
    const displayAttachmentText = readyAttachments.map((item) => attachmentPromptText(item, { display: true })).join("\n\n");
    const value = [text.trim(), attachmentText].filter(Boolean).join("\n\n");
    const displayValue = [text.trim(), displayAttachmentText].filter(Boolean).join("\n\n") || value;
    if (!value || !canSubmit) return;
    const shouldSendToRunningTask = running && runningTaskId && !isDesktop;
    const existingHistory = promptHistory();
    const historyText = text.trim() || displayValue.slice(0, 400);
    const nextHistory = [{ text: historyText, at: new Date().toISOString() }, ...existingHistory.filter((item) => item.text !== historyText)].slice(0, 30);
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
    if (shouldSendToRunningTask) onRunningInput(runningTaskId, value, displayValue);
    else onSend(value, displayValue);
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
          ) : null}
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
            {isDesktop ? "Desktop 当前设置" : `${activeModel || "默认模型"} · ${effortLabel(reasoningEffort)}`}
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
            {isDesktop ? "Desktop 当前权限" : permissionLabel(permissionMode)}
          </button>
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
            <select value={isDesktop ? "codex" : activeAgent} onChange={(event) => setActiveAgent(event.target.value)} disabled={isDesktop || agentOptions.length <= 1}>
              {agentOptions.map((provider) => (
                <option key={provider} value={provider}>
                  {provider === "codex" && isDesktop ? "Codex Desktop" : providerLabel(provider)}
                </option>
              ))}
            </select>
          </label>
          <label className="composer-field-row">
            <span>模型</span>
            {isDesktop ? (
              <select value="desktop-current" disabled>
                <option value="desktop-current">当前 Desktop 设置</option>
              </select>
            ) : (
              <select value={activeModel} onChange={(event) => setActiveModel(event.target.value)}>
                <option value="">默认模型</option>
                {modelAgent === "claude" ? (
                  <>
                    <option value="opus">opus</option>
                    <option value="sonnet">sonnet</option>
                    <option value="fable">fable</option>
                  </>
                ) : modelAgent === "zhipu" ? (
                  <>
                    <option value="glm-5.2">glm-5.2</option>
                    <option value="glm-5.1">glm-5.1</option>
                    <option value="glm-5.0">glm-5.0</option>
                    <option value="glm-4.7">glm-4.7</option>
                    <option value="glm-4.6">glm-4.6</option>
                  </>
                ) : (
                  <>
                    <option value="gpt-5.5">gpt-5.5</option>
                    <option value="gpt-5.5[1m]">gpt-5.5[1m]</option>
                    <option value="gpt-5.4">gpt-5.4</option>
                  </>
                )}
              </select>
            )}
          </label>
          <label className="composer-field-row">
            <span>推理强度</span>
            {isDesktop ? (
              <select value="desktop-current" disabled>
                <option value="desktop-current">当前 Desktop 设置</option>
              </select>
            ) : (
              <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>
                <option value="">默认</option>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="xhigh">超高</option>
                {modelAgent === "claude" ? <option value="max">最大</option> : null}
              </select>
            )}
          </label>
        </div>
      ) : null}
      {permissionMenuOpen ? (
        <div className="composer-popover permission-menu">
          {isDesktop ? (
            <button className="add-menu-item" type="button" disabled>
              <span className="menu-icon">
                <CheckSquare size={17} />
              </span>
              <span>
                <strong>Desktop 当前权限</strong>
                <small>由 Codex Desktop 当前会话设置决定</small>
              </span>
            </button>
          ) : (
            [
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
            ))
          )}
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
  const [zhipu, setZhipu] = useState("");
  const [defaultCwd, setDefaultCwd] = useState(settings?.defaultCwd || "");
  const [claudeCommand, setClaudeCommand] = useState(settings?.claudeCommand || "claude");
  const [codexCommand, setCodexCommand] = useState(settings?.codexCommand || "auto");
  const [codexTemplate, setCodexTemplate] = useState(settings?.codexTemplate || "");
  const [sandboxMode, setSandboxMode] = useState(settings?.security?.sandboxMode || "workspace-write");
  const [approvalPolicy, setApprovalPolicy] = useState(settings?.security?.approvalPolicy || "on-request");
  const [networkAccess, setNetworkAccess] = useState(settings?.security?.networkAccess !== false);
  const [requireTrustedWorkspace, setRequireTrustedWorkspace] = useState(settings?.security?.requireTrustedWorkspace !== false);
  const [requireDangerousCommandApproval, setRequireDangerousCommandApproval] = useState(settings?.security?.requireDangerousCommandApproval !== false);
  const [trustedWorkspaces, setTrustedWorkspaces] = useState((settings?.security?.trustedWorkspaces || []).join("\n"));
  const [hostAllowlist, setHostAllowlist] = useState((settings?.hostAllowlist || []).join("\n"));
  const [allowTryCloudflare, setAllowTryCloudflare] = useState(Boolean(settings?.allowTryCloudflare));
  const [allowLegacyPairingTokenLogin, setAllowLegacyPairingTokenLogin] = useState(Boolean(settings?.allowLegacyPairingTokenLogin));
  const [toolRetentionDays, setToolRetentionDays] = useState(settings?.toolEvents?.retentionDays || 30);
  const [toolKeepLatest, setToolKeepLatest] = useState(settings?.toolEvents?.keepLatest ?? 5000);
  const [toolAutoPrune, setToolAutoPrune] = useState(settings?.toolEvents?.autoPrune !== false);
  const [toolPruneInterval, setToolPruneInterval] = useState(settings?.toolEvents?.autoPruneIntervalMinutes || 360);
  const [notificationEmail, setNotificationEmail] = useState("");
  const [probeRunning, setProbeRunning] = useState(false);
  const [probeResult, setProbeResult] = useState(null);
  const [probeError, setProbeError] = useState("");
  const [desktopRunning, setDesktopRunning] = useState("");
  const [desktopResult, setDesktopResult] = useState(null);
  const [desktopError, setDesktopError] = useState("");
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [doctorResult, setDoctorResult] = useState(null);
  const [doctorError, setDoctorError] = useState("");
  const [securityBusy, setSecurityBusy] = useState("");
  const [securityError, setSecurityError] = useState("");
  const [securityNotice, setSecurityNotice] = useState("");
  const [devices, setDevices] = useState([]);
  const [currentDeviceId, setCurrentDeviceId] = useState("");
  const [pairingSessions, setPairingSessions] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [cloudflare, setCloudflare] = useState(null);
  const [pushState, setPushState] = useState("");
  const [toolEventStats, setToolEventStats] = useState(null);
  const [toolEventBusy, setToolEventBusy] = useState("");
  const [toolEventError, setToolEventError] = useState("");
  const [toolEventNotice, setToolEventNotice] = useState("");
  const [toolEventPreview, setToolEventPreview] = useState(null);
  const [mcpConfig, setMcpConfig] = useState(JSON.stringify(settings?.mcp?.servers || [], null, 2));
  const [mcpTimeoutMs, setMcpTimeoutMs] = useState(settings?.mcp?.probeTimeoutMs || 10000);
  const [mcpBusy, setMcpBusy] = useState("");
  const [mcpError, setMcpError] = useState("");
  const [mcpResult, setMcpResult] = useState(null);
  const [browserFetchUrl, setBrowserFetchUrl] = useState("");
  const [browserFetchBusy, setBrowserFetchBusy] = useState(false);
  const [browserFetchError, setBrowserFetchError] = useState("");
  const [browserFetchResult, setBrowserFetchResult] = useState(null);

  useEffect(() => {
    setDefaultCwd(settings?.defaultCwd || "");
    setClaudeCommand(settings?.claudeCommand || "claude");
    setCodexCommand(settings?.codexCommand || "auto");
    setCodexTemplate(settings?.codexTemplate || "");
    setSandboxMode(settings?.security?.sandboxMode || "workspace-write");
    setApprovalPolicy(settings?.security?.approvalPolicy || "on-request");
    setNetworkAccess(settings?.security?.networkAccess !== false);
    setRequireTrustedWorkspace(settings?.security?.requireTrustedWorkspace !== false);
    setRequireDangerousCommandApproval(settings?.security?.requireDangerousCommandApproval !== false);
    setTrustedWorkspaces((settings?.security?.trustedWorkspaces || []).join("\n"));
    setHostAllowlist((settings?.hostAllowlist || []).join("\n"));
    setAllowTryCloudflare(Boolean(settings?.allowTryCloudflare));
    setAllowLegacyPairingTokenLogin(Boolean(settings?.allowLegacyPairingTokenLogin));
    setToolRetentionDays(settings?.toolEvents?.retentionDays || 30);
    setToolKeepLatest(settings?.toolEvents?.keepLatest ?? 5000);
    setToolAutoPrune(settings?.toolEvents?.autoPrune !== false);
    setToolPruneInterval(settings?.toolEvents?.autoPruneIntervalMinutes || 360);
    setMcpConfig(JSON.stringify(settings?.mcp?.servers || [], null, 2));
    setMcpTimeoutMs(settings?.mcp?.probeTimeoutMs || 10000);
  }, [settings]);

  async function refreshToolEventsStats() {
    setToolEventError("");
    try {
      const result = await request("/api/tool-events/stats", {}, token);
      setToolEventStats(result);
    } catch (err) {
      setToolEventError(err.message);
    }
  }

  async function refreshSecurity() {
    setSecurityError("");
    try {
      const [deviceResult, pairingResult, approvalResult, auditResult, cloudflareResult] = await Promise.all([
        request("/api/devices", {}, token),
        request("/api/pairing-sessions", {}, token),
        request("/api/approvals?status=pending&limit=20", {}, token),
        request("/api/audit-log?limit=12", {}, token),
        request("/api/cloudflare/guide", {}, token)
      ]);
      setDevices(deviceResult.items || []);
      setCurrentDeviceId(deviceResult.currentDeviceId || "");
      setPairingSessions(pairingResult.items || []);
      setApprovals(approvalResult.items || []);
      setAuditLogs(auditResult.items || []);
      setCloudflare(cloudflareResult);
    } catch (err) {
      setSecurityError(err.message);
    }
  }

  useEffect(() => {
    refreshSecurity().catch((err) => setSecurityError(err.message));
    refreshToolEventsStats().catch((err) => setToolEventError(err.message));
  }, [token]);

  async function approvePairing(id) {
    setSecurityBusy(id);
    setSecurityError("");
    try {
      await request(`/api/pairing-sessions/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({}) }, token);
      setSecurityNotice("Pairing session approved.");
      await refreshSecurity();
    } catch (err) {
      setSecurityError(err.message);
    } finally {
      setSecurityBusy("");
    }
  }

  async function denyPairing(id) {
    setSecurityBusy(id);
    setSecurityError("");
    try {
      await request(`/api/pairing-sessions/${encodeURIComponent(id)}/deny`, { method: "POST", body: JSON.stringify({}) }, token);
      setSecurityNotice("Pairing session denied.");
      await refreshSecurity();
    } catch (err) {
      setSecurityError(err.message);
    } finally {
      setSecurityBusy("");
    }
  }

  async function decideApproval(id, decision) {
    setSecurityBusy(id);
    setSecurityError("");
    try {
      const result = await request(
        `/api/approvals/${encodeURIComponent(id)}/decision`,
        { method: "POST", body: JSON.stringify({ decision, reason: `${decision === "approve" ? "Approved" : "Denied"} in security panel.` }) },
        token
      );
      setSecurityNotice(decision === "approve" ? "Approval accepted and command resumed." : "Approval denied.");
      if (result.result?.ok === false) setSecurityError(result.result.stderr || result.result.stdout || "Approved command failed.");
      await refreshSecurity();
    } catch (err) {
      setSecurityError(err.message);
    } finally {
      setSecurityBusy("");
    }
  }

  async function revokeDevice(id) {
    if (!window.confirm("Revoke this device token?")) return;
    setSecurityBusy(id);
    setSecurityError("");
    try {
      await request(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: "POST", body: JSON.stringify({}) }, token);
      if (id === currentDeviceId) {
        localStorage.removeItem("mat.token");
        location.reload();
        return;
      }
      setSecurityNotice("Device revoked.");
      await refreshSecurity();
    } catch (err) {
      setSecurityError(err.message);
    } finally {
      setSecurityBusy("");
    }
  }

  async function rotateCurrentDevice() {
    setSecurityBusy("rotate-current");
    setSecurityError("");
    try {
      const result = await request("/api/devices/current/rotate", { method: "POST", body: JSON.stringify({}) }, token);
      if (result.token) {
        localStorage.setItem("mat.token", result.token);
        setSecurityNotice("This device token was rotated and saved locally.");
        window.setTimeout(() => location.reload(), 450);
        return;
      }
      await refreshSecurity();
    } catch (err) {
      setSecurityError(err.message);
    } finally {
      setSecurityBusy("");
    }
  }

  async function enablePushNotifications() {
    setPushState("");
    setSecurityError("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushState("This browser does not support Web Push.");
        return;
      }
      const publicKey = settings?.webPush?.publicKey || "";
      if (!publicKey) {
        setPushState("Web Push key is not ready. Save settings once and retry.");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        }));
      await request("/api/push/subscriptions", { method: "POST", body: JSON.stringify({ subscription }) }, token);
      setPushState("Web Push enabled for this device.");
      await refreshSecurity();
    } catch (err) {
      setSecurityError(err.message);
    }
  }

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

  async function runDoctor() {
    setDoctorRunning(true);
    setDoctorError("");
    setDoctorResult(null);
    try {
      const result = await request("/api/doctor", {}, token);
      setDoctorResult(result);
    } catch (err) {
      setDoctorError(err.message);
    } finally {
      setDoctorRunning(false);
    }
  }

  async function runToolEventsPrune(dryRun = true) {
    if (!dryRun && !window.confirm("Prune old tool events now?")) return;
    setToolEventBusy(dryRun ? "preview" : "prune");
    setToolEventError("");
    setToolEventNotice("");
    try {
      const result = await request(
        "/api/tool-events/prune",
        {
          method: "POST",
          body: JSON.stringify({
            dryRun,
            keepLatest: Number(toolKeepLatest || 0)
          })
        },
        token
      );
      setToolEventPreview(result);
      setToolEventNotice(dryRun ? `${result.prunable || 0} event(s) can be pruned.` : `${result.deleted || 0} event(s) pruned.`);
      await refreshToolEventsStats();
    } catch (err) {
      setToolEventError(err.message);
    } finally {
      setToolEventBusy("");
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

  function parseMcpConfig() {
    try {
      const parsed = JSON.parse(mcpConfig || "[]");
      if (!Array.isArray(parsed)) throw new Error("MCP config must be a JSON array.");
      return parsed;
    } catch (err) {
      setMcpError(err.message);
      return null;
    }
  }

  async function runMcpAction(action) {
    setMcpBusy(action);
    setMcpError("");
    setMcpResult(null);
    try {
      const result = await request(
        action === "probe" ? "/api/mcp/probe" : "/api/mcp/status",
        {
          method: action === "probe" ? "POST" : "GET",
          body: action === "probe" ? JSON.stringify({ timeoutMs: Number(mcpTimeoutMs || 10000) }) : undefined
        },
        token
      );
      setMcpResult(result);
    } catch (err) {
      setMcpError(err.message);
    } finally {
      setMcpBusy("");
    }
  }

  async function runBrowserFetch() {
    const targetUrl = browserFetchUrl.trim();
    if (!targetUrl) return;
    setBrowserFetchBusy(true);
    setBrowserFetchError("");
    setBrowserFetchResult(null);
    try {
      const result = await request(
        "/api/browser/fetch",
        { method: "POST", body: JSON.stringify({ url: targetUrl, timeoutMs: 15000 }) },
        token
      );
      setBrowserFetchResult(result);
    } catch (err) {
      if (err.status === 428 && err.data?.approvalId) {
        setBrowserFetchResult(err.data);
        setBrowserFetchError(err.data.error || err.message);
      } else {
        setBrowserFetchError(err.message);
      }
    } finally {
      setBrowserFetchBusy(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    const apiKeys = {};
    if (openai.trim()) apiKeys.openai = openai.trim();
    if (anthropic.trim()) apiKeys.anthropic = anthropic.trim();
    if (zhipu.trim()) apiKeys.zhipu = zhipu.trim();
    const mcpServers = parseMcpConfig();
    if (!mcpServers) return;
    const settingsPatch = {
      defaultCwd,
      claudeCommand,
      codexCommand,
      codexTemplate,
      security: {
        sandboxMode,
        approvalPolicy,
        networkAccess,
        requireTrustedWorkspace,
        requireDangerousCommandApproval,
        trustedWorkspaces: trustedWorkspaces.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)
      },
      hostAllowlist: hostAllowlist.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean),
      allowTryCloudflare,
      allowLegacyPairingTokenLogin,
      toolEvents: {
        retentionDays: Number(toolRetentionDays || 30),
        keepLatest: Number(toolKeepLatest || 0),
        autoPrune: toolAutoPrune,
        autoPruneIntervalMinutes: Number(toolPruneInterval || 360)
      },
      mcp: {
        probeTimeoutMs: Number(mcpTimeoutMs || 10000),
        servers: mcpServers
      },
      apiKeys
    };
    if (notificationEmail.trim()) settingsPatch.notificationEmail = notificationEmail.trim();
    await request(
      "/api/settings",
      {
        method: "POST",
        body: JSON.stringify(settingsPatch)
      },
      token
    );
    setOpenai("");
    setAnthropic("");
    setZhipu("");
    setNotificationEmail("");
    onSaved();
  }

  const doctorFailures = doctorResult?.failures || [];
  const doctorWarnings = (doctorResult?.warningChecks || doctorResult?.warnings || []).map((warning, index) =>
    typeof warning === "string"
      ? { id: `warning-${index}`, ok: false, label: "Warning", detail: warning, severity: "warn" }
      : warning
  );
  const doctorAttentionIds = new Set([...doctorFailures, ...doctorWarnings].map((check) => check.id));
  const doctorVisibleChecks = [
    ...doctorFailures,
    ...doctorWarnings,
    ...(doctorResult?.checks || []).filter((check) => check.ok && !doctorAttentionIds.has(check.id))
  ].slice(0, 12);
  const doctorStatusClass = doctorResult?.ok ? (doctorWarnings.length ? "warn" : "ok") : "failed";
  const doctorStatusText = doctorResult?.ok
    ? doctorWarnings.length
      ? `Healthy with ${doctorWarnings.length} warning(s)`
      : "Healthy"
    : `${doctorFailures.length} error(s)`;

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
          <span>智谱 API Key (Zhipu/GLM)</span>
          <input value={zhipu} onChange={(event) => setZhipu(event.target.value)} type="password" placeholder={settings?.hasZhipuKey ? "Saved; leave blank to keep" : "Not set"} />
        </label>
        <div className="credential-status">
          <strong>Credential storage</strong>
          <small>{settings?.credentials?.description || "Checking credential backend"} · {settings?.credentials?.persistent ? "protected" : "not persistent"}</small>
        </div>
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
        <section className="security-settings-card">
          <div>
            <h3>Agent permission model</h3>
            <p>CLI tasks use these verified settings. Desktop remote keeps using current Codex Desktop settings.</p>
          </div>
          <label>
            <span>Sandbox</span>
            <select value={sandboxMode} onChange={(event) => setSandboxMode(event.target.value)}>
              <option value="read-only">Read only</option>
              <option value="workspace-write">Workspace write</option>
              <option value="danger-full-access">Danger full access</option>
            </select>
          </label>
          <label>
            <span>Approval policy</span>
            <select value={approvalPolicy} onChange={(event) => setApprovalPolicy(event.target.value)}>
              <option value="on-request">On request</option>
              <option value="on-failure">On failure</option>
              <option value="untrusted">Untrusted</option>
              <option value="strict">Strict</option>
              <option value="never">Never</option>
            </select>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={networkAccess} onChange={(event) => setNetworkAccess(event.target.checked)} />
            <span>Allow network access for CLI tasks</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={requireTrustedWorkspace} onChange={(event) => setRequireTrustedWorkspace(event.target.checked)} />
            <span>Require trusted workspace before running tasks</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={requireDangerousCommandApproval} onChange={(event) => setRequireDangerousCommandApproval(event.target.checked)} />
            <span>Require confirmation for dangerous task settings</span>
          </label>
          <label>
            <span>Trusted workspaces</span>
            <textarea
              value={trustedWorkspaces}
              onChange={(event) => setTrustedWorkspaces(event.target.value)}
              placeholder={defaultCwd || "C:\\Projects\\my-app"}
            />
          </label>
        </section>
        <label>
          <span>Host allowlist</span>
          <textarea
            value={hostAllowlist}
            onChange={(event) => setHostAllowlist(event.target.value)}
            placeholder={"phone.example.com\n*.trycloudflare.com"}
          />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={allowTryCloudflare} onChange={(event) => setAllowTryCloudflare(event.target.checked)} />
          <span>Allow registered Cloudflare Tunnel hosts</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={allowLegacyPairingTokenLogin} onChange={(event) => setAllowLegacyPairingTokenLogin(event.target.checked)} />
          <span>Allow legacy token login</span>
        </label>
        <label>
          <span>Notification email fallback</span>
          <input value={notificationEmail} onChange={(event) => setNotificationEmail(event.target.value)} placeholder={settings?.notificationEmailConfigured ? "Configured; leave blank to keep" : "name@example.com"} />
        </label>
        <button className="primary-button" type="submit">
          Save
        </button>
      </form>
      <section className="security-panel">
        <div className="security-panel-head">
          <div>
            <h3>Public access security</h3>
            <p>Pair devices, approve access, rotate tokens, and review recent audit events.</p>
          </div>
          <button className="secondary-button" type="button" onClick={() => refreshSecurity()} disabled={Boolean(securityBusy)}>
            Refresh
          </button>
        </div>
        {securityError ? <p className="form-error">{securityError}</p> : null}
        {securityNotice ? <p className="form-success">{securityNotice}</p> : null}
        {cloudflare ? (
          <div className={cx("security-card", cloudflare.registered ? "ok" : cloudflare.publicHost ? "warn" : "")}>
            <strong>{cloudflare.tunnel ? "Cloudflare Tunnel" : "Host check"}</strong>
            <small>{cloudflare.host || "local"} · {cloudflare.registered ? "registered" : cloudflare.publicHost ? "not registered" : "local/private"}</small>
            {cloudflare.warnings?.length ? <p>{cloudflare.warnings.join(" ")}</p> : null}
            {cloudflare.steps?.length ? (
              <ol className="security-steps">
                {cloudflare.steps.slice(0, 4).map((step) => <li key={step}>{step}</li>)}
              </ol>
            ) : null}
          </div>
        ) : null}
        <div className="security-actions">
          <button className="secondary-button" type="button" onClick={rotateCurrentDevice} disabled={securityBusy === "rotate-current"}>
            {securityBusy === "rotate-current" ? "Rotating..." : "Rotate this device token"}
          </button>
          <button className="secondary-button" type="button" onClick={enablePushNotifications}>
            Enable Web Push
          </button>
        </div>
        {pushState ? <p className="form-success">{pushState}</p> : null}
        <div className="security-section">
          <h3>Pending approvals</h3>
          {approvals.length ? approvals.map((approval) => {
            const command = approval.request?.command || approval.request?.input?.command || approval.title || approval.kind;
            return (
              <div className="security-row approval-row" key={approval.id}>
                <div>
                  <strong>{approval.kind || "tool approval"}</strong>
                  <small>{approval.reason || "Approval required"} · expires {formatTime(approval.expiresAt)}</small>
                  <code>{command}</code>
                </div>
                <div className="security-row-actions">
                  <button className="secondary-button" type="button" onClick={() => decideApproval(approval.id, "approve")} disabled={Boolean(securityBusy)}>
                    Approve
                  </button>
                  <button className="secondary-button danger" type="button" onClick={() => decideApproval(approval.id, "deny")} disabled={Boolean(securityBusy)}>
                    Deny
                  </button>
                </div>
              </div>
            );
          }) : <p>No pending approvals.</p>}
        </div>
        <div className="security-section">
          <h3>Pending pairing</h3>
          {pairingSessions.length ? pairingSessions.map((session) => (
            <div className="security-row" key={session.id}>
              <div>
                <strong>{session.label || "New device"}</strong>
                <small>{session.status} · {session.ip || "unknown IP"} · expires {formatTime(session.expiresAt)}</small>
              </div>
              <div className="security-row-actions">
                <button className="secondary-button" type="button" onClick={() => approvePairing(session.id)} disabled={Boolean(securityBusy)}>
                  Approve
                </button>
                <button className="secondary-button danger" type="button" onClick={() => denyPairing(session.id)} disabled={Boolean(securityBusy)}>
                  Deny
                </button>
              </div>
            </div>
          )) : <p>No pending pairing sessions.</p>}
        </div>
        <div className="security-section">
          <h3>Devices</h3>
          {devices.length ? devices.map((device) => (
            <div className={cx("security-row", device.revokedAt || device.expired ? "muted" : "")} key={device.id}>
              <div>
                <strong>{device.label || device.id}{device.id === currentDeviceId ? " · this device" : ""}</strong>
                <small>
                  {device.revokedAt ? `revoked ${formatTime(device.revokedAt)}` : device.expired ? `expired ${formatTime(device.expiresAt)}` : `last seen ${formatTime(device.lastSeenAt || device.createdAt)}`}
                </small>
              </div>
              {!device.revokedAt ? (
                <button className="secondary-button danger" type="button" onClick={() => revokeDevice(device.id)} disabled={Boolean(securityBusy)}>
                  Revoke
                </button>
              ) : null}
            </div>
          )) : <p>No paired devices yet.</p>}
        </div>
        <div className="security-section">
          <h3>Recent audit</h3>
          {auditLogs.length ? auditLogs.map((item) => (
            <div className={cx("audit-row", item.success ? "ok" : "failed")} key={item.cursor}>
              <span>{item.eventType}</span>
              <small>{formatTime(item.eventAt)} · {item.ip || "local"} · {item.reason || item.path || "-"}</small>
            </div>
          )) : <p>No audit events yet.</p>}
        </div>
      </section>
      <div className="network-list">
        <section className="probe-panel">
          <div>
            <h3>Tool event storage</h3>
            <p>Manage persisted tool events used by runtime cards, SSE replay, approvals, and diagnostics.</p>
          </div>
          <div className="tool-event-grid">
            <label>
              <span>Retention days</span>
              <input type="number" min="1" max="3650" value={toolRetentionDays} onChange={(event) => setToolRetentionDays(event.target.value)} />
            </label>
            <label>
              <span>Keep latest</span>
              <input type="number" min="0" max="500000" value={toolKeepLatest} onChange={(event) => setToolKeepLatest(event.target.value)} />
            </label>
            <label>
              <span>Auto prune interval</span>
              <input type="number" min="15" max="10080" value={toolPruneInterval} onChange={(event) => setToolPruneInterval(event.target.value)} />
            </label>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={toolAutoPrune} onChange={(event) => setToolAutoPrune(event.target.checked)} />
            <span>Automatically prune old tool events</span>
          </label>
          <div className="tool-event-stats">
            <div>
              <strong>{toolEventStats?.count ?? "-"}</strong>
              <span>events</span>
            </div>
            <div>
              <strong>{toolEventStats?.minCursor || 0}-{toolEventStats?.maxCursor || 0}</strong>
              <span>cursor range</span>
            </div>
            <div>
              <strong>{toolEventStats?.retention?.retentionDays || toolRetentionDays}d</strong>
              <span>{toolEventStats?.retention?.keepLatest ?? toolKeepLatest} kept latest</span>
            </div>
            <div>
              <strong>{toolEventStats?.autoPrune?.nextRunAt ? formatTime(toolEventStats.autoPrune.nextRunAt) : "manual"}</strong>
              <span>next prune</span>
            </div>
          </div>
          {toolEventStats?.oldestAt || toolEventStats?.newestAt ? (
            <p className="tool-event-range">
              {formatTime(toolEventStats.oldestAt)} - {formatTime(toolEventStats.newestAt)}
            </p>
          ) : null}
          {toolEventPreview ? (
            <p className="tool-event-range">
              cutoff {formatTime(toolEventPreview.cutoff)} · {toolEventPreview.dryRun ? "preview" : "applied"} · {toolEventPreview.prunable || 0} prunable · {toolEventPreview.deleted || 0} deleted
            </p>
          ) : null}
          {toolEventError ? <p className="form-error">{toolEventError}</p> : null}
          {toolEventNotice ? <p className="form-success">{toolEventNotice}</p> : null}
          <div className="probe-actions">
            <button className="secondary-button" type="button" onClick={refreshToolEventsStats} disabled={Boolean(toolEventBusy)}>
              Refresh
            </button>
            <button className="secondary-button" type="button" onClick={() => runToolEventsPrune(true)} disabled={Boolean(toolEventBusy)}>
              {toolEventBusy === "preview" ? "Checking..." : "Preview prune"}
            </button>
            <button className="secondary-button danger" type="button" onClick={() => runToolEventsPrune(false)} disabled={Boolean(toolEventBusy)}>
              {toolEventBusy === "prune" ? "Pruning..." : "Prune now"}
            </button>
          </div>
        </section>
        <section className="probe-panel">
          <div>
            <h3>Runtime doctor</h3>
            <p>Checks local runtime, credentials, CLI commands, Git, Desktop, host policy, workspaces, and tool event storage.</p>
          </div>
          <button className="primary-button" type="button" onClick={runDoctor} disabled={doctorRunning}>
            {doctorRunning ? "Checking..." : "Run doctor"}
          </button>
          {doctorError ? <p className="form-error">{doctorError}</p> : null}
          {doctorResult ? (
            <div className={cx("probe-result", doctorStatusClass)}>
              <div className="probe-result-title">
                {doctorStatusText}
                {doctorResult.toolRunId ? <small> · run {doctorResult.toolRunId.slice(0, 8)}</small> : null}
              </div>
              <dl>
                {doctorVisibleChecks.map((check) => (
                  <div key={check.id}>
                    <dt>{check.label}</dt>
                    <dd>{check.ok ? "ok" : check.severity === "warn" ? "warn" : "error"} · {check.detail || "-"}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </section>
        <section className="probe-panel">
          <div>
            <h3>MCP runtime</h3>
            <p>Manage VibeLink-owned MCP server configuration and probe tools/list through the unified tool runtime.</p>
          </div>
          <label>
            <span>MCP servers JSON</span>
            <textarea
              value={mcpConfig}
              onChange={(event) => setMcpConfig(event.target.value)}
              placeholder={'[{"id":"filesystem","name":"filesystem","type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","C:\\\\Projects"]}]'}
            />
          </label>
          <label>
            <span>Probe timeout</span>
            <input type="number" min="1000" max="60000" value={mcpTimeoutMs} onChange={(event) => setMcpTimeoutMs(event.target.value)} />
          </label>
          <div className="probe-actions">
            <button className="secondary-button" type="button" onClick={() => runMcpAction("status")} disabled={Boolean(mcpBusy)}>
              {mcpBusy === "status" ? "Loading..." : "MCP status"}
            </button>
            <button className="primary-button" type="button" onClick={() => runMcpAction("probe")} disabled={Boolean(mcpBusy)}>
              {mcpBusy === "probe" ? "Probing..." : "Probe MCP"}
            </button>
          </div>
          {mcpError ? <p className="form-error">{mcpError}</p> : null}
          {mcpResult ? (
            <div className={cx("probe-result", mcpResult.ok ? "ok" : "failed")}>
              <div className="probe-result-title">
                {mcpResult.ok ? "Ready" : "Needs attention"}
                {mcpResult.toolRunId ? <small> · run {mcpResult.toolRunId.slice(0, 8)}</small> : null}
              </div>
              <dl>
                <div>
                  <dt>Servers</dt>
                  <dd>{mcpResult.enabled ?? mcpResult.probed ?? 0}/{mcpResult.configured ?? 0}</dd>
                </div>
                <div>
                  <dt>Tools</dt>
                  <dd>{mcpResult.tools?.length || 0}</dd>
                </div>
              </dl>
              {mcpResult.results?.length ? (
                <div className="security-section compact">
                  {mcpResult.results.map((item) => (
                    <div className={cx("security-row", item.ok ? "ok" : "failed")} key={item.server?.id || item.server?.name}>
                      <div>
                        <strong>{item.server?.name || item.server?.id || "MCP server"}</strong>
                        <small>{item.status} · {item.server?.type || item.transport || "unknown"} · {item.toolCount || 0} tool(s)</small>
                        {item.error ? <code>{item.error}</code> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {mcpResult.tools?.length ? (
                <div className="tool-event-range">
                  {mcpResult.tools.slice(0, 12).map((tool) => tool.fullName || tool.name).join(", ")}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
        <section className="probe-panel">
          <div>
            <h3>Browser runtime</h3>
            <p>Fetch a page through VibeLink runtime, with network policy, approvals, audit, and tool event replay.</p>
          </div>
          <label>
            <span>URL</span>
            <input value={browserFetchUrl} onChange={(event) => setBrowserFetchUrl(event.target.value)} placeholder="https://example.com" />
          </label>
          <button className="primary-button" type="button" onClick={runBrowserFetch} disabled={browserFetchBusy || !browserFetchUrl.trim()}>
            {browserFetchBusy ? "Fetching..." : "Fetch page"}
          </button>
          {browserFetchError ? <p className="form-error">{browserFetchError}</p> : null}
          {browserFetchResult ? (
            <div className={cx("probe-result", browserFetchResult.ok ? "ok" : browserFetchResult.approvalId ? "warn" : "failed")}>
              <div className="probe-result-title">
                {browserFetchResult.approvalId ? "Approval required" : browserFetchResult.ok ? "Fetched" : "Failed"}
                {browserFetchResult.toolRunId ? <small> · run {browserFetchResult.toolRunId.slice(0, 8)}</small> : null}
              </div>
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd>{browserFetchResult.status || browserFetchResult.error || "-"}</dd>
                </div>
                <div>
                  <dt>Title</dt>
                  <dd>{browserFetchResult.title || "-"}</dd>
                </div>
                <div>
                  <dt>Bytes</dt>
                  <dd>{browserFetchResult.bytes ?? "-"}</dd>
                </div>
                <div>
                  <dt>URL</dt>
                  <dd>{browserFetchResult.finalUrl || browserFetchResult.url || browserFetchResult.approval?.request?.url || "-"}</dd>
                </div>
              </dl>
              {browserFetchResult.textSample ? <p className="tool-event-range">{browserFetchResult.textSample.slice(0, 500)}</p> : null}
            </div>
          ) : null}
        </section>
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

function LiveCallPanel({ onClose, token }) {
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | active | stopped
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [remoteLevel, setRemoteLevel] = useState(0);
  const [localLevel, setLocalLevel] = useState(0);
  const [transcripts, setTranscripts] = useState([]);
  const [qaPairs, setQaPairs] = useState([]);
  const eventSourceRef = useRef(null);

  // SSE connection — opens when session changes
  useEffect(() => {
    if (!session) return;

    const cursorKey = `mat.live-call.${session.id}.cursor`;
    const cursor = parseInt(localStorage.getItem(cursorKey) || "0", 10);
    const es = new EventSource(`/api/live-calls/${session.id}/events?after=${cursor}`);
    eventSourceRef.current = es;

    es.addEventListener("live_call.audio_level", (event) => {
      const data = JSON.parse(event.data);
      if (data.channel === "remote") setRemoteLevel(data.level?.rms || 0);
      if (data.channel === "local") setLocalLevel(data.level?.rms || 0);
      if (data.cursor) rememberStreamCursor(cursorKey, data.cursor);
    });

    es.addEventListener("live_call.transcript.partial", (event) => {
      const data = JSON.parse(event.data);
      setTranscripts((prev) => [...prev, { ...data, id: data.cursor, at: data.at }]);
      if (data.cursor) rememberStreamCursor(cursorKey, data.cursor);
    });

    es.addEventListener("live_call.transcript.final", (event) => {
      const data = JSON.parse(event.data);
      setTranscripts((prev) => [...prev, { ...data, id: data.cursor, at: data.at, final: true }]);
      if (data.cursor) rememberStreamCursor(cursorKey, data.cursor);
    });

    es.addEventListener("live_call.question.detected", (event) => {
      const data = JSON.parse(event.data);
      setQaPairs((prev) => [...prev, { question: data.text, answer: "", id: data.cursor, agentState: "idle" }]);
      if (data.cursor) rememberStreamCursor(cursorKey, data.cursor);
    });

    es.addEventListener("live_call.agent.done", (event) => {
      const data = JSON.parse(event.data);
      setQaPairs((prev) => {
        const next = [...prev];
        if (next.length > 0 && next[next.length - 1].agentState === "idle") {
          // No thinking/delta happened — patch answer directly
          next[next.length - 1] = { ...next[next.length - 1], answer: data.text, agentState: "done" };
        } else if (next.length > 0 && (next[next.length - 1].agentState === "streaming" || next[next.length - 1].agentState === "thinking")) {
          next[next.length - 1] = { ...next[next.length - 1], answer: data.text, agentState: "done" };
        } else {
          next.push({ question: "", answer: data.text, id: data.cursor, agentState: "done" });
        }
        return next;
      });
      if (data.cursor) rememberStreamCursor(cursorKey, data.cursor);
    });

    es.addEventListener("live_call.agent.thinking", (event) => {
      const data = JSON.parse(event.data);
      setQaPairs((prev) => {
        const next = [...prev];
        // Mark the last QA pair (or a new one) as thinking
        if (next.length > 0 && next[next.length - 1].agentState === "idle") {
          next[next.length - 1] = { ...next[next.length - 1], agentState: "thinking" };
        } else if (next.length > 0 && next[next.length - 1].agentState === "done") {
          next.push({ question: next[next.length - 1].question || "", answer: "", id: data.cursor, agentState: "thinking" });
        } else if (next.length === 0) {
          next.push({ question: "", answer: "", id: data.cursor, agentState: "thinking" });
        }
        return next;
      });
      if (data.cursor) rememberStreamCursor(cursorKey, data.cursor);
    });

    es.addEventListener("live_call.agent.delta", (event) => {
      const data = JSON.parse(event.data);
      setQaPairs((prev) => {
        const next = [...prev];
        if (next.length === 0) {
          next.push({ question: "", answer: data.text, id: data.cursor, agentState: "streaming" });
        } else {
          const last = next[next.length - 1];
          if (last.agentState === "streaming") {
            next[next.length - 1] = { ...last, answer: (last.answer || "") + data.text, agentState: "streaming" };
          } else if (last.agentState === "thinking") {
            next[next.length - 1] = { ...last, answer: data.text, agentState: "streaming" };
          } else if (last.agentState === "done") {
            next.push({ question: "", answer: data.text, id: data.cursor, agentState: "streaming" });
          } else {
            next.push({ question: "", answer: data.text, id: data.cursor, agentState: "streaming" });
          }
        }
        return next;
      });
      if (data.cursor) rememberStreamCursor(cursorKey, data.cursor);
    });

    es.addEventListener("live_call.agent.error", (event) => {
      const data = JSON.parse(event.data);
      setQaPairs((prev) => {
        const next = [...prev];
        if (next.length > 0 && (next[next.length - 1].agentState === "thinking" || next[next.length - 1].agentState === "streaming")) {
          next[next.length - 1] = { ...next[next.length - 1], answer: `[error] ${data.error || "Agent failed"}`, agentState: "done" };
        }
        return next;
      });
    });

    es.addEventListener("live_call.stopped", () => {
      setStatus("stopped");
    });

    es.onerror = () => {
      // EventSource auto-reconnects with retry
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [session?.id]);

  async function createSession() {
    setBusy("create");
    setError("");
    try {
      const result = await request("/api/live-calls", {
        method: "POST",
        body: JSON.stringify({ title: "Live Call", source: "web-ui" })
      }, token);
      setSession(result.session);
      setStatus("active");
      setTranscripts([]);
      setQaPairs([]);
      setRemoteLevel(0);
      setLocalLevel(0);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function stopSession() {
    if (!session) return;
    setBusy("stop");
    setError("");
    try {
      await request(`/api/live-calls/${session.id}/stop`, {
        method: "POST",
        body: JSON.stringify({ reason: "manual" })
      }, token);
      setStatus("stopped");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  const statusLabel = status === "idle" ? "已就绪" : status === "active" ? "通话中" : "已结束";

  return (
    <aside className="live-call-panel">
      <div className="drawer-header">
        <button className="icon-button" title="Back" aria-label="Back" type="button" onClick={onClose}>
          <ChevronLeft size={22} />
        </button>
        <div>
          <h2>Live Call</h2>
          <p>实时通话</p>
        </div>
      </div>

      {/* Status + Controls */}
      <div className="panel">
        <div className="live-call-status-row">
          <span className={cx("status-dot", status)} />
          <span>{statusLabel}</span>
        </div>
        {session ? <small className="live-call-id">ID: {session.id?.slice(0, 8)}…</small> : null}
        <div className="live-call-actions">
          {status !== "active" ? (
            <button className="primary-button" disabled={busy === "create"} onClick={createSession}>
              {busy === "create" ? <Loader2 size={16} className="spin" /> : <Phone size={16} />}
              创建通话
            </button>
          ) : (
            <button className="secondary-button danger" disabled={busy === "stop"} onClick={stopSession}>
              {busy === "stop" ? <Loader2 size={16} className="spin" /> : <PhoneOff size={16} />}
              停止通话
            </button>
          )}
        </div>
        {error ? <small className="live-call-error">{error}</small> : null}
      </div>

      {/* Audio levels */}
      <div className="panel">
        <div className="section-title"><Volume2 size={14} /> 音频电平</div>
        <div className="level-channel">
          <span>远程</span>
          <div className="level-bar"><div className="level-fill" style={{ width: `${Math.min(remoteLevel * 200, 100)}%` }} /></div>
          <span className="level-value">{(remoteLevel * 100).toFixed(0)}%</span>
        </div>
        <div className="level-channel">
          <span>本地</span>
          <div className="level-bar"><div className="level-fill" style={{ width: `${Math.min(localLevel * 200, 100)}%` }} /></div>
          <span className="level-value">{(localLevel * 100).toFixed(0)}%</span>
        </div>
      </div>

      {/* Transcript feed */}
      {transcripts.length > 0 ? (
        <div className="panel">
          <div className="section-title">实时转录</div>
          <div className="transcript-feed">
            {transcripts.map((t, i) => (
              <div key={t.id ?? i} className={cx("transcript-entry", t.final ? "final" : "partial")}>
                <small>{formatTime(t.at)}</small>
                <span>{t.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Q&A cards */}
      {qaPairs.length > 0 ? (
        <div className="panel">
          <div className="section-title"><MessageCircle size={14} /> 问答记录</div>
          {qaPairs.map((pair, i) => (
            <div key={pair.id ?? i} className="qa-card">
              {pair.question ? <div className="qa-question">❓ {pair.question}</div> : null}
              {pair.agentState === "thinking" ? (
                <div className="qa-answer qa-thinking">
                  <Loader2 size={14} className="spin" />
                  <span>思考中…</span>
                </div>
              ) : pair.agentState === "streaming" ? (
                <div className="qa-answer qa-streaming">
                  💡 {pair.answer}<span className="streaming-cursor" />
                </div>
              ) : pair.answer ? (
                <div className="qa-answer">💡 {pair.answer}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
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
  const [toolEvents, setToolEvents] = useState([]);
  const [toolRegistry, setToolRegistry] = useState({});
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
  const [liveCallOpen, setLiveCallOpen] = useState(false);
  const [liveCallSession, setLiveCallSession] = useState(null);
  const [liveCallStatus, setLiveCallStatus] = useState("idle"); // "idle" | "active" | "stopped"
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(Boolean(savedToken));
  const [error, setError] = useState("");
  const [loginError, setLoginError] = useState("");
  const [initialScrollSequence, setInitialScrollSequence] = useState(0);
  const [locatedMessageKey, setLocatedMessageKey] = useState("");
  const [workspaceOpenRequest, setWorkspaceOpenRequest] = useState(null);
  const eventSourceRef = useRef(null);
  const toolEventSourceRef = useRef(null);
  const pollRef = useRef(null);
  const desktopPollRef = useRef(null);
  const desktopObserverRef = useRef(null);
  const desktopObserverCursorRef = useRef(Number(localStorage.getItem(desktopObserverCursorKey) || 0));
  const conversationLoadRef = useRef(0);
  const listRef = useRef(null);

  const providers = useMemo(() => {
    const items = [];
    if (settings?.hasOpenAIKey) items.push("codex");
    if (settings?.hasAnthropicKey) items.push("claude");
    if (settings?.hasZhipuKey) items.push("zhipu");
    return items;
  }, [settings]);

  const conversations = useMemo(() => {
    const historyBySession = new Map(
      histories
        .map((item) => [sessionKey(item.provider, item.id), item])
    );
    const taskGroups = new Map();

    for (const task of tasks) {
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
          desktopProjectTitle: baseDesktopItem.projectTitle,
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
            desktopProjectTitle: desktopMatch.desktopProjectTitle,
            desktopLinked: true,
            displayTime: desktopMatch.displayTime || item.displayTime
          };
        })
    ).filter((item) => !item.archived);
    const projectNodes = buildConversationTree(localItems, expandedProjects);
    return filterConversationNodes(projectNodes, query);
  }, [tasks, histories, query, desktopRemote, threadState, showArchived, expandedProjects]);

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

  const toolEventMessages = useMemo(() => toolEventsToMessages(toolEvents, toolRegistry), [toolEvents, toolRegistry]);

  const desktopMessages = useMemo(() => {
    if (controlMode !== "desktop") return messagesForRender([...messages, ...toolEventMessages], running);
    const items = [...messages, ...toolEventMessages];
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

    const queueItems = desktopRemote?.items || [];
    const turnStatus = desktopTurnStatusMessage(latestDesktopQueueItem(queueItems), desktop);
    const liveTurn = desktopVisibleTurnFromTranscript(desktop, items);
    if (liveTurn) items.push(liveTurn);
    else if (turnStatus) items.push(turnStatus);

    return messagesForRender(items, false);
  }, [controlMode, desktopRemote, messages, running, toolEventMessages]);

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
    if (!initialScrollSequence) return undefined;
    const loadSequence = initialScrollSequence;
    const frame = window.requestAnimationFrame(() => {
      if (conversationLoadRef.current !== loadSequence) return;
      const list = listRef.current;
      if (list) list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
      setInitialScrollSequence((current) => (current === loadSequence ? 0 : current));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialScrollSequence]);

  useEffect(() => {
    if (!token || controlMode !== "desktop") return undefined;
    if (!desktopRemoteNeedsHistoryRefresh(desktopRemote)) return undefined;
    const timer = setInterval(() => {
      refreshDesktopRemote(false).catch((err) => setError(err.message));
    }, 1800);
    return () => clearInterval(timer);
  }, [token, controlMode, desktopRemote?.pendingCount, desktopRemote?.active, desktopRemote?.desktop?.sidebarRunningCount, desktopRemote?.desktop?.reason, desktopRemote?.items]);

  async function refresh(options = {}) {
    try {
      const [status, history, thread, registry] = await Promise.all([
        request("/api/status", {}, token),
        request("/api/histories", {}, token),
        request("/api/thread-state", {}, token),
        request("/api/tool-registry", {}, token)
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
      setToolRegistry(Object.fromEntries((registry.items || []).map((item) => [item.name, item])));
      if (options.keepSelection && selected) {
        setSelected((current) => current);
      }
    } finally {
      setLoading(false);
    }
  }

  async function refreshDesktopRemote(fresh = false) {
    const state = await request(`/api/desktop-remote/status${fresh ? "?fresh=1" : ""}`, {}, token);
    if (state?.desktop?.observationCursor) {
      desktopObserverCursorRef.current = rememberStreamCursor(
        desktopObserverCursorKey,
        Math.max(desktopObserverCursorRef.current || 0, Number(state.desktop.observationCursor) || 0)
      );
    }
    setDesktopRemote(state);
    return state;
  }

  function applyDesktopObserverEvent(event) {
    if (!event?.desktop) return;
    const cursor = Number(event.cursor || 0);
    if (cursor && desktopObserverCursorRef.current && cursor < desktopObserverCursorRef.current) return;
    if (cursor) {
      desktopObserverCursorRef.current = rememberStreamCursor(
        desktopObserverCursorKey,
        Math.max(desktopObserverCursorRef.current || 0, cursor)
      );
    }
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
    if (!token || controlMode !== "desktop" || selected?.provider !== "codex") return undefined;
    const historyId = conversationHistoryId(selected);
    if (!historyId || !desktopRemoteNeedsHistoryRefresh(desktopRemote)) return undefined;

    let cancelled = false;
    let inFlight = false;
    const refreshBoundHistory = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const historyMessages = await loadHistoryMessages("codex", historyId, { fresh: true });
        if (!cancelled && historyMessages.length) {
          setMessages((items) => mergeDisplayMessagesWithUpdates(items, historyMessages));
        }
      } finally {
        inFlight = false;
      }
    };

    refreshBoundHistory().catch((err) => setError(err.message));
    const timer = setInterval(() => {
      refreshBoundHistory().catch((err) => setError(err.message));
    }, 2500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    token,
    controlMode,
    selected?.key,
    selected?.provider,
    selected?.id,
    selected?.sessionId,
    selected?.sourceId,
    selected?.historyId,
    desktopRemote?.pendingCount,
    desktopRemote?.active,
    desktopRemote?.desktop?.visibleTranscriptHash,
    desktopRemote?.desktop?.sidebarRunningCount,
    desktopRemote?.desktop?.reason,
    desktopRemote?.items
  ]);

  useEffect(() => {
    if (!token || controlMode !== "desktop" || selected?.provider !== "codex" || !selected?.cwd) return undefined;
    if (!desktopRemoteNeedsHistoryRefresh(desktopRemote)) return undefined;

    let cancelled = false;
    let inFlight = false;
    const refreshChanges = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await loadWorkspaceChanges(selected.cwd || "");
      } finally {
        inFlight = false;
      }
    };

    refreshChanges().catch(() => {});
    const timer = setInterval(() => {
      refreshChanges().catch(() => {});
    }, 6000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    token,
    controlMode,
    selected?.key,
    selected?.provider,
    selected?.cwd,
    desktopRemote?.pendingCount,
    desktopRemote?.active,
    desktopRemote?.desktop?.visibleTranscriptHash,
    desktopRemote?.desktop?.sidebarRunningCount,
    desktopRemote?.desktop?.reason,
    desktopRemote?.items
  ]);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  function sameMessageForOperation(item, target) {
    if (!item || !target || item.role !== target.role) return false;
    if (target.liveKey && item.liveKey) return target.liveKey === item.liveKey;
    if (target.turnId && item.turnId) return target.turnId === item.turnId;
    return normalizeMessageText(item.text) === normalizeMessageText(target.text);
  }

  function updateFirstMatchingMessage(target, updater) {
    setMessages((items) => {
      let updated = false;
      return items.map((item) => {
        if (updated || !sameMessageForOperation(item, target)) return item;
        updated = true;
        return updater(item);
      });
    });
  }

  function handleEditMessage(target, nextText) {
    const text = String(nextText || "").trim();
    if (!text) return;
    updateFirstMatchingMessage(target, (item) => ({ ...item, text, typing: false }));
  }

  function handleDeleteMessage(target) {
    setMessages((items) => {
      let deleted = false;
      return items.filter((item) => {
        if (deleted || !sameMessageForOperation(item, target)) return true;
        deleted = true;
        return false;
      });
    });
  }

  async function handleRegenerateMessage(target) {
    const targetIndex = messages.findIndex((item) => sameMessageForOperation(item, target));
    const earlierMessages = targetIndex >= 0 ? messages.slice(0, targetIndex) : messages;
    const previousUser = [...earlierMessages].reverse().find((item) => item.role === "user" && item.text);
    if (!previousUser) {
      setError("No earlier user message is available to regenerate from.");
      return;
    }
    handleDeleteMessage(target);
    const prompt = stripUserAttachmentMetadata(previousUser.text);
    await sendPrompt(prompt, prompt);
  }

  function locateMessage(messageKey) {
    if (!messageKey) return;
    setLocatedMessageKey(messageKey);
    requestAnimationFrame(() => {
      const list = listRef.current;
      const element = [...(list?.querySelectorAll("[data-message-key]") || [])].find((node) => node.dataset.messageKey === messageKey);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    window.setTimeout(() => {
      setLocatedMessageKey((current) => (current === messageKey ? "" : current));
    }, 1600);
  }

  function openFileFromMessage(ref) {
    if (!ref?.path) return;
    setWorkspaceOpenRequest({
      id: `${Date.now()}:${ref.path}:${ref.line || 0}`,
      path: ref.path,
      line: ref.line || 0,
      column: ref.column || 0
    });
  }

  function stopTaskStream() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }

  function stopToolEventStream() {
    toolEventSourceRef.current?.close();
    toolEventSourceRef.current = null;
  }

  function toolEventFilterForSelection(conversation = selected) {
    if (!conversation) return null;
    if (conversation.kind === "task" && conversation.id) {
      return { key: `task:${conversation.id}`, query: `taskId=${encodeURIComponent(conversation.id)}` };
    }
    if (conversation.kind === "history") {
      const sessionId = conversation.sourceId || conversation.id || conversation.sessionId || conversation.historyId || "";
      const taskId = conversation.toolTaskId || historyToolTaskId(conversation.provider, sessionId);
      if (taskId) return { key: `task:${taskId}`, query: `taskId=${encodeURIComponent(taskId)}` };
    }
    const workspace = chooseWorkspaceForPath(workspaces, conversation.cwd || "");
    if (workspace?.id) {
      return { key: `workspace:${workspace.id}`, query: `workspaceId=${encodeURIComponent(workspace.id)}` };
    }
    return null;
  }

  function appendToolEvents(events = [], cursorRef = { current: 0, ids: new Set() }) {
    const next = [];
    for (const event of events) {
      const id = event.id || `${event.toolRunId}:${event.cursor || event.at || next.length}`;
      if (cursorRef.ids?.has(id)) continue;
      cursorRef.ids?.add(id);
      next.push(event);
    }
    const nextCursor = cursorFromEvents(events);
    if (nextCursor) cursorRef.current = Math.max(Number(cursorRef.current || 0), nextCursor);
    if (next.length) {
      setToolEvents((items) => {
        const existing = new Set(items.map((event) => event.id || `${event.toolRunId}:${event.cursor || event.at || ""}`));
        const merged = [...items];
        for (const event of next) {
          const id = event.id || `${event.toolRunId}:${event.cursor || event.at || ""}`;
          if (!existing.has(id)) merged.push(event);
        }
        return merged.slice(-500);
      });
    }
  }

  function followToolEvents(conversation = selected) {
    stopToolEventStream();
    const filter = toolEventFilterForSelection(conversation);
    if (!filter) return;
    const cursorKey = streamCursorKey("tool", filter.key);
    const cursorRef = {
      current: Number(localStorage.getItem(cursorKey) || 0),
      ids: new Set()
    };

    const openStream = async () => {
      const catchUp = await request(`/api/tool-events?${filter.query}&after=${Number(cursorRef.current || 0)}&limit=500`, {}, token);
      appendToolEvents(catchUp.items || [], cursorRef);
      if (cursorRef.current) rememberStreamCursor(cursorKey, cursorRef.current);

      const source = new EventSource(`/api/tool-events?stream=1&token=${encodeURIComponent(token)}&${filter.query}&after=${Number(cursorRef.current || 0)}`);
      toolEventSourceRef.current = source;
      source.onmessage = (message) => {
        const event = JSON.parse(message.data);
        appendToolEvents([event], cursorRef);
        if (cursorRef.current) rememberStreamCursor(cursorKey, cursorRef.current);
      };
      const handleNamedEvent = (message) => source.onmessage(message);
      source.addEventListener("tool.created", handleNamedEvent);
      source.addEventListener("tool.started", handleNamedEvent);
      source.addEventListener("tool.output", handleNamedEvent);
      source.addEventListener("tool.cancel_requested", handleNamedEvent);
      source.addEventListener("tool.cancelled", handleNamedEvent);
      source.addEventListener("tool.completed", handleNamedEvent);
      source.addEventListener("tool.failed", handleNamedEvent);
      source.addEventListener("tool.error", handleNamedEvent);
      source.addEventListener("approval.required", handleNamedEvent);
      source.addEventListener("approval.approved", handleNamedEvent);
      source.addEventListener("approval.denied", handleNamedEvent);
      source.addEventListener("approval.expired", handleNamedEvent);
      source.onerror = () => {
        source.close();
        if (toolEventSourceRef.current === source) toolEventSourceRef.current = null;
      };
    };

    openStream().catch((err) => setError(err.message));
  }

  async function refreshSelectedToolEvents(conversation = selected) {
    const filter = toolEventFilterForSelection(conversation);
    if (!filter) return;
    const cursorKey = streamCursorKey("tool", filter.key);
    const cursorRef = {
      current: Number(localStorage.getItem(cursorKey) || 0),
      ids: new Set(toolEvents.map((event) => event.id).filter(Boolean))
    };
    const result = await request(`/api/tool-events?${filter.query}&after=${Number(cursorRef.current || 0)}&limit=500`, {}, token);
    appendToolEvents(result.items || [], cursorRef);
    if (cursorRef.current) rememberStreamCursor(cursorKey, cursorRef.current);
  }

  function appendTaskEvents(events, seenCountRef, options = {}) {
    const seenIds = seenCountRef.ids || new Set();
    const nextEvents = events.filter((event) => {
      if (event.id && seenIds.has(event.id)) return false;
      if (event.id) seenIds.add(event.id);
      return true;
    });
    seenCountRef.ids = seenIds;
    seenCountRef.current = Math.max(seenCountRef.current || 0, events.length);
    const nextCursor = cursorFromEvents(events);
    if (nextCursor) {
      seenCountRef.cursor = Math.max(Number(seenCountRef.cursor || 0), nextCursor);
      if (options.cursorKey) rememberStreamCursor(options.cursorKey, seenCountRef.cursor);
    }
    const nextMessages = messagesFromEvents(nextEvents, options);
    if (nextMessages.length) setMessages((items) => appendDisplayMessages(items, nextMessages));
  }

  function startTaskPolling(task, seenCountRef) {
    const taskId = task?.id || task;
    const eventOptions = {
      animateAssistant: false,
      cursorKey: streamCursorKey("task", taskId)
    };
    if (pollRef.current) clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const latest = await request(`/api/tasks/${taskId}`, {}, token);
        appendTaskEvents(latest.events || [], seenCountRef, eventOptions);
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
    const cursorKey = streamCursorKey("task", task.id);
    const savedCursor = Number(localStorage.getItem(cursorKey) || 0);
    const initialCursor = Math.max(savedCursor, cursorFromEvents(task.events || []));
    const seenCountRef = {
      current: (task.events || []).length,
      cursor: initialCursor,
      ids: new Set((task.events || []).map((event) => event.id).filter(Boolean))
    };
    if (initialCursor) rememberStreamCursor(cursorKey, initialCursor);
    let fallbackTimer = null;

    const fallbackToPolling = () => {
      if (pollRef.current) return;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      startTaskPolling(task, seenCountRef);
    };

    const openStream = async () => {
      const catchUp = await request(
        `/api/tasks/${task.id}/events/catch-up?after=${Number(seenCountRef.cursor || 0)}`,
        {},
        token
      );
      appendTaskEvents(catchUp.items || [], seenCountRef, {
        animateAssistant: false,
        cursorKey
      });

      const source = new EventSource(`/api/tasks/${task.id}/events?token=${encodeURIComponent(token)}&after=${Number(seenCountRef.cursor || 0)}`);
      eventSourceRef.current = source;
      fallbackTimer = setTimeout(fallbackToPolling, 6000);

      source.onopen = () => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
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
        const eventCursor = Number(event.cursor || message.lastEventId || 0);
        if (eventCursor) {
          seenCountRef.cursor = Math.max(Number(seenCountRef.cursor || 0), eventCursor);
          rememberStreamCursor(cursorKey, seenCountRef.cursor);
        }
        const role = taskEventRole(event);
        const text = taskEventText(event);
        const typing = shouldAnimateLiveAssistant(task.agent || task.provider, role);
        if (text && role !== "debug") {
          setMessages((items) =>
            appendDisplayMessages(items, [
              {
                role,
                text,
                typing,
                typingKey: typing ? `task:${task.id}:${event.id || eventCursor || seenCountRef.current}` : ""
              }
            ])
          );
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
    };

    openStream().catch(() => {
      fallbackToPolling();
    });
  }

  async function loadHistoryMessages(provider, sessionId, { fresh = false } = {}) {
    if (!provider || !sessionId) return [];
    try {
      const detail = await request(`/api/histories/${provider}/${encodeURIComponent(sessionId)}${fresh ? "?fresh=1" : ""}`, {}, token);
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

  async function loadWorkspaceChanges(cwd = selected?.cwd || "") {
    try {
      const workspaceList = await request("/api/workspaces", {}, token);
      const workspace = chooseWorkspaceForPath(workspaceList.items || [], cwd);
      if (!workspace) {
        setChangeSummary(null);
        return;
      }
      const [status, diff] = await Promise.all([
        request(`/api/workspaces/${workspace.id}/git/status`, {}, token),
        request(`/api/workspaces/${workspace.id}/git/diff`, {}, token)
      ]);
      setChangeSummary({
        ...diff,
        branch: status.branch || diff.branch || "",
        files: diff.files?.length ? diff.files : status.files || [],
        changedCount: status.changedCount ?? diff.fileCount ?? diff.files?.length ?? 0,
        statusFiles: status.files || [],
        kind: "workspace",
        cwd: workspace.path || cwd
      });
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
      loadWorkspaceChanges(conversation.cwd || "").catch(() => {});
    } catch (err) {
      setError(err.message || "Failed to focus Codex Desktop chat");
    }
  }

  async function selectConversation(conversation) {
    stopTaskStream();
    stopToolEventStream();
    const loadSequence = conversationLoadRef.current + 1;
    conversationLoadRef.current = loadSequence;
    setInitialScrollSequence(0);
    setSelected(conversation);
    setSidebarOpen(false);
    setError("");
    setChangeSummary(null);
    setToolEvents([]);

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
      if (conversationLoadRef.current !== loadSequence) return;
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
      if (conversationLoadRef.current !== loadSequence) return;
      const hasTurnHistory = historyMessages.some((message) => message.turnId);
      const taskMessages = !historyMessages.length || (task.status === "running" && !hasTurnHistory) ? messagesFromEvents(task.events || []) : [];
      const nextMessages = taskMessages.length ? mergeHistoryAndTaskMessages(historyMessages, taskMessages) : historyMessages;
      setMessages(nextMessages.length ? nextMessages : [{ role: "system", text: "Task started. Waiting for output." }]);
      setInitialScrollSequence(loadSequence);
      setRunning(task.status === "running");
      focusDesktopConversation(conversation);
      followToolEvents({ ...conversation, id: task.id, kind: "task", cwd: task.cwd || conversation.cwd });

      if (task.status === "running") {
        followRunningTask(task);
      }
      return;
    }

    if (conversation.preview && !isSyntheticHistoryText(conversation.preview)) {
      setMessages([{ role: "assistant", text: conversation.preview }]);
    }
    const detail = await request(`/api/histories/${conversation.provider}/${encodeURIComponent(conversation.sourceId || conversation.id)}`, {}, token);
    if (conversationLoadRef.current !== loadSequence) return;
    const entries = detail.transcript?.length ? messagesFromTranscript(detail.transcript) : messagesFromHistoryEntries(detail.entries || []);
    setMessages(entries.length ? entries : [{ role: "system", text: "This history item only has index metadata; no local preview is available yet." }]);
    setInitialScrollSequence(loadSequence);
    focusDesktopConversation(conversation);
    followToolEvents({ ...conversation, toolTaskId: detail.toolTaskId || conversation.toolTaskId || "" });
  }

  async function startTask(prompt, displayPrompt = prompt) {
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
      title: selected?.kind === "fork" ? selected.title : displayPrompt,
      model: activeModel || "",
      reasoningEffort: reasoningEffort || "",
      permissionMode,
      security: settings?.security || {}
    };
    setMessages((items) => appendDisplayMessages(items, [{ role: "user", text: displayPrompt }]));
    setRunning(true);
    let created;
    try {
      created = await request(
        "/api/tasks",
        {
          method: "POST",
          body: JSON.stringify(payload)
        },
        token
      );
    } catch (err) {
      if (err.status !== 428) {
        setRunning(false);
        throw err;
      }
      const approvalId = err.data?.approvalId || err.data?.approval?.id || "";
      const reason = taskApprovalText(err) || "dangerous task settings";
      setMessages((items) =>
        appendDisplayMessages(items, [
          {
            role: "system",
            text: `Task paused for approval: ${reason}`
          }
        ])
      );
      const approved = window.confirm(`Approve this task?\n\n${reason}`);
      if (!approved) {
        if (approvalId) {
          try {
            await request(
              `/api/approvals/${encodeURIComponent(approvalId)}/decision`,
              { method: "POST", body: JSON.stringify({ decision: "deny", reason: "Denied in composer." }) },
              token
            );
          } catch {
            // Keep the composer flow responsive even if the denial sync fails.
          }
          refreshSelectedToolEvents().catch((refreshErr) => setError(refreshErr.message));
        }
        setRunning(false);
        setMessages((items) => appendDisplayMessages(items, [{ role: "system", text: "Task was not sent because approval was denied." }]));
        return;
      }
      if (approvalId) {
        const approvalResult = await request(
          `/api/approvals/${encodeURIComponent(approvalId)}/decision`,
          { method: "POST", body: JSON.stringify({ decision: "approve", reason: "Approved in composer." }) },
          token
        );
        created = approvalResult.result || {};
        refreshSelectedToolEvents().catch((refreshErr) => setError(refreshErr.message));
      } else {
        throw new Error("Approval request was not returned by the server.");
      }
    }
    if (!created?.id) {
      setRunning(false);
      throw new Error("Task approval did not return a task id.");
    }
    await refresh();
    const task = {
      key: canResume && resumeSessionId ? `thread:${activeAgent}:${resumeSessionId}` : `task:${created.id}`,
      kind: "task",
      id: created.id,
      provider: activeAgent,
      title: canResume ? selected?.title || displayPrompt : displayPrompt,
      cwd: selected?.cwd || "",
      status: "running",
      sessionId: canResume ? resumeSessionId : ""
    };
    await selectConversation(task);
  }

  async function sendDesktopRemote(prompt, displayPrompt = prompt) {
    stopTaskStream();
    const target = desktopRemoteTargetSnapshot(selected);
    if (!target) {
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

    const optimisticItem = {
      id: `local-${Date.now()}`,
      text: prompt,
      displayText: displayPrompt,
      status: "queued",
      error: "",
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      target,
      settingsPolicy: "useExisting",
      settings: {
        permissionMode: "",
        model: "",
        reasoningEffort: ""
      }
    };
    setRunning(false);
    setMessages((items) => appendDisplayMessages(items, [{ role: "user", text: displayPrompt }]));
    setDesktopRemote((current) => ({
      ...(current || {}),
      ok: true,
      mode: "desktop-remote",
      active: true,
      pendingCount: Math.max(1, Number(current?.pendingCount || 0) + 1),
      items: [...(current?.items || []).filter((item) => !String(item.id || "").startsWith("local-")), optimisticItem],
      updatedAt: optimisticItem.updatedAt
    }));

    try {
      await focusDesktopConversation(selected);
      const result = await request(
        "/api/desktop-remote/messages",
        {
          method: "POST",
          body: JSON.stringify({
            text: prompt,
            settingsPolicy: "useExisting",
            target
          })
        },
        token
      );
      setDesktopRemote(result.state);
    } catch (err) {
      const errorText = err.message || "Failed to send to Codex Desktop.";
      setError(errorText);
      setDesktopRemote((current) => ({
        ...(current || {}),
        active: false,
        pendingCount: Math.max(0, Number(current?.pendingCount || 1) - 1),
        items: (current?.items || []).map((item) => (item.id === optimisticItem.id ? { ...item, status: "failed", error: errorText, updatedAt: new Date().toISOString() } : item))
      }));
      setMessages((items) => appendDisplayMessages(items, [{ role: "error", text: errorText }]));
    }
  }

  async function sendRunningInput(taskId, prompt, displayPrompt = prompt) {
    setMessages((items) => appendDisplayMessages(items, [{ role: "user", text: displayPrompt }]));
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

  async function sendPrompt(prompt, displayPrompt = prompt) {
    if (controlMode === "desktop" || hasDesktopBinding(selected)) {
      await sendDesktopRemote(prompt, displayPrompt);
      return;
    }
    await startTask(prompt, displayPrompt);
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
          <button className="icon-button" title="Live Call" aria-label="Live Call" type="button" onClick={() => setLiveCallOpen(true)}>
            <Phone size={20} />
          </button>
        </header>
        <div className="message-list" ref={listRef} aria-live="polite">
          <WorkspaceWorkbench
            workspaces={workspaces}
            selected={selected}
            token={token}
            toolEvents={toolEvents}
            onError={setError}
            onSummary={setChangeSummary}
            onToolEventsChanged={() => refreshSelectedToolEvents().catch((err) => setError(err.message))}
            openRequest={workspaceOpenRequest}
            onOpenHandled={() => setWorkspaceOpenRequest(null)}
          />
          <ChangeCard
            summary={changeSummary}
            token={token}
            onError={setError}
            onUpdated={(result) => {
              if (!result?.summary) return;
              setChangeSummary((current) => ({
                ...result.summary,
                workspace: result.workspace || current?.workspace,
                cwd: result.cwd || current?.cwd,
                kind: current?.kind || "workspace"
              }));
              refreshSelectedToolEvents().catch((err) => setError(err.message));
            }}
          />
          {desktopMessages.length ? (
            desktopMessages.map((message, index) => {
              const renderKey = message.liveKey || message.turnId || `${index}-${message.role}-${message.pending ? "pending" : "message"}`;
              return (
                <Message
                  key={renderKey}
                  messageKey={renderKey}
                  located={locatedMessageKey === renderKey}
                  token={token}
                  onEdit={handleEditMessage}
                  onDelete={handleDeleteMessage}
                  onRegenerate={(target) => handleRegenerateMessage(target).catch((err) => setError(err.message))}
                  onLocate={locateMessage}
                  onOpenFilePath={openFileFromMessage}
                  {...message}
                />
              );
            })
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
          onRunningInput={(taskId, prompt, displayPrompt) => sendRunningInput(taskId, prompt, displayPrompt).catch((err) => {
            setError(err.message);
            setMessages((items) => appendDisplayMessages(items, [{ role: "error", text: err.message || "Live input failed" }]));
          })}
          onStop={(taskId) => stopRunningTask(taskId).catch((err) => {
            setError(err.message);
            setMessages((items) => appendDisplayMessages(items, [{ role: "error", text: err.message || "Stop failed" }]));
          })}
          onSend={(prompt, displayPrompt) => sendPrompt(prompt, displayPrompt).catch((err) => {
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
      {liveCallOpen ? <button className="sidebar-backdrop" aria-label="Close live call" type="button" onClick={() => setLiveCallOpen(false)} /> : null}
      {liveCallOpen ? <LiveCallPanel token={token} onClose={() => setLiveCallOpen(false)} /> : null}
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
