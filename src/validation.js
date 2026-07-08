/**
 * Zod-based runtime validation schemas for VibeLink API endpoints.
 * Used by server.js to validate request bodies before processing.
 */
import { z } from "zod";

// ── Workspace command ──

export const CommandInputSchema = z.object({
  command: z.string().min(1, "Command is required"),
  workspaceId: z.string().optional(),
  taskId: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600000).optional(),
  kind: z.enum(["terminal", "test"]).optional(),
  background: z.boolean().optional(),
  dryRun: z.boolean().optional()
});

// ── Agent task ──

export const TaskInputSchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  cwd: z.string().optional(),
  agent: z.enum(["codex", "claude", "doubao", "zhipu"]).optional(),
  model: z.string().optional(),
  title: z.string().optional(),
  mode: z.enum(["new", "continue", "resume"]).optional(),
  sessionId: z.string().optional(),
  reasoningEffort: z.string().optional(),
  security: z.object({
    dangerouslyFullAccess: z.boolean().optional(),
    sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    networkAccess: z.boolean().optional()
  }).optional()
});

// ── Settings patch ──

export const SettingsPatchSchema = z.object({
  port: z.number().int().positive().max(65535).optional(),
  hostAllowlist: z.array(z.string()).optional(),
  auth: z.object({
    authRequired: z.boolean().optional(),
    pairingToken: z.string().optional()
  }).optional(),
  security: z.object({
    sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    approvalPolicy: z.enum(["allow-all", "approve-risky", "approve-all"]).optional(),
    networkAccess: z.boolean().optional(),
    requireTrustedWorkspace: z.boolean().optional()
  }).optional(),
  apiKeys: z.object({
    openai: z.string().optional(),
    anthropic: z.string().optional(),
    zhipu: z.string().optional()
  }).optional(),
  doubaoCommand: z.string().optional(),
  doubaoCdpEndpoint: z.string().optional(),
  doubaoUrl: z.string().optional(),
  mcp: z.any().optional(),
  codebaseMemory: z.object({
    autoMcp: z.boolean().optional()
  }).optional(),
  notificationEmail: z.string().optional()
}).passthrough();

// ── Browser fetch ──

export const BrowserFetchSchema = z.object({
  url: z.string().url("A valid URL is required"),
  method: z.enum(["GET", "POST"]).optional(),
  body: z.string().optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(60000).optional(),
  maxBytes: z.number().int().positive().max(5 * 1024 * 1024).optional()
});

// ── Workspace creation ──

export const WorkspaceCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  path: z.string().min(1, "Path is required"),
  allowedRoot: z.string().optional()
});

// ── Git action ──

export const GitActionSchema = z.object({
  action: z.string().min(1, "Action is required"),
  message: z.string().optional(),
  title: z.string().optional()
});

// ── Git file action ──

export const GitFileActionSchema = z.object({
  action: z.string().min(1, "Action is required"),
  path: z.string().min(1, "Path is required")
});

// ── Terminal session ──

export const TerminalSessionSchema = z.object({
  workspaceId: z.string().optional(),
  taskId: z.string().optional(),
  shell: z.string().optional(),
  mode: z.enum(["auto", "pty", "spawn"]).optional(),
  cols: z.number().int().positive().max(500).optional(),
  rows: z.number().int().positive().max(500).optional()
});

// ── Approval decision ──

// Agent Reach

export const AgentReachStatusSchema = z.object({
  timeoutMs: z.number().int().positive().max(600000).optional()
});

export const AgentReachSkillSchema = z.object({
  operation: z.enum(["install", "uninstall"]).default("install"),
  timeoutMs: z.number().int().positive().max(600000).optional()
});

export const AgentReachFormatSchema = z.object({
  platform: z.enum(["xhs"]),
  input: z.any().optional(),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600000).optional()
});

export const AgentReachTranscribeSchema = z.object({
  source: z.string().min(1, "Source is required"),
  provider: z.enum(["auto", "groq", "openai"]).optional(),
  timeoutMs: z.number().int().positive().max(600000).optional()
});

export const DoubaoStatusSchema = z.object({
  endpoint: z.string().optional(),
  url: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600000).optional()
});

export const DoubaoAskSchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  endpoint: z.string().optional(),
  url: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600000).optional()
});

export const DoubaoConfigureSchema = z.object({
  noDaemon: z.boolean().optional(),
  noOpen: z.boolean().optional(),
  port: z.number().int().min(0).max(65535).optional(),
  url: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600000).optional()
});

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().optional()
});

/**
 * Helper: parse a Zod schema and return a clean response on failure.
 * Returns { ok: true, data } or { ok: false, issues }.
 */
export function validate(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code
    }))
  };
}
