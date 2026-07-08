function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toolStatusText(status = "", running = false) {
  const value = String(status || "").toLowerCase();
  if (running || value === "running" || value === "started") return "正在运行";
  if (value === "queued" || value === "pending") return "排队中";
  if (value === "approval_required") return "等待审批";
  if (value === "failed" || value === "error" || value === "expired") return "运行失败";
  if (value === "cancelled" || value === "cancelling") return "已取消";
  return "已运行";
}

function toolPrimaryText(tool = {}) {
  const input = tool.input || {};
  const command = input.command || input.cmd || input.shell || "";
  if (command) return cleanText(command);
  return cleanText(tool.label || tool.name || tool.kind || "tool");
}

function toolDetailText(tool = {}) {
  const parts = [];
  if (tool.name) parts.push(tool.name);
  if (tool.output && typeof tool.output === "string") parts.push(tool.output);
  else if (tool.output) {
    try {
      parts.push(JSON.stringify(tool.output, null, 2));
    } catch {
      parts.push(String(tool.output));
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

export function remoteCommandSummary(command = {}) {
  return {
    type: "tool",
    source: "command",
    statusText: toolStatusText(command.status, command.status === "running"),
    label: cleanText(command.command || command.name || "command"),
    detail: [command.workdir, command.output].filter(Boolean).join("\n\n")
  };
}

export function remoteToolSummary(tool = {}) {
  return {
    type: "tool",
    source: "tool",
    statusText: toolStatusText(tool.status),
    label: toolPrimaryText(tool),
    detail: toolDetailText(tool)
  };
}

export function remoteTranscriptItems(messages = []) {
  const items = [];

  for (const [messageIndex, message] of messages.entries()) {
    const baseKey = message.liveKey || message.turnId || `${messageIndex}-${message.role || "message"}`;
    const text = String(message.text || "").trim();

    if (text) {
      items.push({
        type: message.role === "system" || message.role === "log" ? "status" : "message",
        key: `${baseKey}:text`,
        role: message.role || "assistant",
        text,
        pending: Boolean(message.pending),
        typing: Boolean(message.typing),
        typingKey: message.typingKey || baseKey,
        live: Boolean(message.live),
        streaming: Boolean(message.streaming),
        turnId: message.turnId || "",
        liveKey: message.liveKey || ""
      });
    }

    for (const [commandIndex, command] of (message.commands || []).entries()) {
      const summary = remoteCommandSummary(command);
      if (!summary.label) continue;
      items.push({
        ...summary,
        key: `${baseKey}:command:${command.id || commandIndex}`
      });
    }

    const commandCount = Number(message.commandCount || 0);
    if (commandCount > 0 && !(message.commands || []).length) {
      items.push({
        type: "tool",
        source: "command-count",
        key: `${baseKey}:command-count`,
        statusText: message.commandRunning || message.running ? "正在运行" : "已运行",
        label: `${commandCount} 条命令`,
        detail: ""
      });
    }

    for (const [toolIndex, tool] of (message.toolCalls || []).entries()) {
      const summary = remoteToolSummary(tool);
      if (!summary.label) continue;
      items.push({
        ...summary,
        key: `${baseKey}:tool:${tool.id || tool.callId || tool.toolCallId || toolIndex}`
      });
    }
  }

  return items;
}
