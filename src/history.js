import fs from "node:fs";
import path from "node:path";
import { getHomeDir } from "./config.js";
import { readJsonLines } from "./store.js";

const MAX_HISTORY_FILES = 600;
const HISTORY_DETAIL_LINES = 3000;
const HISTORY_CLIENT_TRANSCRIPT_LIMIT = 220;
const HISTORY_CLIENT_TURN_LIMIT = 120;
const HISTORY_LIST_CACHE_MS = 10000;

let historyListCache = {
  expiresAt: 0,
  items: null
};

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

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readFirstJsonLine(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const line = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0];
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

function walkFiles(root, predicate, limit = MAX_HISTORY_FILES) {
  const results = [];
  if (!fs.existsSync(root)) return results;

  const stack = [root];

  while (stack.length && results.length < limit) {
    const current = stack.pop();
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .map((entry) => {
        const fullPath = path.join(current, entry.name);
        return {
          entry,
          fullPath,
          mtime: safeStat(fullPath)?.mtimeMs || 0
        };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const directories = [];

    for (const { entry, fullPath } of entries) {
      if (entry.isDirectory()) {
        directories.push(fullPath);
      } else if (predicate(fullPath, entry.name)) {
        results.push(fullPath);
      }

      if (results.length >= limit) break;
    }

    stack.push(...directories.reverse());
  }

  return results;
}

function decodeMaybeMojibake(value) {
  if (!value || typeof value !== "string") return "";
  return value;
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

function contentBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) {
    const text = firstTextFromContent(content);
    return text ? [{ type: content?.type || "text", text }] : [];
  }

  return content
    .map((item) => {
      if (typeof item === "string") return { type: "text", text: item };
      if (!item || typeof item !== "object") return null;
      if (item.type === "text" || item.type === "output_text" || item.type === "input_text") {
        return { type: "text", text: item.text || item.content || "" };
      }
      if (item.type === "tool_use") {
        return {
          type: "tool_use",
          id: item.id || "",
          name: item.name || "",
          input: item.input || {}
        };
      }
      if (item.type === "tool_result") {
        return {
          type: "tool_result",
          toolUseId: item.tool_use_id || item.toolUseId || "",
          text: firstTextFromContent(item.content) || item.content || ""
        };
      }
      if (item.type === "image" || item.type === "input_image") {
        const imageUrl = typeof item.image_url === "string" ? item.image_url : item.image_url?.url;
        return {
          type: "image",
          path: item.path || imageUrl || item.url || "",
          text: item.text || ""
        };
      }
      return {
        type: item.type || "block",
        text: firstTextFromContent(item),
        raw: item
      };
    })
    .filter(Boolean)
    .filter((item) => item.text || item.name || item.path || item.id || item.toolUseId);
}

function extractText(item) {
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

function historyEntryKind(item) {
  const payload = item?.payload || {};
  const message = item?.message || payload.message || item || {};
  return String(message.type || payload.type || item?.type || "").toLowerCase();
}

function entryRole(item) {
  const payload = item.payload || {};
  const message = item.message || payload.message || item;
  const raw = item.role || message.role || payload.role || payload.type || item.type || "";
  if (raw === "user" || raw === "stdin" || raw === "user_message") return "user";
  if (raw === "assistant" || raw === "json" || raw === "stdout" || raw === "agent_message" || raw === "assistant_message") return "assistant";
  if (raw === "error" || raw === "stderr") return "error";
  return "system";
}

function pushTranscript(transcript, entry) {
  if (!entry || (!entry.text && !entry.blocks?.length && !entry.meta)) return;
  const previous = transcript[transcript.length - 1];
  if (
    previous &&
    previous.role === entry.role &&
    previous.kind === entry.kind &&
    previous.timestamp === entry.timestamp &&
    entry.text &&
    previous.text === entry.text
  ) {
    return;
  }
  transcript.push(entry);
}

function isClientTranscriptEntry(entry) {
  if (!entry?.text && !entry?.commands?.length) return false;
  if (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "error") return false;
  if (INTERNAL_HISTORY_KINDS.has(String(entry.kind || "").toLowerCase())) return false;
  if (isNoiseText(entry.text)) return false;
  return true;
}

function toolText(block) {
  if (!block) return "";
  if (block.type === "tool_use") {
    const input = Object.keys(block.input || {}).length ? ` ${JSON.stringify(block.input)}` : "";
    return `Tool: ${block.name || "tool"}${input}`;
  }
  if (block.type === "tool_result") return `Tool result: ${String(block.text || "").slice(0, 4000)}`;
  if (block.type === "image") return block.path ? `Image: ${block.path}` : block.text || "Image";
  return block.text || "";
}

function turnIdForItem(item) {
  const payload = item?.payload || {};
  const message = item?.message || payload.message || {};
  return (
    payload.turn_id ||
    payload.turnId ||
    payload.internal_chat_message_metadata_passthrough?.turn_id ||
    message.internal_chat_message_metadata_passthrough?.turn_id ||
    item?.internal_chat_message_metadata_passthrough?.turn_id ||
    item?.turn_id ||
    ""
  );
}

function normalizeComparableText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function visibleImageMarkdown(pathValue, alt = "image") {
  const value = String(pathValue || "").trim();
  if (!value || /^data:/i.test(value)) return "";
  return `![${alt}](${value})`;
}

function convertCodexImageTags(text) {
  return String(text || "")
    .replace(/<image\b([^>]*)>/gi, (full, attrs = "") => {
      const pathMatch = attrs.match(/\bpath="([^"]+)"/i);
      if (!pathMatch?.[1]) return "";
      const nameMatch = attrs.match(/\bname=\[?([^\]\s"]+)/i);
      return visibleImageMarkdown(pathMatch[1], nameMatch?.[1] || "image");
    })
    .replace(/<\/image>/gi, "")
    .trim();
}

function turnBlockText(payload, item) {
  const blocks = contentBlocks(payload.content || item.content);
  const text = blocks
    .map((block) => {
      if (block.type === "image") return visibleImageMarkdown(block.path, "image") || block.text || "";
      return convertCodexImageTags(toolText(block));
    })
    .filter(Boolean)
    .join("\n\n");
  return text || convertCodexImageTags(extractText(item));
}

function appendTurnPart(block, part) {
  const text = String(part.text || "").trim();
  if (!text || isNoiseText(text)) return;

  const normalized = normalizeComparableText(text);
  const duplicated = block.parts.some((existing) => {
    const current = normalizeComparableText(existing.text);
    if (current === normalized) return true;
    const shorter = Math.min(current.length, normalized.length);
    return shorter > 120 && (current.includes(normalized) || normalized.includes(current));
  });
  if (duplicated) return;

  block.parts.push({
    kind: part.kind || "message",
    timestamp: part.timestamp || "",
    text
  });
  block.timestamp = block.timestamp || part.timestamp || "";
  block.text = block.parts.map((item) => item.text).filter(Boolean).join("\n\n");
}

function parseCallArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function isCommandLikeTool(name) {
  return ["shell_command", "exec_command", "js", "apply_patch"].includes(String(name || ""));
}

function compactToolOutput(value) {
  const text = String(value || "");
  return text.length > 6000 ? `${text.slice(0, 6000)}\n...` : text;
}

function commandFromCall(payload, timestamp) {
  const name = payload.name || payload.type || "tool";
  if (!isCommandLikeTool(name)) return null;

  const args = parseCallArguments(payload.arguments || payload.input || {});
  const command =
    args.command ||
    args.cmd ||
    args.code ||
    args.patch ||
    args.raw ||
    (Object.keys(args).length ? JSON.stringify(args) : name);
  return {
    id: payload.call_id || payload.id || `${name}:${timestamp}`,
    name,
    namespace: payload.namespace || "",
    command: String(command || name),
    workdir: args.workdir || args.cwd || "",
    timeoutMs: args.timeout_ms || args.timeoutMs || null,
    status: "running",
    timestamp,
    output: ""
  };
}

function updateCommandOutput(command, payload, timestamp) {
  const output = compactToolOutput(payload.output || payload.stdout || payload.stderr || payload.error || "");
  command.output = output;
  command.completedAt = timestamp;
  if (/Exit code:\s*0\b/i.test(output)) command.status = "done";
  else if (/Exit code:\s*[1-9]\d*\b/i.test(output) || payload.error) command.status = "failed";
  else command.status = "done";
}

function ensureTurn(turnsById, orderedTurns, id) {
  let turn = turnsById.get(id);
  if (turn) return turn;

  turn = {
    id,
    startedAt: "",
    completedAt: "",
    durationMs: null,
    timeToFirstTokenMs: null,
    user: { role: "user", kind: "turn", turnId: id, timestamp: "", text: "", parts: [] },
    assistant: { role: "assistant", kind: "turn", turnId: id, timestamp: "", text: "", parts: [], commands: [] }
  };
  turnsById.set(id, turn);
  orderedTurns.push(turn);
  return turn;
}

function transcriptFromTurnBlocks(entries, provider) {
  if (provider !== "codex") return [];

  const turnsById = new Map();
  const orderedTurns = [];
  const commandsByCallId = new Map();

  for (const item of entries) {
    const payload = item.payload || {};
    const payloadType = payload.type || "";
    const timestamp = item.timestamp || payload.timestamp || "";
    const turnId = turnIdForItem(item);
    if (!turnId) continue;

    const turn = ensureTurn(turnsById, orderedTurns, turnId);
    if (payloadType === "task_started") {
      turn.startedAt = timestamp || turn.startedAt;
      continue;
    }

    if (payloadType === "task_complete") {
      turn.completedAt = timestamp || turn.completedAt;
      turn.durationMs = Number.isFinite(Number(payload.duration_ms)) ? Number(payload.duration_ms) : turn.durationMs;
      turn.timeToFirstTokenMs = Number.isFinite(Number(payload.time_to_first_token_ms)) ? Number(payload.time_to_first_token_ms) : turn.timeToFirstTokenMs;
      continue;
    }

    if (item.type !== "response_item") continue;

    if (/function_call$/i.test(payloadType)) {
      const command = commandFromCall(payload, timestamp);
      if (!command) continue;
      turn.assistant.commands.push(command);
      if (command.id) commandsByCallId.set(command.id, command);
      continue;
    }

    if (/function_call_output$/i.test(payloadType)) {
      const command = commandsByCallId.get(payload.call_id || payload.id || "");
      if (command) updateCommandOutput(command, payload, timestamp);
      continue;
    }

    if (payloadType === "message") {
      const role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : "";
      if (!role) continue;
      appendTurnPart(turn[role], {
        kind: payloadType,
        timestamp,
        text: turnBlockText(payload, item)
      });
    }
  }

  const transcript = [];
  for (const turn of orderedTurns) {
    if (turn.user.text) {
      transcript.push({
        ...turn.user,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        parts: turn.user.parts
      });
    }

    if (turn.assistant.text || turn.assistant.commands.length) {
      transcript.push({
        ...turn.assistant,
        timestamp: turn.assistant.timestamp || turn.completedAt || turn.startedAt,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        durationMs: turn.durationMs,
        timeToFirstTokenMs: turn.timeToFirstTokenMs,
        commandCount: turn.assistant.commands.length,
        commands: turn.assistant.commands,
        parts: turn.assistant.parts
      });
    }
  }

  return transcript;
}

function trimLeadingOrphanTurn(transcript) {
  let start = 0;
  while (start < transcript.length && transcript[start]?.role === "assistant") start += 1;
  return start ? transcript.slice(start) : transcript;
}

function buildSessionState(entries, fallback = {}) {
  const state = {
    id: fallback.id || "",
    provider: fallback.provider || "",
    title: fallback.title || "",
    cwd: fallback.projectPath || "",
    model: "",
    modelProvider: "",
    cliVersion: "",
    originator: "",
    mode: "",
    permissionMode: "",
    threadSource: "",
    lastPrompt: "",
    leafId: "",
    updatedAt: fallback.updatedAt || "",
    filePath: fallback.filePath || "",
    toolCallCount: 0,
    toolResultCount: 0,
    messageCount: 0,
    attachmentCount: 0
  };

  for (const item of entries) {
    const payload = item.payload || {};
    const message = item.message || payload.message || item;
    const meta = item.type === "session_meta" ? payload : {};
    state.id = state.id || payload.session_id || payload.sessionId || item.sessionId || meta.id || "";
    state.cwd = state.cwd || payload.cwd || item.cwd || "";
    state.model = state.model || message.model || payload.model || "";
    state.modelProvider = state.modelProvider || meta.model_provider || "";
    state.cliVersion = state.cliVersion || meta.cli_version || item.version || "";
    state.originator = state.originator || meta.originator || item.entrypoint || "";
    state.threadSource = state.threadSource || meta.thread_source || "";
    if (item.type === "mode") state.mode = item.mode || "";
    if (item.type === "permission-mode") state.permissionMode = item.permissionMode || "";
    if (item.type === "ai-title" && item.aiTitle) state.title = item.aiTitle;
    if (item.type === "last-prompt") {
      state.lastPrompt = item.lastPrompt || "";
      state.leafId = item.leafUuid || "";
    }
    if (item.type === "attachment") state.attachmentCount += 1;
    const payloadType = payload.type || item.type || "";
    if (/function_call|custom_tool_call|tool_use/i.test(payloadType)) state.toolCallCount += 1;
    if (/function_call_output|tool_result|patch_apply_end/i.test(payloadType)) state.toolResultCount += 1;
    for (const block of contentBlocks(message.content || payload.content || item.content)) {
      if (block.type === "tool_use") state.toolCallCount += 1;
      if (block.type === "tool_result") state.toolResultCount += 1;
    }
    if (message.role || item.type === "event_msg" || item.type === "response_item") state.messageCount += 1;
  }

  return state;
}

function transcriptFromEntries(entries, provider) {
  const transcript = [];

  for (const item of entries) {
    const payload = item.payload || {};
    const message = item.message || payload.message || item;
    const timestamp = item.timestamp || payload.timestamp || "";

    if (item.type === "session_meta") {
      pushTranscript(transcript, {
        role: "system",
        kind: "session",
        timestamp,
        text: `Session started in ${payload.cwd || ""}`.trim(),
        meta: {
          cwd: payload.cwd || "",
          modelProvider: payload.model_provider || "",
          cliVersion: payload.cli_version || "",
          originator: payload.originator || ""
        }
      });
      continue;
    }

    if (item.type === "mode" || item.type === "permission-mode" || item.type === "ai-title" || item.type === "last-prompt") {
      const text =
        item.type === "ai-title"
          ? `Title: ${item.aiTitle || ""}`
          : item.type === "last-prompt"
            ? `Last prompt: ${item.lastPrompt || ""}`
            : item.type === "mode"
              ? `Mode: ${item.mode || ""}`
              : `Permission mode: ${item.permissionMode || ""}`;
      pushTranscript(transcript, { role: "system", kind: item.type, timestamp, text, meta: item });
      continue;
    }

    if (item.type === "attachment") {
      const attachment = item.attachment || {};
      pushTranscript(transcript, {
        role: "system",
        kind: "attachment",
        timestamp,
        text: attachment.content || attachment.addedLines?.join("\n") || attachment.type || "Attachment",
        meta: attachment
      });
      continue;
    }

    if (item.type === "event_msg") {
      pushTranscript(transcript, {
        role: entryRole(item),
        kind: payload.type || "event",
        timestamp,
        text: payload.message || payload.info ? (typeof payload.info === "string" ? payload.info : payload.message || JSON.stringify(payload.info)) : extractText(item),
        meta: payload
      });
      continue;
    }

    if (item.type === "response_item") {
      const blocks = contentBlocks(payload.content || item.content);
      const callArgs = payload.arguments
        ? typeof payload.arguments === "string"
          ? payload.arguments
          : JSON.stringify(payload.arguments)
        : "";
      const toolOutput = payload.output || payload.stdout || payload.stderr || payload.error || "";
      const fallbackText =
        /function_call|custom_tool_call/i.test(payload.type || "")
          ? `Tool call: ${payload.name || payload.type || "tool"}${callArgs ? ` ${callArgs}` : ""}`
          : /function_call_output|patch_apply_end/i.test(payload.type || "")
            ? `Tool output: ${toolOutput}`
            : extractText(item);
      const text = blocks.map(toolText).filter(Boolean).join("\n\n") || fallbackText;
      pushTranscript(transcript, {
        role: entryRole(item),
        kind: payload.type || "response_item",
        timestamp,
        text,
        blocks,
        meta: {
          id: payload.id || "",
          type: payload.type || "",
          name: payload.name || "",
          callId: payload.call_id || "",
          phase: payload.phase || ""
        }
      });
      continue;
    }

    if (message.role || item.type === "user" || item.type === "assistant") {
      const blocks = contentBlocks(message.content);
      const text = blocks.map(toolText).filter(Boolean).join("\n\n") || extractText(item);
      pushTranscript(transcript, {
        role: entryRole(item),
        kind: message.type || item.type || "message",
        timestamp,
        text,
        blocks,
        meta: {
          uuid: item.uuid || "",
          parentUuid: item.parentUuid || "",
          model: message.model || "",
          stopReason: message.stop_reason || "",
          cwd: item.cwd || "",
          sessionId: item.sessionId || ""
        }
      });
      continue;
    }

    const text = extractText(item);
    if (text) {
      pushTranscript(transcript, {
        role: entryRole(item),
        kind: item.type || "entry",
        timestamp,
        text,
        meta: provider === "claude" ? { uuid: item.uuid || "", parentUuid: item.parentUuid || "" } : {}
      });
    }
  }

  return transcript;
}

function isNoiseText(text) {
  const value = String(text || "").trim();
  return (
    /^<environment_context>/i.test(value) ||
    /^<permissions instructions>/i.test(value) ||
    /^reasoning:\s*(assistant|user|system)\s*:/i.test(value) ||
    /^summary:\s*(assistant|user|system)\s*:/i.test(value) ||
    /^conversation summary\b/i.test(value)
  );
}

function isPreviewNoiseEntry(item, text) {
  return INTERNAL_HISTORY_KINDS.has(historyEntryKind(item)) || isNoiseText(text);
}

function summarizeJsonl(filePath, provider, projectPath = "") {
  const stat = safeStat(filePath);
  const entries = readJsonLines(filePath, 80);
  const first = readFirstJsonLine(filePath);
  const meta = first?.payload || {};
  const id = meta.session_id || meta.id || path.basename(filePath).replace(/\.jsonl$/i, "");
  const cwd = projectPath || meta.cwd || "";
  const texts = [];

  for (const item of entries) {
    if (item.type === "session_meta" || item.type === "turn_context") continue;

    const payload = item.payload || {};
    const message = item.message || payload.message || item;
    const role = item.role || message.role || payload.role || payload.type || item.type || "";
    const text = extractText(item);

    if (text && !isPreviewNoiseEntry(item, text)) texts.push({ role, text });
  }

  const title =
    texts.find((entry) => entry.role === "user" && !isNoiseText(entry.text))?.text ||
    texts.find((entry) => entry.text && !isNoiseText(entry.text))?.text ||
    id;

  return {
    id,
    provider,
    title: decodeMaybeMojibake(String(title)).slice(0, 120),
    projectPath: cwd,
    updatedAt: stat?.mtime?.toISOString() || "",
    filePath,
    preview: texts
      .slice(-6)
      .map((entry) => `${entry.role || "message"}: ${entry.text}`)
      .join("\n\n")
      .slice(0, 4000)
  };
}

function codexSessionsFromIndex(home) {
  const indexPath = path.join(home, ".codex", "session_index.jsonl");
  if (!fs.existsSync(indexPath)) return [];

  return readJsonLines(indexPath, 500)
    .map((item) => ({
      id: item.id,
      provider: "codex",
      title: decodeMaybeMojibake(item.thread_name || item.id || "Codex session"),
      projectPath: item.cwd || "",
      updatedAt: item.updated_at || "",
      filePath: "",
      preview: "",
      source: "index"
    }))
    .filter((item) => item.id)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 300);
}

function codexSessionsFromFiles(home) {
  const root = path.join(home, ".codex", "sessions");
  return walkFiles(root, (filePath, name) => name.endsWith(".jsonl"))
    .map((filePath) => summarizeJsonl(filePath, "codex"))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 300);
}

function claudeProjectPath(projectDirName) {
  if (!projectDirName) return "";
  const marker = "--";
  const parts = projectDirName.split(marker).filter(Boolean);
  if (!parts.length) return "";
  return parts.join(path.sep).replace(/^([A-Za-z])\\/, "$1:\\");
}

function claudeSessions(home) {
  const projectsRoot = path.join(home, ".claude", "projects");
  if (!fs.existsSync(projectsRoot)) return [];

  const files = walkFiles(projectsRoot, (filePath, name) => name.endsWith(".jsonl"), 600);
  return files
    .map((filePath) => {
      const projectDir = path.basename(path.dirname(filePath));
      return summarizeJsonl(filePath, "claude", claudeProjectPath(projectDir));
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 300);
}

export function listHistories() {
  const current = Date.now();
  if (historyListCache.items && historyListCache.expiresAt > current) {
    return historyListCache.items;
  }

  const home = getHomeDir();
  const codexById = new Map();

  for (const item of [...codexSessionsFromFiles(home), ...codexSessionsFromIndex(home)]) {
    if (!item.id) continue;
    const existing = codexById.get(item.id);

    if (!existing) {
      codexById.set(item.id, item);
      continue;
    }

    const itemTime = new Date(item.updatedAt || 0).getTime();
    const existingTime = new Date(existing.updatedAt || 0).getTime();
    const titleLooksGenerated = /^rollout-/.test(existing.title || "") || existing.title === existing.id;

    codexById.set(item.id, {
      ...existing,
      title: (item.source === "index" || titleLooksGenerated) && item.title ? item.title : existing.title,
      projectPath: existing.projectPath || item.projectPath,
      updatedAt: itemTime > existingTime ? item.updatedAt : existing.updatedAt,
      filePath: existing.filePath || item.filePath,
      preview: existing.preview || item.preview
    });
  }

  const items = [...codexById.values(), ...claudeSessions(home)]
    .map(({ source, ...item }) => item)
    .sort((a, b) => {
      const bt = new Date(b.updatedAt || 0).getTime();
      const at = new Date(a.updatedAt || 0).getTime();
      return bt - at;
    });
  historyListCache = {
    expiresAt: current + HISTORY_LIST_CACHE_MS,
    items
  };
  return items;
}

export function getHistory(provider, id) {
  const found = listHistories().find((item) => item.provider === provider && item.id === id);
  if (!found) return null;

  if (found.filePath && fs.existsSync(found.filePath)) {
    const entries = readJsonLines(found.filePath, HISTORY_DETAIL_LINES);
    const sessionState = buildSessionState(entries, found);
    const legacyTranscript = transcriptFromEntries(entries, provider);
    const turnTranscript = transcriptFromTurnBlocks(entries, provider);
    const transcript = turnTranscript.length ? trimLeadingOrphanTurn(turnTranscript) : legacyTranscript;
    const clientTranscript = transcript.filter(isClientTranscriptEntry);
    return {
      ...found,
      sessionState,
      transcript: clientTranscript.slice(-(turnTranscript.length ? HISTORY_CLIENT_TURN_LIMIT : HISTORY_CLIENT_TRANSCRIPT_LIMIT)),
      rawTranscriptCount: legacyTranscript.length,
      clientTranscriptCount: clientTranscript.length,
      turnTranscriptCount: turnTranscript.length,
      entryCount: entries.length
    };
  }

  return {
    ...found,
    sessionState: buildSessionState([], found),
    transcript: []
  };
}
