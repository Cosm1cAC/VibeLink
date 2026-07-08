// Command registry — centralized description of all VibeLink commands.
//
// Each command has:
//   { id, name, description, args, usage, permission, toolKind, icon }
//
// Used by:
//   - /api/command-registry (exposed to frontend)
//   - Skills loaded from ~/.vibelink/skills/ and .claude/skills/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// VibeLink built-in commands.
const BUILTIN_COMMANDS = [
  {
    id: "image",
    name: "/image",
    description: "Attach an image from your device",
    args: [{ name: "file", type: "file", required: true }],
    usage: "/image",
    permission: "none",
    toolKind: "file",
    icon: "ImageIcon",
    ui: { label: "Attach image", detail: "Select or paste an image" }
  },
  {
    id: "file",
    name: "/file",
    description: "Attach a file (PDF, text, data, code)",
    args: [{ name: "file", type: "file", required: true }],
    usage: "/file",
    permission: "none",
    toolKind: "file",
    icon: "FileText",
    ui: { label: "Attach file", detail: "Upload PDF, text, data, or code" }
  },
  {
    id: "folder",
    name: "/folder",
    description: "Upload files from a local folder",
    args: [{ name: "folder", type: "folder", required: true }],
    usage: "/folder",
    permission: "none",
    toolKind: "file",
    icon: "Folder",
    ui: { label: "Attach folder", detail: "Upload files from a local folder" }
  },
  {
    id: "workspace",
    name: "/workspace",
    description: "Pick files from workspace as LLM context",
    args: [],
    usage: "/workspace",
    permission: "none",
    toolKind: "workspace",
    icon: "FolderOpen",
    ui: { label: "Workspace context", detail: "Pick files from this computer" }
  },
  {
    id: "model",
    name: "/model",
    description: "Set the AI model (e.g. /model gpt-5.5)",
    args: [{ name: "model", type: "string", required: true, hint: "Model identifier" }],
    usage: "/model <name>",
    permission: "none",
    toolKind: "settings",
    icon: "SlidersHorizontal",
    ui: { label: "Model", detail: "Set Codex/Claude model" }
  },
  {
    id: "effort",
    name: "/effort",
    description: "Set reasoning effort (low/medium/high/xhigh/max)",
    args: [{ name: "level", type: "enum", values: ["low", "medium", "high", "xhigh", "max"], required: true }],
    usage: "/effort <level>",
    permission: "none",
    toolKind: "settings",
    icon: "Target",
    ui: { label: "Reasoning effort", detail: "Set low, medium, high, xhigh, max" }
  },
  {
    id: "agent",
    name: "/agent",
    description: "Switch AI provider (codex/claude/zhipu/doubao)",
    args: [{ name: "provider", type: "enum", values: ["codex", "claude", "zhipu", "doubao"], required: true }],
    usage: "/agent <provider>",
    permission: "none",
    toolKind: "settings",
    icon: "Monitor",
    ui: { label: "Agent", detail: "Switch provider" }
  },
  {
    id: "permissions",
    name: "/permissions",
    description: "Set permission mode (default/workspace-write/full-access)",
    args: [{ name: "mode", type: "enum", values: ["default", "workspace-write", "full-access"], required: true }],
    usage: "/permissions <mode>",
    permission: "none",
    toolKind: "settings",
    icon: "CheckSquare",
    ui: { label: "Full access", detail: "Switch permission mode" }
  },
  {
    id: "history",
    name: "/history",
    description: "Reuse a previous prompt from history",
    args: [],
    usage: "/history",
    permission: "none",
    toolKind: "settings",
    icon: "History",
    ui: { label: "Prompt history", detail: "Reuse a previous prompt" }
  },
  {
    id: "clear",
    name: "/clear",
    description: "Clear the current input draft",
    args: [],
    usage: "/clear",
    permission: "none",
    toolKind: "settings",
    icon: "X",
    ui: { label: "Clear input", detail: "Remove current draft" }
  }
];

// Skills directory for VibeLink-specific skills.
const VIBELINK_SKILLS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".vibelink", "skills"
);

// Also scan .claude/skills for compatibility.
const CLAUDE_SKILLS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".claude", "skills"
);

const SKILL_SCAN_DIRS = [
  VIBELINK_SKILLS_DIR,
  CLAUDE_SKILLS_DIR
];

/**
 * Scan the skills directories for SKILL.md files.
 * Returns an array of Command-shaped objects.
 */
function scanSkills() {
  const skills = [];
  for (const dir of SKILL_SCAN_DIRS) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
      const skillPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      const parsed = parseSkillMd(skillPath, entry.name);
      if (parsed) skills.push(parsed);
    }
  }
  return skills;
}

/**
 * Minimal SKILL.md parser. Extracts YAML frontmatter and full body.
 * Returns a Command-shaped object.
 */
function parseSkillMd(filePath, dirName) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    let meta = {};
    let body = raw;
    if (frontmatterMatch) {
      const yaml = frontmatterMatch[1];
      body = frontmatterMatch[2].trim();
      // Simple YAML key-value extraction.
      for (const line of yaml.split("\n")) {
        const kv = line.match(/^\s*(\w[\w_]*)\s*:\s*(.+)$/);
        if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
      }
    }
    const name = meta.name || dirName;
    return {
      id: `skill:${dirName}`,
      name: `/skill ${name}`,
      description: meta.description || meta.when_to_use || `Skill: ${name}`,
      args: [],
      usage: `/skill ${name}`,
      permission: meta.allowed_tools ? "ask" : "none",
      toolKind: "plugin",
      icon: "Code2",
      source: filePath,
      body,
      meta
    };
  } catch {
    return null;
  }
}

/**
 * Get all commands (built-in + skills).
 * Optionally filtered by a search string.
 */
export function getCommands(filter = "") {
  const builtins = BUILTIN_COMMANDS;
  const skills = scanSkills();
  const all = [...builtins, ...skills];

  if (!filter) return all;
  const lower = filter.toLowerCase();
  return all.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(lower) ||
      cmd.description.toLowerCase().includes(lower) ||
      cmd.ui?.label?.toLowerCase().includes(lower)
  );
}

/**
 * Get a single command by id.
 */
export function getCommand(id) {
  return BUILTIN_COMMANDS.find((cmd) => cmd.id === id) ||
         scanSkills().find((cmd) => cmd.id === id) ||
         null;
}

/**
 * Get structured help for a command. Returns the same data as
 * the command definition but formatted for display.
 * When `json` is true, returns the raw definition object.
 */
export function describeCommand(id, { json = false } = {}) {
  const cmd = getCommand(id);
  if (!cmd) return null;
  if (json) return cmd;
  const argsHelp = (cmd.args || []).map((a) =>
    `${a.required ? "" : "["}${a.name}:${a.type}${a.values ? "=" + a.values.join("|") : ""}${a.required ? "" : "]"}`).join(" ");
  return {
    name: cmd.name,
    description: cmd.description,
    usage: cmd.usage,
    args: argsHelp,
    permission: cmd.permission
  };
}

/**
 * Reload skills from disk (called via /api/command-registry/refresh).
 */
export function refreshSkills() {
  // Skills are scanned on every getCommands call, so "refresh" is a no-op.
  return getCommands().length;
}
