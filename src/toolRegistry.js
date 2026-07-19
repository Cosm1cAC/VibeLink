const TOOL_DEFINITIONS = [
  {
    name: "agent.task",
    kind: "agent",
    label: "Agent task",
    permission: "agent.run",
    risk: "medium",
    description: "Create or resume a VibeLink Agent task through a configured provider adapter.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        cwd: { type: "string" },
        agent: { type: "string", enum: ["codex", "claude", "doubao", "zhipu"] },
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
    description: "Start an interactive workspace terminal session on the durable execution host with ConPTY control and output replay.",
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
    name: "workspace.git_worktree",
    kind: "git",
    label: "Git worktree",
    permission: "workspace.git",
    risk: "medium",
    description: "Create a permanent Git worktree for a workspace and register it as a new workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        branchName: { type: "string" },
        baseRef: { type: "string" },
        path: { type: "string" },
        root: { type: "string" }
      },
      required: ["workspaceId", "branchName"]
    },
    outputSchema: {
      type: "object",
      properties: {
        workspace: { type: "object", description: "Registered workspace for the new worktree" },
        path: { type: "string", description: "Absolute worktree path" },
        branchName: { type: "string", description: "Created or checked-out branch name" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "workspace.git_worktree_action",
    kind: "git",
    label: "Git worktree lifecycle",
    permission: "workspace.git",
    risk: "medium",
    description: "Remove, prune, lock, or unlock a Git worktree.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        action: { type: "string", enum: ["remove", "prune", "lock", "unlock"] },
        path: { type: "string" },
        force: { type: "boolean" },
        reason: { type: "string" },
        expire: { type: "string" }
      },
      required: ["workspaceId", "action"]
    },
    outputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        path: { type: "string" },
        worktrees: { type: "array", items: { type: "object" } },
        toolRunId: { type: "string" }
      }
    }
  },
  {
    name: "system.doctor",
    kind: "system",
    label: "Doctor",
    permission: "system.diagnose",
    risk: "low",
    description: "Run local bridge health checks for VibeLink Agent, CLI adapters, Git, credentials, network, Codex Desktop Remote, and event storage.",
    outputSchema: {
      type: "object",
      properties: {
        runtime: { type: "object", description: "Node.js version, platform, uptime" },
        cli: { type: "object", description: "Installed CLI tools and versions" },
        git: { type: "object", description: "Git configuration status" },
        credentials: { type: "object", description: "API key availability" },
        network: { type: "object", description: "Network reachability" },
        desktop: { type: "object", description: "Codex Desktop Remote status" },
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
    name: "agent_reach.status",
    kind: "agent",
    label: "Agent Reach status",
    permission: "agent_reach.read",
    risk: "low",
    description: "Run Agent Reach doctor/status and return installed channel availability.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "number" }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        version: { type: "string" },
        channels: { type: "object" },
        install: { type: "object" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "agent_reach.skill",
    kind: "agent",
    label: "Agent Reach skill",
    permission: "agent_reach.manage",
    risk: "medium",
    description: "Install or uninstall the Agent Reach skill into local agent skill directories.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["install", "uninstall"] },
        timeoutMs: { type: "number" }
      },
      required: ["operation"]
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "integer" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "agent_reach.format",
    kind: "agent",
    label: "Agent Reach format",
    permission: "agent_reach.read",
    risk: "low",
    description: "Format raw platform output through Agent Reach formatters.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["xhs"] },
        input: { description: "Raw platform output as JSON value or JSON string" },
        stdin: { type: "string" },
        timeoutMs: { type: "number" }
      },
      required: ["platform"]
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "integer" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "agent_reach.transcribe",
    kind: "agent",
    label: "Agent Reach transcribe",
    permission: "agent_reach.read",
    risk: "medium",
    description: "Transcribe an audio/video URL or local file through Agent Reach.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        provider: { type: "string", enum: ["auto", "groq", "openai"] },
        timeoutMs: { type: "number" }
      },
      required: ["source"]
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "integer" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "doubao.status",
    kind: "agent",
    label: "Doubao status",
    permission: "doubao.read",
    risk: "low",
    description: "Check the local browser bridge used by the Doubao web CLI.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "Chrome DevTools endpoint, e.g. http://127.0.0.1:9222" },
        url: { type: "string", description: "Doubao web chat URL" },
        timeoutMs: { type: "number" }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        browser: { type: "object" },
        target: { type: "object" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "integer" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "doubao.configure",
    kind: "agent",
    label: "Configure Doubao",
    permission: "doubao.manage",
    risk: "medium",
    description: "Configure the standalone Doubao extension-bridge CLI for one-command agent setup.",
    inputSchema: {
      type: "object",
      properties: {
        noDaemon: { type: "boolean", description: "Write config without starting the bridge daemon" },
        noOpen: { type: "boolean", description: "Write config without opening the Doubao web page" },
        port: { type: "number", description: "Local bridge port, default 45771" },
        url: { type: "string", description: "Doubao web chat URL" },
        timeoutMs: { type: "number" }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "integer" },
        toolRunId: { type: "string", description: "ID of the recorded tool run" }
      }
    }
  },
  {
    name: "doubao.ask",
    kind: "agent",
    label: "Doubao ask",
    permission: "doubao.read",
    risk: "medium",
    description: "Send a prompt to the logged-in Doubao web page through the local browser CLI.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        endpoint: { type: "string", description: "Chrome DevTools endpoint, e.g. http://127.0.0.1:9222" },
        url: { type: "string", description: "Doubao web chat URL" },
        timeoutMs: { type: "number" }
      },
      required: ["prompt"]
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "integer" },
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
