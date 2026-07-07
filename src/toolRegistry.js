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
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID" },
        sessionId: { type: "string", description: "Session ID for SSE event streaming" },
        status: { type: "string", enum: ["pending", "running", "done", "failed"], description: "Task lifecycle status" }
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
    },
    outputSchema: {
      type: "object",
      properties: {
        stdout: { type: "string", description: "Captured standard output" },
        stderr: { type: "string", description: "Captured standard error" },
        exitCode: { type: "integer", description: "Process exit code" },
        timedOut: { type: "boolean", description: "Whether the command timed out" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
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
    },
    outputSchema: {
      type: "object",
      properties: {
        stdout: { type: "string", description: "Captured standard output" },
        stderr: { type: "string", description: "Captured standard error" },
        exitCode: { type: "integer", description: "Process exit code" },
        timedOut: { type: "boolean", description: "Whether the test timed out" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
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
    },
    outputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Terminal session ID" },
        cols: { type: "integer", description: "Terminal width in columns" },
        rows: { type: "integer", description: "Terminal height in rows" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
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
    },
    outputSchema: {
      type: "object",
      properties: {
        stdout: { type: "string", description: "Git command output" },
        exitCode: { type: "integer", description: "Process exit code" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
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
    },
    outputSchema: {
      type: "object",
      properties: {
        applied: { type: "boolean", description: "Whether the file operation was applied" },
        patch: { type: "string", description: "Resulting diff output" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "system.doctor",
    kind: "system",
    label: "Doctor",
    permission: "system.diagnose",
    risk: "low",
    description: "Run local bridge health checks for runtime, CLI, Git, credentials, network, Desktop remote, and event storage.",
    outputSchema: {
      type: "object",
      properties: {
        runtime: { type: "object", description: "Node.js version, platform, uptime" },
        cli: { type: "object", description: "Installed CLI tools and versions" },
        git: { type: "object", description: "Git configuration status" },
        credentials: { type: "object", description: "API key availability" },
        network: { type: "object", description: "Network reachability" },
        desktop: { type: "object", description: "Desktop remote status" },
        events: { type: "object", description: "Event storage health" }
      }
    }
  },
  {
    name: "system.codex_app_server_probe",
    kind: "system",
    label: "Codex app-server probe",
    permission: "system.probe",
    risk: "medium",
    description: "Run the Codex app-server compatibility probe and record structured results.",
    outputSchema: {
      type: "object",
      properties: {
        result: { type: "object", description: "Probe result with capabilities and compatibility" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "desktop.draft_probe",
    kind: "desktop",
    label: "Desktop draft probe",
    permission: "desktop.probe",
    risk: "medium",
    description: "Probe Codex Desktop composer access without sending a user task.",
    outputSchema: {
      type: "object",
      properties: {
        result: { type: "object", description: "Probe result with composer state" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "mcp.status",
    kind: "plugin",
    label: "MCP status",
    permission: "plugin.mcp",
    risk: "low",
    description: "List configured MCP servers known to VibeLink.",
    outputSchema: {
      type: "object",
      properties: {
        servers: { type: "array", items: { type: "object" }, description: "Configured MCP server names and status" }
      }
    }
  },
  {
    name: "mcp.probe",
    kind: "plugin",
    label: "MCP probe",
    permission: "plugin.mcp",
    risk: "medium",
    description: "Connect to configured MCP servers and read their tools/list metadata through the VibeLink runtime.",
    outputSchema: {
      type: "object",
      properties: {
        results: { type: "array", items: { type: "object" }, description: "Per-server probe results with discovered tools" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "mcp.call",
    kind: "plugin",
    label: "MCP tool call",
    permission: "plugin.mcp",
    risk: "medium",
    description: "Call a configured MCP tool through the VibeLink runtime and record the result.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        toolName: { type: "string" },
        fullName: { type: "string", description: "Optional full VibeLink MCP tool name, e.g. mcp__server__tool." },
        arguments: { type: "object" },
        timeoutMs: { type: "number" }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        status: { type: "string" },
        server: { type: "object" },
        toolName: { type: "string" },
        content: { type: "array", items: { type: "object" } },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "browser.fetch",
    kind: "browser",
    label: "Browser fetch",
    permission: "browser.operate",
    risk: "medium",
    description: "Fetch an HTTP or HTTPS page, extract metadata and text summary, and record the operation as a runtime tool.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST"] },
        headers: { type: "object" },
        body: { type: "string" }
      },
      required: ["url"]
    },
    outputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "Raw HTML content" },
        text: { type: "string", description: "Extracted text summary" },
        url: { type: "string", description: "Final URL after redirects" },
        statusCode: { type: "integer", description: "HTTP response status code" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "shell_command",
    kind: "shell",
    label: "Shell command",
    permission: "agent.tool.shell",
    risk: "high",
    description: "Observed upstream shell command tool call.",
    outputSchema: {
      type: "object",
      properties: {
        stdout: { type: "string", description: "Standard output from the command" },
        stderr: { type: "string", description: "Standard error from the command" },
        exitCode: { type: "integer", description: "Command exit code" }
      }
    }
  },
  {
    name: "exec_command",
    kind: "shell",
    label: "Exec command",
    permission: "agent.tool.shell",
    risk: "high",
    description: "Observed upstream command execution tool call.",
    outputSchema: {
      type: "object",
      properties: {
        stdout: { type: "string", description: "Standard output from the command" },
        stderr: { type: "string", description: "Standard error from the command" },
        exitCode: { type: "integer", description: "Command exit code" }
      }
    }
  },
  {
    name: "apply_patch",
    kind: "file",
    label: "Patch edit",
    permission: "agent.tool.file.write",
    risk: "medium",
    description: "Observed upstream patch edit tool call.",
    outputSchema: {
      type: "object",
      properties: {
        applied: { type: "boolean", description: "Whether the patch was applied" },
        path: { type: "string", description: "Target file path" },
        diff: { type: "string", description: "Resulting diff" }
      }
    }
  },
  {
    name: "mcp.*",
    kind: "plugin",
    label: "MCP tool",
    permission: "plugin.mcp",
    risk: "medium",
    description: "Observed MCP or plugin tool call.",
    outputSchema: null
  },
  {
    name: "browser.*",
    kind: "browser",
    label: "Browser tool",
    permission: "browser.operate",
    risk: "medium",
    description: "Observed browser automation tool call.",
    outputSchema: null
  },
  {
    name: "approval.*",
    kind: "approval",
    label: "Approval",
    permission: "approval.decide",
    risk: "high",
    description: "Approval request or decision event.",
    outputSchema: null
  }
];

function normalizeCachedMcpTool(tool = {}) {
  const name = tool.fullName || tool.full_name || "";
  if (!name) return null;
  return {
    name,
    kind: "plugin",
    label: tool.title || tool.tool_name || tool.toolName || name,
    permission: "plugin.mcp",
    risk: "medium",
    description: tool.description || "Discovered MCP tool.",
    inputSchema: tool.inputSchema || tool.input_schema || null,
    outputSchema: null,
    source: {
      type: "mcp",
      server: tool.server_name || tool.serverName || "",
      toolName: tool.tool_name || tool.toolName || ""
    }
  };
}

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

export function listToolRegistry({ mcpTools = [] } = {}) {
  const dynamicMcpTools = Array.isArray(mcpTools)
    ? mcpTools.map(normalizeCachedMcpTool).filter(Boolean)
    : [];
  const seen = new Set(TOOL_DEFINITIONS.map((item) => item.name));
  return [
    ...TOOL_DEFINITIONS.map((item) => ({ ...item })),
    ...dynamicMcpTools.filter((item) => {
      if (seen.has(item.name)) return false;
      seen.add(item.name);
      return true;
    })
  ];
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
