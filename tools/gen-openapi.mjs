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
  RevisionConflict: {
    type: "object",
    required: ["error", "code", "actualRevision", "current"],
    properties: {
      error: { type: "string" },
      code: { type: "string", enum: ["THREAD_STATE_CONFLICT", "SETTINGS_CONFLICT", "WORKSPACE_FILE_CONFLICT"] },
      expectedRevision: { oneOf: [{ type: "integer" }, { type: "string" }], nullable: true },
      actualRevision: { oneOf: [{ type: "integer" }, { type: "string" }], nullable: true },
      conflictingFields: { type: "array", items: { type: "string" } },
      conflicts: { type: "array", items: { type: "object" } },
      current: { type: "object" },
      state: { type: "object" }
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
      sessionOrigin: { type: "string", enum: ["codex-desktop", "vibelink-cli", "unknown"] },
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
      sessionOrigin: { type: "string", enum: ["all", "codex-desktop", "vibelink-cli", "unknown"] },
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
      sessionOrigin: { type: "string", enum: ["all", "codex-desktop", "vibelink-cli", "unknown"] },
      tag: { type: "string" },
      favorite: { type: "boolean" },
      sort: { type: "string" },
      order: { type: "string" },
      resultCount: { type: "integer" },
      useCount: { type: "integer" },
      searchedAt: { type: "string" }
    }
  },
  ReviewSession: {
    type: "object",
    required: ["id", "workspaceId", "title", "status", "source", "files", "threads", "comments"],
    properties: {
      id: { type: "string" },
      workspaceId: { type: "string" },
      branch: { type: "string" },
      title: { type: "string" },
      status: { type: "string", enum: ["open", "submitted", "resolved"] },
      source: { type: "string", enum: ["local", "github", "gitlab"] },
      remote: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["github", "gitlab"] },
          repository: { type: "string" },
          number: { type: "integer" },
          url: { type: "string" },
          headSha: { type: "string" },
          baseSha: { type: "string" },
          startSha: { type: "string" },
          syncedAt: { type: "string", format: "date-time" }
        }
      },
      files: { type: "array", items: { type: "object" } },
      diff: { type: "string" },
      threads: { type: "array", items: { type: "object" } },
      comments: { type: "array", items: { type: "object" } },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }
  },
  ReviewConflict: {
    type: "object",
    required: ["error", "code", "expectedHeadSha", "actualHeadSha"],
    properties: {
      error: { type: "string" },
      code: { type: "string", enum: ["REVIEW_REMOTE_CONFLICT"] },
      expectedHeadSha: { type: "string" },
      actualHeadSha: { type: "string" },
      current: { type: "object" }
    }
  },
  WorkspaceBatchConflict: {
    type: "object",
    required: ["error", "code", "conflicts"],
    properties: {
      error: { type: "string" },
      code: { type: "string", enum: ["WORKSPACE_BATCH_CONFLICT"] },
      conflicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            action: { type: "string" },
            path: { type: "string" },
            code: { type: "string" },
            expectedRevision: { type: "string", nullable: true },
            actualRevision: { type: "string", nullable: true },
            current: { type: "object", nullable: true }
          }
        }
      }
    }
  },
  PaginationParams: {
    type: "object",
    properties: {
      after: { type: "integer", description: "Cursor for pagination (event ID or timestamp)" },
      limit: { type: "integer", description: "Maximum items to return", minimum: 1, maximum: 5000 },
      fields: { type: "string", description: "Comma-separated field selector with dot notation" }
    }
  },
  ArtifactMetadata: {
    type: "object",
    required: ["version", "id", "name", "mimeType", "kind", "size", "modifiedAt", "digest", "capabilities"],
    properties: {
      version: { type: "integer", enum: [1] },
      id: { type: "string" },
      name: { type: "string" },
      mimeType: { type: "string" },
      kind: { type: "string", enum: ["pdf", "document", "workbook", "presentation", "table", "notebook", "text", "binary"] },
      size: { type: "integer", format: "int64", minimum: 0 },
      modifiedAt: { type: "string", format: "date-time" },
      digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      capabilities: {
        type: "object",
        required: ["rangeRead", "preview", "mutation"],
        properties: {
          rangeRead: { type: "boolean", enum: [true] },
          preview: { type: "boolean" },
          mutation: { type: "boolean" }
        }
      }
    }
  },
  ArtifactPreview: {
    type: "object",
    required: ["version", "readonly", "digest", "capabilities", "mimeType", "kind", "document", "truncated", "redaction", "limits"],
    properties: {
      version: { type: "integer", enum: [1] },
      readonly: { type: "boolean" },
      digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      capabilities: { type: "object", properties: { rangeRead: { type: "boolean" }, preview: { type: "boolean" }, mutation: { type: "boolean" } } },
      mimeType: { type: "string" },
      kind: { type: "string" },
      document: { type: "object", additionalProperties: true },
      truncated: { type: "object", additionalProperties: { type: "boolean" } },
      redaction: {
        type: "object",
        required: ["applied", "count"],
        properties: { applied: { type: "boolean" }, count: { type: "integer", minimum: 0 } }
      },
      limits: { type: "object", additionalProperties: { type: "integer" } }
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

function post(summary, description, requestBody, responses, extra = {}, params = []) {
  const postDef = {
    post: {
      summary,
      description,
      parameters: [
        { name: "dryRun", in: "query", schema: { type: "string", enum: ["1", "true"] }, description: "Preview without side effects" },
        ...params
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

function withEtag(methods, { ifMatch = false, ifNoneMatch = false } = {}) {
  const operation = methods.get || methods.post;
  operation.responses["200"].headers = {
    ETag: { description: "Current resource revision tag.", schema: { type: "string" } }
  };
  if (ifMatch) {
    operation.parameters.push({ name: "If-Match", in: "header", schema: { type: "string" }, description: "ETag from the last successful read." });
  }
  if (ifNoneMatch) {
    operation.parameters.push({ name: "If-None-Match", in: "header", schema: { type: "string", enum: ["*"] }, description: "Use * when creating a file that must not already exist." });
  }
  return methods;
}

function mutation(method, summary, description, responseSchema, requestBody = null, params = [], extraResponses = {}) {
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
        "429": { description: "Rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/RateLimitError" } } } },
        ...extraResponses
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
    [
      { name: "fresh", in: "query", schema: { type: "string" }, description: "Set to 1 to bypass cache" },
      {
        name: "sessionOrigin",
        in: "query",
        schema: { type: "string", enum: ["all", "codex-desktop", "vibelink-cli", "unknown"] },
        description: "Filter histories by their creation origin"
      }
    ]
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
      {
        name: "sessionOrigin",
        in: "query",
        schema: { type: "string", enum: ["all", "codex-desktop", "vibelink-cli", "unknown"] },
        description: "Filter indexed sessions, tasks, and messages by creation origin; file results are unaffected"
      },
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
        name: { type: "string" }, query: { type: "string" }, scope: { type: "string" },
        sessionOrigin: { type: "string", enum: ["all", "codex-desktop", "vibelink-cli", "unknown"] }, tag: { type: "string" },
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
        agent: { type: "string", enum: ["codex", "claude", "doubao", "zhipu"] },
        cwd: { type: "string" },
        model: { type: "string" },
        mode: { type: "string", enum: ["new", "continue", "resume"] },
        sessionId: { type: "string" },
        title: { type: "string" },
        priority: { type: "integer", minimum: -100, maximum: 100 },
        maxAttempts: { type: "integer", minimum: 1, maximum: 10, default: 3 }
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
  ...path("/api/task-scheduler", get("Get background scheduler", "Returns persistent queue state, concurrency usage, retries, and recent jobs.", { type: "object" })),
  ...path("/api/task-scheduler/{id}/retry", mutation("post", "Retry queued task", "Resets a failed or cancelled queue item and schedules it again.", { type: "object" }, { type: "object" }, [
    { name: "id", in: "path", required: true, schema: { type: "string" } }
  ])),
  ...path("/api/task-scheduler/{id}/cancel", mutation("post", "Cancel queued task", "Cancels a queued task before it starts.", { type: "object" }, { type: "object" }, [
    { name: "id", in: "path", required: true, schema: { type: "string" } }
  ])),

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
  ...path("/api/workspaces/{id}/file", {
    ...withEtag(get("Read workspace file",
      "Returns a bounded UTF-8 page, byte cursor, SHA-256 revision, and ETag for a workspace file.",
      { type: "object", properties: { path: { type: "string" }, text: { type: "string" }, revision: { type: "string" }, etag: { type: "string" }, offset: { type: "integer" }, bytesRead: { type: "integer" }, nextOffset: { type: "integer" }, eof: { type: "boolean" }, binary: { type: "boolean" } } },
      [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "path", in: "query", required: true, schema: { type: "string" } },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 }, description: "UTF-8 byte cursor returned by nextOffset" },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1024, maximum: 1048576, default: 524288 }, description: "Maximum bytes in one text page" }
      ]
    )),
    ...withEtag(post("Mutate workspace file",
      "Write, rename, or delete a file. Stale revisions return 409 with the latest file snapshot.",
      {
        type: "object",
        required: ["action", "path"],
        properties: {
          action: { type: "string", enum: ["write", "rename", "delete"] },
          path: { type: "string" },
          nextPath: { type: "string" },
          text: { type: "string" },
          expectedRevision: { type: "string" }
        }
      },
      { type: "object" },
      { "409": { description: "Revision conflict", content: { "application/json": { schema: { $ref: "#/components/schemas/RevisionConflict" } } } } }
    ), { ifMatch: true, ifNoneMatch: true })
  }),
  ...path("/api/workspaces/{id}/file/preview", withEtag(get("Preview workspace file",
    "Returns the bounded, redacted structured preview used for PDF, Office, CSV/TSV, Notebook, and text artifacts.",
    { type: "object", properties: { path: { type: "string" }, revision: { type: "string" }, etag: { type: "string" }, preview: { $ref: "#/components/schemas/ArtifactPreview" } } },
    [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "path", in: "query", required: true, schema: { type: "string" } },
      { name: "maxRows", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
      { name: "maxColumns", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "maxTextChars", in: "query", schema: { type: "integer", minimum: 1024, maximum: 262144 } }
    ]
  ))),
  ...path("/api/workspaces/{id}/files/batch", post("Batch mutate workspace files",
    "Applies up to 100 writes, renames, and deletes. Atomic mode preflights every revision and rolls back execution failures; best-effort returns per-operation results.",
    {
      type: "object",
      required: ["operations"],
      properties: {
        mode: { type: "string", enum: ["atomic", "best-effort"], default: "atomic" },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            required: ["action", "path"],
            properties: {
              action: { type: "string", enum: ["write", "rename", "delete"] },
              path: { type: "string" },
              nextPath: { type: "string" },
              text: { type: "string" },
              expectedRevision: { type: "string" },
              requireAbsent: { type: "boolean" }
            }
          }
        }
      }
    },
    { type: "object", properties: { ok: { type: "boolean" }, mode: { type: "string" }, items: { type: "array", items: { type: "object" } } } },
    { "409": { description: "One or more atomic batch conflicts", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkspaceBatchConflict" } } } } },
    [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
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
  ...path("/api/workspaces/{id}/worktrees", {
    ...get("List Git worktrees",
      "Lists the main and linked worktrees, including branch, lock, prune, and workspace registration state.",
      { type: "object", properties: { ok: { type: "boolean" }, worktrees: { type: "array", items: { type: "object" } } } },
      [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
    ),
    ...post("Create Git worktree",
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
    )
  }),
  ...path("/api/workspaces/{id}/worktrees/action", post("Manage Git worktree",
    "Remove, prune, lock, or unlock worktrees belonging to the workspace repository.",
    {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["remove", "prune", "lock", "unlock"] },
        path: { type: "string", description: "Required except for prune" },
        force: { type: "boolean", description: "Force removal of a dirty worktree" },
        reason: { type: "string", description: "Optional lock reason" },
        expire: { type: "string", description: "Git expiry expression used by prune" }
      }
    },
    { type: "object", properties: { ok: { type: "boolean" }, action: { type: "string" }, path: { type: "string" }, worktrees: { type: "array", items: { type: "object" } }, toolRunId: { type: "string" } } },
    {},
    [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
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
        mode: { type: "string", enum: ["audio", "text"] },
        source: { type: "string" },
        workspaceId: { type: "string" },
        asrProvider: { type: "string", description: "Explicit provider id. Mock must be selected explicitly and is unavailable in production." }
      }
    },
    { type: "object", properties: { ok: { type: "boolean" }, session: { type: "object" } } },
    { "201": { description: "Created" } }
  )),
  ...path("/api/live-calls/asr-providers", get("List Live Call ASR providers",
    "Returns provider availability, the configured default, and binary/model diagnostics.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }
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
  ...path("/api/live-calls/audio-files", get("List Live Call PCM files",
    "Lists retained PCM checkpoints and the active retention, per-file, and total quota policy.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } }, policy: { type: "object" } } }
  )),
  ...path("/api/live-calls/audio-files/{name}", mutation("delete", "Delete Live Call PCM file",
    "Deletes an inactive PCM checkpoint. Active recordings return 409.",
    { type: "object", properties: { ok: { type: "boolean" }, name: { type: "string" } } },
    null,
    [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
    { "409": { description: "Recording is active", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } }
  )),

  // Settings
  ...path("/api/settings", {
    ...withEtag(get("Read settings",
      "Returns public settings and their current revision.",
      { type: "object", properties: { settings: { type: "object", properties: { revision: { type: "integer" } } } } }
    )),
    ...withEtag(post("Update settings",
      "Patch server settings. Stale same-field writes return 409; disjoint patches merge. Use ?dryRun=1 to preview changes.",
      { type: "object", properties: { expectedRevision: { type: "integer" } } },
      { type: "object", properties: { ok: { type: "boolean" }, settings: { type: "object" } } },
      { "409": { description: "Revision conflict", content: { "application/json": { schema: { $ref: "#/components/schemas/RevisionConflict" } } } } }
    ), { ifMatch: true })
  }),

  // Thread metadata
  ...path("/api/thread-state", {
    ...withEtag(get("Read thread state",
      "Returns thread metadata with per-thread revisions.",
      { type: "object" }
    )),
    ...withEtag(post("Update thread state",
      "Conditionally update one thread. Stale same-field writes return 409 while tag add/remove operations merge.",
      {
        type: "object",
        required: ["key", "patch"],
        properties: { key: { type: "string" }, patch: { type: "object" }, expectedRevision: { type: "integer" } }
      },
      { type: "object" },
      { "409": { description: "Revision conflict", content: { "application/json": { schema: { $ref: "#/components/schemas/RevisionConflict" } } } } }
    ))
  }),
  ...path("/api/thread-state/batch", withEtag(post("Batch update thread state",
    "Atomically updates up to 200 threads. Any stale conflicting item rolls back the entire batch.",
    {
      type: "object",
      required: ["updates"],
      properties: {
        updates: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            required: ["key", "patch", "expectedRevision"],
            properties: { key: { type: "string" }, patch: { type: "object" }, expectedRevision: { type: "integer" } }
          }
        }
      }
    },
    { type: "object" },
    { "409": { description: "Atomic batch conflict", content: { "application/json": { schema: { $ref: "#/components/schemas/RevisionConflict" } } } } }
  ))),

  // Pull request reviews
  ...path("/api/reviews", {
    ...get("List review sessions",
      "Returns local, GitHub-backed, and GitLab-backed review sessions.",
      { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/ReviewSession" } } } }
    ),
    ...post("Create review session",
      "Creates a local session, or imports a GitHub pull request or GitLab merge request.",
      {
        type: "object",
        required: ["workspaceId"],
        properties: {
          workspaceId: { type: "string" },
          title: { type: "string" },
          branch: { type: "string" },
          provider: { type: "string", enum: ["github", "gitlab"] },
          pullRequest: { oneOf: [{ type: "integer" }, { type: "string" }] },
          number: { type: "integer" },
          repository: { type: "string" }
        }
      },
      { $ref: "#/components/schemas/ReviewSession" },
      { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/ReviewSession" } } } } }
    )
  }),
  ...path("/api/reviews/{id}", {
    ...get("Get review session", "Returns one review session.", { $ref: "#/components/schemas/ReviewSession" }, [
      { name: "id", in: "path", required: true, schema: { type: "string" } }
    ]),
    ...mutation("patch", "Update review session", "Updates local review session fields.", { $ref: "#/components/schemas/ReviewSession" },
      { type: "object" },
      [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
    )
  }),
  ...path("/api/reviews/{id}/comments", post("Add review comment",
    "Adds a local draft inline comment.",
    {
      type: "object",
      required: ["file", "line", "body"],
      properties: {
        file: { type: "string" }, line: { type: "integer", minimum: 1 }, startLine: { type: "integer", minimum: 1 },
        side: { type: "string", enum: ["left", "right"] }, body: { type: "string" }, severity: { type: "string" }
      }
    },
    { $ref: "#/components/schemas/ReviewSession" },
    { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/ReviewSession" } } } } },
    [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
  )),
  ...path("/api/reviews/{id}/comments/{commentId}", mutation("patch", "Update review comment",
    "Updates a draft comment or its local status.",
    { $ref: "#/components/schemas/ReviewSession" },
    { type: "object", properties: { body: { type: "string" }, status: { type: "string", enum: ["open", "resolved", "dismissed", "submitted"] } } },
    [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "commentId", in: "path", required: true, schema: { type: "string" } }
    ]
  )),
  ...path("/api/reviews/{id}/sync", post("Sync remote review session",
    "Refreshes GitHub PR or GitLab MR metadata, changed files, diff, review threads, and remote comment status while preserving local comments.",
    { type: "object", properties: { provider: { type: "string", enum: ["github", "gitlab"] }, pullRequest: { oneOf: [{ type: "integer" }, { type: "string" }] }, repository: { type: "string" } } },
    { $ref: "#/components/schemas/ReviewSession" },
    {},
    [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
  )),
  ...path("/api/reviews/{id}/submit", post("Submit remote review",
    "Submits the decision and open local comments after verifying the PR or MR head SHA has not changed.",
    {
      type: "object",
      required: ["decision", "expectedHeadSha"],
      properties: {
        decision: { type: "string", enum: ["approve", "request_changes", "comment"] },
        body: { type: "string" },
        expectedHeadSha: { type: "string" }
      }
    },
    { $ref: "#/components/schemas/ReviewSession" },
    { "409": { description: "Remote head changed", content: { "application/json": { schema: { $ref: "#/components/schemas/ReviewConflict" } } } } },
    [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
  )),

  // Audit
  ...path("/api/audit-log", get("Audit log",
    "Returns structured audit trail of all API operations.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }
  )),

  // Desktop remote
  ...path("/api/codex-app-server/probe", post("Probe Codex app server",
    "Runs a bounded health probe against the Codex app-server integration.",
    { type: "object" },
    { type: "object", properties: { ok: { type: "boolean" }, toolRunId: { type: "string" } } }
  )),
  ...path("/api/codex-desktop/status", get("Codex Desktop status",
    "Returns the observed native Codex Desktop window and composer state.",
    { type: "object" }
  )),
  ...path("/api/codex-desktop/draft-probe", post("Probe Codex Desktop draft",
    "Attempts a bounded draft-only native desktop probe without sending a message.",
    { type: "object", properties: { text: { type: "string" } } },
    { type: "object", properties: { ok: { type: "boolean" }, toolRunId: { type: "string" } } }
  )),
  ...path("/api/codex-desktop/send", post("Send Codex Desktop prompt",
    "Sends a prompt through the native Codex Desktop bridge.",
    { type: "object", required: ["prompt"], properties: { prompt: { type: "string" } } },
    { type: "object" }
  )),
  ...path("/api/desktop-remote/status", get("Desktop Remote status",
    "Returns Desktop Remote queue, probe, and latest desktop readiness state.",
    { type: "object" },
    [{ name: "fresh", in: "query", schema: { type: "integer", enum: [0, 1] } }]
  )),
  ...path("/api/desktop-remote/observations", get("Desktop observations",
    "Returns desktop observation snapshots.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
    [{ name: "after", in: "query", schema: { type: "integer", minimum: 0 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000 } }]
  )),
  ...path("/api/desktop-remote/events", get("Stream Desktop Remote events",
    "Streams Desktop Remote observation events using SSE catch-up semantics.",
    { type: "object" },
    [{ name: "after", in: "query", schema: { type: "integer", minimum: 0 } }]
  )),
  ...path("/api/desktop-remote/messages", post("Queue Desktop Remote message",
    "Queues a message for guarded native Codex Desktop delivery.",
    { type: "object", required: ["text"], properties: { text: { type: "string" }, permissionMode: { type: "string" }, model: { type: "string" }, reasoningEffort: { type: "string" }, settingsPolicy: { type: "string" }, target: { type: "object" } } },
    { type: "object", properties: { ok: { type: "boolean" }, item: { type: "object" }, state: { type: "object" } } },
    { "202": { description: "Accepted" } }
  )),
  ...path("/api/desktop-remote/retry", post("Retry Desktop Remote queue",
    "Retries pending Desktop Remote queue items after refreshing desktop state.",
    { type: "object" },
    { type: "object" }
  )),
  ...path("/api/desktop-remote/clear", post("Clear Desktop Remote queue",
    "Cancels pending Desktop Remote queue items.",
    { type: "object" },
    { type: "object" }
  )),
  ...path("/api/desktop-remote/focus", post("Focus Desktop Remote conversation",
    "Focuses a visible Codex Desktop sidebar conversation by index.",
    { type: "object", properties: { index: { type: "integer", minimum: 0 } } },
    { type: "object" },
    { "409": { description: "Conversation cannot be focused" } }
  )),

  // Terminal sessions
  ...path("/api/terminal-sessions", get("List terminal sessions",
    "Returns active and recent terminal sessions.",
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }
  )),

  // Artifact runtime
  ...path("/api/artifacts/{id}", {
    ...get("Get artifact metadata",
    "Returns authenticated, server-detected artifact metadata and capability flags.",
    { type: "object", properties: { artifact: { $ref: "#/components/schemas/ArtifactMetadata" } } },
    [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
    ),
    ...mutation("patch", "Mutate editable artifact", "Revision-checked CSV/TSV table or Notebook cell-source mutation.",
      { type: "object", properties: { metadata: { $ref: "#/components/schemas/ArtifactMetadata" }, preview: { $ref: "#/components/schemas/ArtifactPreview" } } },
      { type: "object", required: ["expectedDigest"], properties: { expectedDigest: { type: "string" }, document: { type: "object" }, cellPatches: { type: "array", maxItems: 1000, items: { type: "object", required: ["index", "source"], properties: { index: { type: "integer", minimum: 0 }, source: { type: "string" } } } } } },
      [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      { "409": { description: "Artifact digest conflict", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }, "405": { description: "Artifact type is read-only", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } }
    )
  }),
  ...path("/api/artifacts/{id}/preview", get("Preview artifact structure",
    "Returns a bounded, redacted, read-only structure for PDF, Office, table, or Notebook content.",
    { type: "object", properties: { preview: { $ref: "#/components/schemas/ArtifactPreview" } } },
    [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
  )),
  ...path("/api/artifacts/{id}/content", {
    get: {
      summary: "Read artifact byte range",
      description: "Returns exactly one authenticated byte range, bounded to 1 MiB per request.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "Range", in: "header", required: true, schema: { type: "string", example: "bytes=0-1048575" } }
      ],
      responses: {
        "206": {
          description: "Partial content",
          headers: {
            "Accept-Ranges": { schema: { type: "string", enum: ["bytes"] } },
            "Content-Range": { schema: { type: "string" } }
          },
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } }
        },
        "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "416": { description: "Missing, invalid, unsatisfiable, multipart, or over-limit range", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "429": { description: "Rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/RateLimitError" } } } }
      }
    }
  }),
  ...path("/api/attachments", post("Upload attachment",
    "Stores an authenticated attachment and returns its generated id, bounded preview, and optional artifact links.",
    { type: "string", format: "binary" },
    {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        id: { type: "string" },
        name: { type: "string" },
        url: { type: "string" },
        mimeType: { type: "string" },
        size: { type: "integer" },
        artifact: { type: "object" }
      }
    },
    { "201": { description: "Created" } }
  )),
  ...path("/api/attachments/{id}", {
    get: {
      summary: "Read attachment",
      description: "Streams one authenticated attachment by its generated id.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "Attachment bytes", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
      }
    }
  }),

  // Managed browser sessions
  ...path("/api/browser-sessions", {
    ...get("List managed browser sessions", "Returns active bridge-owned Chromium sessions and pages.", { type: "object", properties: { items: { type: "array", items: { type: "object" } } } }),
    ...post("Create managed browser session", "Creates a headless bridge-owned Chromium session.", { type: "object", properties: { timeoutMs: { type: "integer", minimum: 1, maximum: 300000 }, maxTraceEvents: { type: "integer", minimum: 1, maximum: 100000 } } }, { type: "object", properties: { session: { type: "object" } } }, { "201": { description: "Created" } })
  }),
  ...path("/api/browser-sessions/{id}", {
    ...get("Get managed browser session", "Returns one managed session.", { type: "object", properties: { session: { type: "object" } } }, [{ name: "id", in: "path", required: true, schema: { type: "string" } }]),
    ...mutation("delete", "Close managed browser session", "Closes Chromium resources owned by the session.", { type: "object", properties: { session: { type: "object" } } }, null, [{ name: "id", in: "path", required: true, schema: { type: "string" } }])
  }),
  ...path("/api/browser-sessions/{id}/pages", post("Create browser page", "Creates a page in a managed session.", { type: "object" }, { type: "object", properties: { page: { type: "object" } } }, { "201": { description: "Created" } }, [{ name: "id", in: "path", required: true, schema: { type: "string" } }])),
  ...path("/api/browser-sessions/{id}/pages/{pageId}", mutation("delete", "Close browser page", "Closes one managed page.", { type: "object", properties: { page: { type: "object" } } }, null, [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "pageId", in: "path", required: true, schema: { type: "string" } }])),
  ...path("/api/browser-sessions/{id}/navigate", post("Navigate browser page", "Navigates a managed page after URL validation.", { type: "object", required: ["url"], properties: { pageId: { type: "string" }, url: { type: "string" }, waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"] }, timeoutMs: { type: "integer" } } }, { type: "object", properties: { navigation: { type: "object" } } }, {}, [{ name: "id", in: "path", required: true, schema: { type: "string" } }])),
  ...path("/api/browser-sessions/{id}/screenshot", post("Capture browser screenshot", "Returns a bounded PNG or JPEG screenshot as base64 JSON.", { type: "object", properties: { pageId: { type: "string" }, type: { type: "string", enum: ["png", "jpeg"] }, fullPage: { type: "boolean", enum: [false] } } }, { type: "object", properties: { screenshot: { type: "object" } } }, { "413": { description: "Screenshot too large" } }, [{ name: "id", in: "path", required: true, schema: { type: "string" } }])),
  ...path("/api/browser-sessions/{id}/trace", get("Read browser trace", "Returns bounded redacted trace events with cursor pagination.", { type: "object", properties: { items: { type: "array", items: { type: "object" } }, nextCursor: { type: "integer" }, hasMore: { type: "boolean" }, droppedBefore: { type: "integer" } } }, [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "after", in: "query", schema: { type: "integer", minimum: 0 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000 } }, { name: "types", in: "query", schema: { type: "string" } }])),

  // Capability center
  ...path("/api/capabilities/{category}", get("List capability resources", "Lists capability resources.", { type: "object", properties: { category: { type: "string" }, items: { type: "array", items: { type: "object" } } } }, [{ name: "category", in: "path", required: true, schema: { type: "string" } } ])),
  ...path("/api/capabilities/plugins", post("Install managed plugin", "Installs a bounded managed plugin.", { type: "object" }, { type: "object" }, { "201": { description: "Created" } })),
  ...path("/api/capabilities/plugins/{id}", { ...mutation("patch", "Update managed plugin", "Enables, disables, or updates a managed plugin.", { type: "object" }, null, [{ name: "id", in: "path", required: true, schema: { type: "string" } }]), ...mutation("delete", "Remove managed plugin", "Removes a managed plugin.", { type: "object" }, null, [{ name: "id", in: "path", required: true, schema: { type: "string" } }]) }),
  ...path("/api/capabilities/hooks/{id}", mutation("patch", "Toggle hook", "Enables or disables a hook event.", { type: "object" }, null, [{ name: "id", in: "path", required: true, schema: { type: "string" } }])),
  ...path("/api/capabilities/config/{id}", mutation("patch", "Update editable config", "Updates a digest-guarded config resource.", { type: "object" }, null, [{ name: "id", in: "path", required: true, schema: { type: "string" } }])),
  ...path("/api/automations", post("Create automation", "Creates an automation.", { type: "object" }, { type: "object" }, { "201": { description: "Created" } })),
  ...path("/api/automations/{id}", { ...mutation("patch", "Update automation", "Updates an automation.", { type: "object" }, null, [{ name: "id", in: "path", required: true, schema: { type: "string" } }]), ...mutation("delete", "Delete automation", "Deletes an automation.", { type: "object" }, null, [{ name: "id", in: "path", required: true, schema: { type: "string" } }]) }),
  ...path("/api/automations/{id}/run", post("Run automation", "Runs an automation immediately.", { type: "object" }, { type: "object" }, {}, [{ name: "id", in: "path", required: true, schema: { type: "string" } }])),
  ...path("/api/subagents", post("Start subagent", "Starts a task linked to a parent.", { type: "object" }, { type: "object" }, { "201": { description: "Created" } })),

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
    description: "Local-first Agent Remote Console HTTP API.\n\nEndpoints return JSON except for authenticated artifact byte ranges, which return bounded binary partial content. Authentication via Bearer token.\n\nRate-limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.",
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
