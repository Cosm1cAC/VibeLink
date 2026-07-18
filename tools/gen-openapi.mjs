#!/usr/bin/env node
/**
 * Generate OpenAPI 3.0 specification for the VibeLink HTTP API.
 *
 * Usage:
 *   node tools/gen-openapi.mjs          # prints JSON to stdout
 *   node tools/gen-openapi.mjs > docs/openapi.json  # save to file
 */
const BASE_URL = "http://localhost:5177";

// ── Reusable schema objects ──

const schemas = {
  Error: {
    type: "object",
    properties: {
      error: { type: "string", description: "Human-readable error message." }
    }
  },
  ValidationError: {
    type: "object",
    properties: {
      error: { type: "string", example: "Validation failed" },
      details: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string", example: "command" },
            message: { type: "string", example: "Command is required" },
            code: { type: "string", example: "too_small" }
          }
        }
      }
    }
  },
  RateLimitError: {
    type: "object",
    properties: {
      error: { type: "string", example: "Rate limit exceeded." },
      retryAfterMs: { type: "integer", example: 45000 }
    }
  },
  ApprovalRequired: {
    type: "object",
    properties: {
      error: { type: "string" },
      approval: { type: "object" },
      approvalId: { type: "string" },
      toolRun: { type: "object" },
      toolRunId: { type: "string" },
      reasons: { type: "array", items: { type: "string" } },
      matches: { type: "array", items: { type: "string" } },
      policy: { type: "object" }
    }
  },
  DryRunResponse: {
    type: "object",
    properties: {
      dryRun: { type: "boolean", example: true },
      approvalRequired: { type: "boolean" },
      risk: { type: "object" }
    }
  },
  ProviderHealth: {
    type: "object",
    required: ["ok", "status", "cacheStatus", "source", "checkedAt", "expiresAt", "error"],
    properties: {
      ok: { type: "boolean", nullable: true },
      status: { type: "string", enum: ["ready", "unavailable", "disabled", "missing_credentials", "unknown"] },
      cacheStatus: { type: "string", enum: ["fresh", "cached", "stale", "refreshing", "builtin"] },
      source: { type: "string" },
      checkedAt: { type: "string", description: "ISO timestamp, or empty when no runtime loader exists." },
      expiresAt: { type: "string", description: "ISO timestamp, or empty when no runtime loader exists." },
      latencyMs: { type: "integer", nullable: true },
      version: { type: "string" },
      error: { type: "string" }
    }
  },
  ProviderCatalog: {
    type: "object",
    required: ["status", "source", "fetchedAt", "expiresAt", "error"],
    properties: {
      status: { type: "string", enum: ["builtin", "fresh", "cached", "stale", "refreshing", "fallback"] },
      source: { type: "string" },
      fetchedAt: { type: "string", description: "ISO timestamp, or empty for a built-in catalog." },
      expiresAt: { type: "string", description: "ISO timestamp, or empty for a built-in catalog." },
      error: { type: "string" }
    }
  },
  Provider: {
    type: "object",
    required: ["id", "label", "kind", "available", "status", "health", "executionOwnership", "models", "catalog", "capabilities", "fidelity"],
    properties: {
      id: { type: "string", enum: ["codex", "claude", "doubao", "zhipu"] },
      label: { type: "string" },
      kind: { type: "string", enum: ["cli", "web"] },
      available: { type: "boolean" },
      status: { type: "string" },
      reason: { type: "string" },
      health: { $ref: "#/components/schemas/ProviderHealth" },
      executionOwnership: { type: "string", enum: ["vibelink-host", "legacy-node", "external"] },
      defaultModel: { type: "string" },
      models: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "label"],
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            default: { type: "boolean" }
          }
        }
      },
      catalog: { $ref: "#/components/schemas/ProviderCatalog" },
      reasoningEfforts: { type: "array", items: { type: "string" } },
      capabilities: {
        type: "object",
        properties: {
          reattach: { type: "boolean" },
          structuredToolEvents: { type: "string", enum: ["authoritative", "observed", "sampled", "unavailable"] },
          toolOutput: { type: "string", enum: ["complete", "sampled", "unavailable"] },
          exitStatus: { type: "string", enum: ["authoritative", "observed", "unavailable"] },
          approvalContinuation: { type: "boolean" },
          liveInput: { type: "boolean" },
          protocol: { type: "string" },
          protocolVersion: { type: "string" }
        },
        additionalProperties: true
      },
      fidelity: {
        type: "object",
        additionalProperties: {
          type: "string",
          enum: ["authoritative", "observed", "sampled", "unavailable"]
        }
      }
    }
  },
  ProviderRegistry: {
    type: "object",
    required: ["version", "catalogVersion", "defaultProvider", "providers", "generatedAt"],
    properties: {
      version: { type: "integer", enum: [2] },
      catalogVersion: { type: "integer" },
      defaultProvider: { type: "string" },
      providers: { type: "array", items: { $ref: "#/components/schemas/Provider" } },
      generatedAt: { type: "string", format: "date-time" }
    }
  },
  SearchResult: {
    type: "object",
    required: ["kind", "id", "title", "snippet"],
    properties: {
      kind: { type: "string", enum: ["history", "task", "message", "file"] },
      id: { type: "string" },
      provider: { type: "string" },
      title: { type: "string" },
      snippet: { type: "string" },
      updatedAt: { type: "string" },
      workspaceId: { type: "string" },
      path: { type: "string" },
      turnId: { type: "string" }
    }
  },
  SearchResponse: {
    type: "object",
    required: ["items", "query", "scope", "sort", "order", "total", "nextCursor"],
    properties: {
      items: { type: "array", items: { $ref: "#/components/schemas/SearchResult" } },
      query: { type: "string" },
      scope: { type: "string", enum: ["all", "sessions", "tasks", "messages", "files"] },
      sort: { type: "string", enum: ["relevance", "updatedAt", "title", "kind"] },
      order: { type: "string", enum: ["asc", "desc"] },
      total: { type: "integer" },
      limit: { type: "integer" },
      cursor: { type: "string" },
      nextCursor: { type: "string" },
      savedSearchId: { type: "string" },
      index: { type: "object" }
    }
  },
  SavedSearch: {
    type: "object",
    required: ["id", "name", "query", "scope", "sort", "order"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      query: { type: "string" },
      scope: { type: "string" },
      tag: { type: "string" },
      favorite: { type: "boolean" },
      sort: { type: "string" },
      order: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
      lastUsedAt: { type: "string" }
    }
  },
  SearchHistoryItem: {
    type: "object",
    properties: {
      id: { type: "string" },
      query: { type: "string" },
      scope: { type: "string" },
      tag: { type: "string" },
      favorite: { type: "boolean" },
      sort: { type: "string" },
      order: { type: "string" },
      resultCount: { type: "integer" },
      useCount: { type: "integer" },
      searchedAt: { type: "string" }
    }
  },
  PaginationParams: {
    type: "object",
    properties: {
      after: { type: "integer", description: "Cursor for pagination (event ID or timestamp)" },
      limit: { type: "integer", description: "Maximum items to return", minimum: 1, maximum: 5000 },
      fields: { type: "string", description: "Comma-separated field selector with dot notation" }
    }
  }
};

// ── Helpers ──

function path(url, methods) {
  return { [url]: methods };
}

function get(summary, description, responseSchema, params = []) {
  return {
    get: {
      summary,
      description,
      parameters: [
        { name: "fields", in: "query", schema: { type: "string" }, description: "Comma-separated field selector" },
        ...params
      ],
      responses: {
        "200": { description: "Success", content: { "application/json": { schema: responseSchema } } },
        "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "429": { description: "Rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/RateLimitError" } } } }
      }
    }
  };
}

function post(summary, description, requestBody, responses, extra = {}) {
  const postDef = {
    post: {
      summary,
      description,
      parameters: [
        { name: "dryRun", in: "query", schema: { type: "string", enum: ["1", "true"] }, description: "Preview without side effects" }
      ],
      requestBody: requestBody ? {
        required: true,
        content: { "application/json": { schema: requestBody } }
      } : undefined,
      responses: {
        "200": { description: "Success", content: { "application/json": { schema: responses } } },
        "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/ValidationError" } } } },
        "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "428": { description: "Approval required", content: { "application/json": { schema: { $ref: "#/components/schemas/ApprovalRequired" } } } },
        "429": { description: "Rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/RateLimitError" } } } },
        ...extra
      }
    }
  };
  return postDef;
}

function mutation(method, summary, description, responseSchema, requestBody = null, params = []) {
  return {
    [method]: {
      summary,
      description,
      parameters: params,
      requestBody: requestBody ? {
        required: true,
        content: { "application/json": { schema: requestBody } }
      } : undefined,
      responses: {
        "200": { description: "Success", content: { "application/json": { schema: responseSchema } } },
        "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "429": { description: "Rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/RateLimitError" } } } }
      }
    }
  };
}

// ── Build paths ──

const paths = {
  // Discovery
  ...path("/api/tool-registry", get("List tool registry",
    "Returns all registered tool definitions with input/output schemas.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }
  )),
  ...path("/api/provider-registry", get("Provider registry",
    "Returns runtime health, dynamic model catalogs, execution ownership, capability, and fidelity for every Agent provider.",
    { $ref: "#/components/schemas/ProviderRegistry" },
    [{ name: "fresh", in: "query", schema: { type: "string", enum: ["0", "1"] }, description: "Set to 1 to force catalog and health refresh." }]
  )),
  ...path("/api/status", get("Server status",
    "Returns runtime configuration, security settings, devices, workspaces, and tasks.",
    { type: "object" }
  )),
  ...path("/api/doctor", get("Diagnostics",
    "Runs comprehensive health checks on the runtime environment.",
    { type: "object" }
  )),
  ...path("/api/command-registry", get("Command registry",
    "Lists all built-in slash commands and discovered skills.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
    [{ name: "filter", in: "query", schema: { type: "string" }, description: "Filter commands by name" }]
  )),
  ...path("/api/agent-reach/status", get("Agent Reach status",
    "Runs Agent Reach version and doctor checks, returning channel availability and install paths.",
    { type: "object" },
    [{ name: "timeoutMs", in: "query", schema: { type: "integer" }, description: "Doctor timeout in milliseconds" }]
  )),
  ...path("/api/agent-reach/skill", post("Manage Agent Reach skill",
    "Install or uninstall the Agent Reach skill into local agent skill directories.",
    {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["install", "uninstall"] },
        timeoutMs: { type: "integer" }
      },
      required: ["operation"]
    },
    { type: "object" },
    { "409": { description: "Agent Reach skill command failed", content: { "application/json": { schema: { type: "object" } } } } }
  )),
  ...path("/api/agent-reach/format", post("Format Agent Reach output",
    "Format raw platform output using Agent Reach formatters. Currently supports xhs.",
    {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["xhs"] },
        input: { description: "Raw platform output as JSON value or JSON string" },
        stdin: { type: "string" },
        timeoutMs: { type: "integer" }
      },
      required: ["platform"]
    },
    { type: "object" },
    { "409": { description: "Agent Reach format failed", content: { "application/json": { schema: { type: "object" } } } } }
  )),
  ...path("/api/agent-reach/transcribe", post("Transcribe through Agent Reach",
    "Transcribe an audio/video URL or local file using Agent Reach.",
    {
      type: "object",
      properties: {
        source: { type: "string" },
        provider: { type: "string", enum: ["auto", "groq", "openai"] },
        timeoutMs: { type: "integer" }
      },
      required: ["source"]
    },
    { type: "object" },
    { "409": { description: "Agent Reach transcription failed", content: { "application/json": { schema: { type: "object" } } } } }
  )),
  ...path("/api/doubao/status", get("Doubao status",
    "Checks the local extension bridge used by the Doubao web CLI.",
    { type: "object" },
    [
      { name: "endpoint", in: "query", schema: { type: "string" }, description: "Chrome DevTools endpoint" },
      { name: "url", in: "query", schema: { type: "string" }, description: "Doubao web chat URL" },
      { name: "timeoutMs", in: "query", schema: { type: "integer" }, description: "Doctor timeout in milliseconds" }
    ]
  )),
  ...path("/api/doubao/configure", post("Configure Doubao",
    "Configure the Doubao extension-bridge CLI so an agent can handle '帮我配豆包' with one call.",
    {
      type: "object",
      properties: {
        noDaemon: { type: "boolean" },
        noOpen: { type: "boolean" },
        port: { type: "integer" },
        url: { type: "string" },
        timeoutMs: { type: "integer" }
      }
    },
    { type: "object" },
    { "409": { description: "Doubao configuration failed", content: { "application/json": { schema: { type: "object" } } } } }
  )),
  ...path("/api/doubao/ask", post("Ask Doubao web",
    "Send a prompt to the logged-in Doubao web page through a local browser-control CLI.",
    {
      type: "object",
      properties: {
        prompt: { type: "string" },
        endpoint: { type: "string" },
        url: { type: "string" },
        timeoutMs: { type: "integer" }
      },
      required: ["prompt"]
    },
    { type: "object" },
    { "409": { description: "Doubao web command failed", content: { "application/json": { schema: { type: "object" } } } } }
  )),
  ...path("/api/mcp/status", get("MCP status",
    "Returns configured MCP server status and cached tool count.",
    {
      type: "object",
      properties: {
        servers: { type: "array", items: { type: "object" } },
        cachedTools: { type: "integer" },
        persistentSessions: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  serverId: { type: "string" },
                  pid: { type: "integer" },
                  requests: { type: "integer" },
                  responses: { type: "integer" },
                  failures: { type: "integer" },
                  timeouts: { type: "integer" },
                  backpressureRejects: { type: "integer" },
                  lastRequestAt: { type: "integer" },
                  lastResponseAt: { type: "integer" },
                  lastFailureAt: { type: "integer" },
                  lastBackpressureAt: { type: "integer" }
                }
              }
            }
          }
        },
        rustSidecar: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            starts: { type: "integer" },
            failures: { type: "integer" },
            fallbacks: { type: "integer" },
            lastFailureAt: { type: "string" },
            lastError: { type: "string" },
            client: {
              type: "object",
              properties: {
                pending: { type: "integer" },
                maxPendingRequests: { type: "integer" },
                terminated: { type: "boolean" },
                stderr: { type: "string" }
              }
            }
          }
        }
      }
    }
  )),
  ...path("/api/mcp/probe", post("Probe MCP servers",
    "Connects to configured MCP servers, reads tools/list metadata, and caches discovered tools.",
    {
      type: "object",
      properties: {
        serverId: { type: "string" },
        timeoutMs: { type: "number" }
      }
    },
    { type: "object" }
  )),
  ...path("/api/mcp/call", post("Call MCP tool",
    "Calls a configured MCP tool through the VibeLink runtime and records the result as a tool run.",
    {
      type: "object",
      properties: {
        serverId: { type: "string" },
        toolName: { type: "string" },
        fullName: { type: "string" },
        arguments: { type: "object" },
        timeoutMs: { type: "number" }
      }
    },
    { type: "object" },
    { "409": { description: "MCP tool call failed", content: { "application/json": { schema: { type: "object" } } } } }
  )),

  // Session / History / Task discovery
  ...path("/api/histories", get("List histories",
    "Returns conversation history from Codex and Claude sessions.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
    [{ name: "fresh", in: "query", schema: { type: "string" }, description: "Set to 1 to bypass cache" }]
  )),
  ...path("/api/histories/{provider}/{id}", get("Get history detail",
    "Returns the full transcript and state of a specific history entry.",
    { type: "object" },
    [
      { name: "provider", in: "path", required: true, schema: { type: "string" } },
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ]
  )),
  ...path("/api/search", get("Search all content",
    "Queries sessions, tasks, messages, and the persistent incremental Workspace full-text index.",
    { $ref: "#/components/schemas/SearchResponse" },
    [
      { name: "q", in: "query", schema: { type: "string" } },
      { name: "scope", in: "query", schema: { type: "string", enum: ["all", "sessions", "tasks", "messages", "files"] } },
      { name: "sort", in: "query", schema: { type: "string", enum: ["relevance", "updatedAt", "title", "kind"] } },
      { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"] } },
      { name: "cursor", in: "query", schema: { type: "string" } },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
      { name: "tag", in: "query", schema: { type: "string" } },
      { name: "favorite", in: "query", schema: { type: "boolean" } },
      { name: "savedSearchId", in: "query", schema: { type: "string" } },
      { name: "record", in: "query", schema: { type: "string", enum: ["0", "1"] } }
    ]
  )),
  ...path("/api/search/saved", {
    ...get("List saved searches", "Returns saved search definitions ordered by last update.", {
      type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/SavedSearch" } } }
    }),
    ...post("Save search", "Persists a reusable search definition.", {
      type: "object",
      required: ["name", "query"],
      properties: {
        name: { type: "string" }, query: { type: "string" }, scope: { type: "string" }, tag: { type: "string" },
        favorite: { type: "boolean" }, sort: { type: "string" }, order: { type: "string" }
      }
    }, { $ref: "#/components/schemas/SavedSearch" })
  }),
  ...path("/api/search/saved/{id}", {
    ...get("Get saved search", "Returns one saved search definition.", { $ref: "#/components/schemas/SavedSearch" }, [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ]),
    ...mutation("patch", "Update saved search", "Updates a saved search definition.", { $ref: "#/components/schemas/SavedSearch" }, { type: "object" }, [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ]),
    ...mutation("delete", "Delete saved search", "Deletes a saved search definition.", { type: "object" }, null, [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ])
  }),
  ...path("/api/search/history", {
    ...get("List search history", "Returns deduplicated recent searches with use and result counts.", {
      type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/SearchHistoryItem" } } }
    }, [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } }]),
    ...mutation("delete", "Clear search history", "Deletes all search history entries.", { type: "object" })
  }),
  ...path("/api/search/history/{id}", mutation("delete", "Delete search history item", "Deletes one search history entry.", { type: "object" }, null, [
    { name: "id", in: "path", required: true, schema: { type: "string" } }
  ])),
  ...path("/api/search/index", get("Search index status", "Returns Workspace index lifecycle and document counts.", { type: "object" })),
  ...path("/api/search/index/refresh", post("Refresh search index", "Runs an incremental refresh across registered Workspaces.", null, { type: "object" })),
  ...path("/api/tasks", get("List tasks",
    "Returns all agent tasks sorted by recency.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }
  )),
  ...path("/api/tasks/{id}", get("Get task detail",
    "Returns a specific task with its events.",
    { type: "object" },
    [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
  )),

  // Task operations
  ...path("/api/tasks", post("Create task",
    "Create a new or resume an existing Codex/Claude agent task.",
    {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Agent prompt" },
        agent: { type: "string", enum: ["codex", "claude", "doubao"] },
        cwd: { type: "string" },
        model: { type: "string" },
        mode: { type: "string", enum: ["new", "continue", "resume"] },
        sessionId: { type: "string" },
        title: { type: "string" }
      },
      required: ["prompt"]
    },
    {
      type: "object",
      properties: {
        id: { type: "string" },
        sessionId: { type: "string" },
        status: { type: "string" },
        toolRunId: { type: "string" }
      }
    },
    { "201": { description: "Created" } }
  )),

  // Budget and compact metrics
  ...path("/api/context-budget/metrics", get("Context budget metrics",
    "Returns token-estimation counters and latency summaries for context budget checks.",
    {
      type: "object",
      properties: {
        metrics: {
          type: "object",
          properties: {
            textEstimateCalls: { type: "integer" },
            eventEstimateCalls: { type: "integer" },
            eventsEstimated: { type: "integer" },
            charsEstimated: { type: "integer" },
            totalEstimateMs: { type: "number" },
            lastEstimateMs: { type: "number" },
            avgEstimateMs: { type: "number" },
            maxEstimateMs: { type: "number" },
            encoderCacheSize: { type: "integer" }
          }
        }
      }
    }
  )),
  ...path("/api/compact/metrics", get("Compact service metrics",
    "Returns compaction budget, summary-input, and latency counters.",
    {
      type: "object",
      properties: {
        metrics: {
          type: "object",
          properties: {
            budgetChecks: { type: "integer" },
            compactTaskCalls: { type: "integer" },
            buildContextCalls: { type: "integer" },
            eventsChecked: { type: "integer" },
            summaryRequestsCreated: { type: "integer" },
            compactedContextsReturned: { type: "integer" },
            nullResults: { type: "integer" },
            summaryInputsBuilt: { type: "integer" },
            summaryInputTruncations: { type: "integer" },
            summaryInputDroppedEvents: { type: "integer" },
            summaryInputSourceChars: { type: "integer" },
            summaryInputChars: { type: "integer" },
            totalMs: { type: "number" },
            lastMs: { type: "number" },
            avgMs: { type: "number" },
            maxMs: { type: "number" }
          }
        }
      }
    }
  )),

  // Workspace operations
  ...path("/api/workspaces", get("List workspaces",
    "Returns all configured workspaces.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }
  )),
  ...path("/api/workspaces", post("Create workspace",
    "Create a new workspace.",
    {
      type: "object",
      properties: {
        name: { type: "string" },
        path: { type: "string" },
        allowedRoot: { type: "string" }
      },
      required: ["name", "path"]
    },
    { type: "object", properties: { workspace: { type: "object" } } },
    { "201": { description: "Created" } }
  )),
  ...path("/api/workspaces/{id}/command", post("Execute workspace command",
    "Run a non-interactive command in a workspace. Returns approval request for high-risk commands.",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        workspaceId: { type: "string" },
        timeoutMs: { type: "integer" },
        kind: { type: "string", enum: ["terminal", "test"] },
        background: { type: "boolean" },
        taskId: { type: "string" }
      },
      required: ["command"]
    },
    {
      type: "object",
      properties: {
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "integer" },
        timedOut: { type: "boolean" },
        toolRunId: { type: "string" }
      }
    },
    { "202": { description: "Accepted (background execution)" } }
  )),
  ...path("/api/workspaces/{id}/terminal-session", post("Start terminal session",
    "Start an interactive terminal session in a workspace.",
    {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        shell: { type: "string" },
        mode: { type: "string", enum: ["auto", "pty", "spawn"] },
        cols: { type: "integer" },
        rows: { type: "integer" }
      }
    },
    { type: "object", properties: { sessionId: { type: "string" }, toolRunId: { type: "string" } } },
    { "201": { description: "Created" } }
  )),
  ...path("/api/workspaces/{id}/git/action", post("Git action",
    "Run a Git operation (stage, commit, pull, push, etc.).",
    {
      type: "object",
      properties: {
        action: { type: "string", description: "git action name" },
        message: { type: "string" },
        title: { type: "string" }
      },
      required: ["action"]
    },
    { type: "object", properties: { stdout: { type: "string" }, exitCode: { type: "integer" }, toolRunId: { type: "string" } } }
  )),
  ...path("/api/workspaces/{id}/git/file-action", post("Git file action",
    "Run a Git operation on a single changed file.",
    {
      type: "object",
      properties: {
        action: { type: "string" },
        path: { type: "string" }
      },
      required: ["action", "path"]
    },
    { type: "object" }
  )),
  ...path("/api/workspaces/{id}/worktrees", post("Create Git worktree",
    "Create a permanent Git worktree for a workspace and register it as a new workspace.",
    {
      type: "object",
      properties: {
        branchName: { type: "string", description: "Branch to create or attach to the worktree" },
        baseRef: { type: "string", description: "Base ref used when creating a new branch", default: "HEAD" },
        title: { type: "string", description: "Workspace title for the new worktree" },
        path: { type: "string", description: "Optional explicit worktree path; must be inside allowed roots" },
        root: { type: "string", description: "Optional explicit worktree root; must be inside allowed roots" }
      },
      required: ["branchName"]
    },
    {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        workspace: { type: "object" },
        sourceWorkspace: { type: "object" },
        path: { type: "string" },
        branchName: { type: "string" },
        baseRef: { type: "string" },
        branchExisted: { type: "boolean" },
        toolRunId: { type: "string" }
      }
    },
    { "201": { description: "Created" } }
  )),

  // Tools and events
  ...path("/api/tool-runs", get("List tool runs",
    "Returns tool execution records.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
    [{ name: "workspaceId", in: "query", schema: { type: "string" } }, { name: "taskId", in: "query", schema: { type: "string" } }]
  )),
  ...path("/api/tool-events", get("List tool events",
    "Returns tool execution events with streaming support.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
    [
      { name: "stream", in: "query", schema: { type: "string" }, description: "Set to 1 for SSE stream" },
      { name: "toolRunId", in: "query", schema: { type: "string" } },
      { name: "taskId", in: "query", schema: { type: "string" } },
      { name: "workspaceId", in: "query", schema: { type: "string" } }
    ]
  )),
  ...path("/api/tool-events/prune", post("Prune tool events",
    "Delete old tool events. Supports dry-run to preview deletions.",
    {
      type: "object",
      properties: {
        before: { type: "string", description: "ISO date cutoff" },
        keepLatest: { type: "integer" },
        dryRun: { type: "boolean" }
      }
    },
    { type: "object", properties: { deleted: { type: "integer" }, prunable: { type: "integer" }, dryRun: { type: "boolean" } } }
  )),

  // Approvals
  ...path("/api/approvals", get("List approvals",
    "Returns pending and historical approval requests.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
    [{ name: "status", in: "query", schema: { type: "string" } }, { name: "workspaceId", in: "query", schema: { type: "string" } }]
  )),
  ...path("/api/approvals/{id}/decision", post("Approve or deny",
    "Decide on a pending approval request.",
    {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["approve", "deny"] },
        reason: { type: "string" }
      },
      required: ["decision"]
    },
    { type: "object", properties: { ok: { type: "boolean" }, approval: { type: "object" } } }
  )),

  // Devices
  ...path("/api/devices", get("List devices",
    "Returns all paired devices.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } }, currentDeviceId: { type: "string" } } }
  )),

  // Events
  ...path("/api/events/unified", get("Unified event log",
    "Cross-table events from tasks, tool runs, and live calls.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
    [
      { name: "taskId", in: "query", schema: { type: "string" } },
      { name: "liveCallSessionId", in: "query", schema: { type: "string" } },
      { name: "toolRunId", in: "query", schema: { type: "string" } }
    ]
  )),

  // Live calls
  ...path("/api/live-calls", get("List live calls",
    "Returns active and recent live call sessions.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }
  )),
  ...path("/api/live-calls", post("Create live call",
    "Create a new live call session.",
    {
      type: "object",
      properties: {
        title: { type: "string" },
        mode: { type: "string", enum: ["audio", "text"] }
      }
    },
    { type: "object", properties: { ok: { type: "boolean" }, session: { type: "object" } } },
    { "201": { description: "Created" } }
  )),
  ...path("/api/live-calls/audio-metrics", get("Live call audio metrics",
    "Returns WebSocket audio stream counters including frames, drops, drop rate, backpressure, acknowledgements, and per-session totals.",
    { type: "object", properties: { metrics: { type: "object" } } }
  )),
  ...path("/api/live-calls/asr-metrics", get("Live call ASR metrics",
    "Returns ASR ingest, normalization, segment, provider, and ingest-duration counters with per-session totals.",
    {
      type: "object",
      properties: {
        metrics: {
          type: "object",
          properties: {
            ingestCalls: { type: "integer" },
            inputBytes: { type: "integer" },
            normalizedBytes: { type: "integer" },
            segments: { type: "integer" },
            segmentBytes: { type: "integer" },
            flushes: { type: "integer" },
            stops: { type: "integer" },
            providerStarts: { type: "integer" },
            providerFallbacks: { type: "integer" },
            providerFeedCalls: { type: "integer" },
            errors: { type: "integer" },
            lastIngestAt: { type: "integer" },
            ingestDurationSamples: { type: "integer" },
            avgIngestMs: { type: "number" },
            maxIngestMs: { type: "number" },
            sessions: { type: "array", items: { type: "object" } }
          }
        }
      }
    }
  )),

  // Settings
  ...path("/api/settings", post("Update settings",
    "Patch server settings. Use ?dryRun=1 to preview changes.",
    { type: "object" },
    { type: "object", properties: { ok: { type: "boolean" }, settings: { type: "object" } } }
  )),

  // Audit
  ...path("/api/audit-log", get("Audit log",
    "Returns structured audit trail of all API operations.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }
  )),

  // Desktop remote
  ...path("/api/desktop-remote/observations", get("Desktop observations",
    "Returns desktop observation snapshots.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }
  )),

  // Terminal sessions
  ...path("/api/terminal-sessions", get("List terminal sessions",
    "Returns active and recent terminal sessions.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }
  )),

  // Other
  ...path("/api/cloudflare/guide", get("Cloudflare tunnel guide",
    "Returns Cloudflare Tunnel setup guidance.",
    { type: "object" }
  ))
};

// ── Assemble ──

const spec = {
  openapi: "3.0.3",
  info: {
    title: "VibeLink HTTP API",
    version: "0.1.0",
    description: "Local-first Agent Remote Console HTTP API.\n\nAll endpoints return JSON. Authentication via Bearer token.\n\nRate-limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.",
    contact: { name: "VibeLink" }
  },
  servers: [
    { url: BASE_URL, description: "Local bridge" }
  ],
  paths,
  components: {
    schemas,
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "UUID",
        description: "Device token obtained via pairing"
      }
    }
  },
  security: [{ bearerAuth: [] }]
};

// ── Output ──

console.log(JSON.stringify(spec, null, 2));
