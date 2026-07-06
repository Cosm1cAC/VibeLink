const TOOL_DEFINITIONS = [
  {
    name: "agent.task",
    kind: "agent",
    label: "Agent task",
    permission: "agent.run",
    risk: "medium",
    description: "Create or resume an upstream CLI agent task.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        cwd: { type: "string" },
        agent: { type: "string", enum: ["codex", "claude"] },
        model: { type: "string" },
        reasoningEffort: { type: "string" },
        security: { type: "object" }
      }
    }
  },
  {
    name: "workspace.command",
    kind: "shell",
    label: "Workspace command",
    permission: "workspace.command",
    risk: "high",
    description: "Run a non-interactive command in a trusted workspace.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        workspaceId: { type: "string" },
        timeoutMs: { type: "number" }
      },
      required: ["command"]
    }
  },
  {
    name: "workspace.test",
    kind: "shell",
    label: "Workspace test",
    permission: "workspace.test",
    risk: "medium",
    description: "Run a test command in a trusted workspace.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        workspaceId: { type: "string" },
        timeoutMs: { type: "number" }
      },
      required: ["command"]
    }
  },
  {
    name: "workspace.terminal_session",
    kind: "shell",
    label: "Terminal session",
    permission: "workspace.terminal",
    risk: "high",
    description: "Start an interactive workspace terminal session using node-pty when available, with spawn fallback.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        taskId: { type: "string" },
        shell: { type: "string" },
        mode: { type: "string", enum: ["auto", "pty", "spawn"] },
        cols: { type: "number" },
        rows: { type: "number" }
      },
      required: ["workspaceId"]
    }
  },
  {
    name: "workspace.git_action",
    kind: "git",
    label: "Git action",
    permission: "workspace.git",
    risk: "medium",
    description: "Run a workspace-level Git operation such as stage, commit, pull, push, or PR.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        message: { type: "string" },
        title: { type: "string" }
      },
      required: ["action"]
    }
  },
  {
    name: "workspace.git_file_action",
    kind: "git",
    label: "Git file action",
    permission: "workspace.git",
    risk: "medium",
    description: "Run a Git operation for one changed file.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        path: { type: "string" }
      },
      required: ["action", "path"]
    }
  },
  {
    name: "system.doctor",
    kind: "system",
    label: "Doctor",
    permission: "system.diagnose",
    risk: "low",
    description: "Run local bridge health checks for runtime, CLI, Git, credentials, network, Desktop remote, and event storage."
  },
  {
    name: "system.codex_app_server_probe",
    kind: "system",
    label: "Codex app-server probe",
    permission: "system.probe",
    risk: "medium",
    description: "Run the Codex app-server compatibility probe and record structured results."
  },
  {
    name: "desktop.draft_probe",
    kind: "desktop",
    label: "Desktop draft probe",
    permission: "desktop.probe",
    risk: "medium",
    description: "Probe Codex Desktop composer access without sending a user task."
  },
  {
    name: "mcp.status",
    kind: "plugin",
    label: "MCP status",
    permission: "plugin.mcp",
    risk: "low",
    description: "List configured MCP servers known to VibeLink."
  },
  {
    name: "mcp.probe",
    kind: "plugin",
    label: "MCP probe",
    permission: "plugin.mcp",
    risk: "medium",
    description: "Connect to configured MCP servers and read their tools/list metadata through the VibeLink runtime."
  },
  {
    name: "browser.fetch",
    kind: "browser",
    label: "Browser fetch",
    permission: "browser.operate",
    risk: "medium",
    description: "Fetch an HTTP or HTTPS page, extract metadata and text summary, and record the operation as a runtime tool."
  },
  {
    name: "shell_command",
    kind: "shell",
    label: "Shell command",
    permission: "agent.tool.shell",
    risk: "high",
    description: "Observed upstream shell command tool call."
  },
  {
    name: "exec_command",
    kind: "shell",
    label: "Exec command",
    permission: "agent.tool.shell",
    risk: "high",
    description: "Observed upstream command execution tool call."
  },
  {
    name: "apply_patch",
    kind: "file",
    label: "Patch edit",
    permission: "agent.tool.file.write",
    risk: "medium",
    description: "Observed upstream patch edit tool call."
  },
  {
    name: "mcp.*",
    kind: "plugin",
    label: "MCP tool",
    permission: "plugin.mcp",
    risk: "medium",
    description: "Observed MCP or plugin tool call."
  },
  {
    name: "browser.*",
    kind: "browser",
    label: "Browser tool",
    permission: "browser.operate",
    risk: "medium",
    description: "Observed browser automation tool call."
  },
  {
    name: "approval.*",
    kind: "approval",
    label: "Approval",
    permission: "approval.decide",
    risk: "high",
    description: "Approval request or decision event."
  }
];

function matchesPattern(name, pattern) {
  if (pattern === name) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

function inferKind(toolName = "") {
  const value = String(toolName || "").toLowerCase();
  if (/approval|confirm|permission/.test(value)) return "approval";
  if (/browser|page|playwright|chrome|screenshot/.test(value)) return "browser";
  if (/mcp|plugin|connector|resource|skill/.test(value)) return "plugin";
  if (/git/.test(value)) return "git";
  if (/shell|bash|exec|command|powershell|cmd|js|repl/.test(value)) return "shell";
  if (/file|read|write|edit|patch|diff/.test(value)) return "file";
  if (/task|agent/.test(value)) return "agent";
  if (/desktop/.test(value)) return "desktop";
  if (/doctor|probe|system/.test(value)) return "system";
  return "tool";
}

function fallbackDefinition(toolName = "") {
  const kind = inferKind(toolName);
  return {
    name: toolName || "tool",
    kind,
    label: toolName || "Tool",
    permission: `agent.tool.${kind}`,
    risk: kind === "shell" || kind === "approval" ? "high" : "medium",
    description: "Observed upstream tool call."
  };
}

export function listToolRegistry() {
  return TOOL_DEFINITIONS.map((item) => ({ ...item }));
}

export function getToolDefinition(toolName = "") {
  const name = String(toolName || "");
  const exact = TOOL_DEFINITIONS.find((item) => item.name === name);
  if (exact) return { ...exact, matchedBy: "exact" };
  const pattern = TOOL_DEFINITIONS.find((item) => matchesPattern(name, item.name));
  if (pattern) return { ...pattern, name, pattern: pattern.name, matchedBy: "pattern" };
  return { ...fallbackDefinition(name), matchedBy: "fallback" };
}

export function classifyToolName(toolName = "") {
  return getToolDefinition(toolName).kind;
}
