import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function error(message, status = 400, code = "CAPABILITY_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id)) throw error("Plugin id is invalid.");
  return id;
}

function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function atomicWrite(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await fs.promises.rename(temporary, filePath);
  } catch (failure) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw failure;
  }
}

function redactConfig(value) {
  return String(value || "").split(/\r?\n/).map((line) =>
    /["']?(?:token|password|secret|api[_-]?key)["']?\s*[=:]/i.test(line)
      ? `${line.match(/^\s*/)?.[0] || ""}[REDACTED]`
      : line
  ).join("\n").slice(0, 12_000);
}

async function readJson(filePath) {
  try { return JSON.parse(await fs.promises.readFile(filePath, "utf8")); } catch { return null; }
}

export function createCapabilityRuntime({ rootDir, homeDir, getTasks = () => [], automationRuntime = null }) {
  const activePlugins = path.join(homeDir, ".codex", "plugins");
  const disabledPlugins = path.join(homeDir, ".codex", "plugins-disabled");
  const managedMarker = ".vibelink-managed.json";
  const textResources = new Map([
    ["project-agents", { path: path.join(rootDir, "AGENTS.md"), label: "Project AGENTS.md", editable: true }],
    ["global-agents", { path: path.join(homeDir, ".codex", "AGENTS.md"), label: "Global AGENTS.md", editable: false }],
    ["claude-rules", { path: path.join(homeDir, ".claude", "CLAUDE.md"), label: "Claude rules", editable: false }],
    ["codex-config", { path: path.join(homeDir, ".codex", "config.toml"), label: "Codex config", editable: false }],
    ["claude-config", { path: path.join(homeDir, ".claude", "settings.json"), label: "Claude settings", editable: false }]
  ]);

  async function scanPluginRoot(root, enabled) {
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
    const items = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, entry.name);
      const manifestPath = path.join(directory, ".codex-plugin", "plugin.json");
      const manifest = await readJson(manifestPath);
      if (!manifest) continue;
      const managed = Boolean(await readJson(path.join(directory, managedMarker)));
      const stat = await fs.promises.stat(manifestPath);
      items.push({
        id: entry.name,
        category: "plugins",
        label: String(manifest.name || entry.name),
        version: String(manifest.version || ""),
        source: directory,
        enabled,
        managed,
        updatedAt: stat.mtime.toISOString(),
        capabilities: { view: true, enable: managed, update: managed, remove: managed }
      });
    }
    return items;
  }

  async function listPlugins() {
    return [...await scanPluginRoot(activePlugins, true), ...await scanPluginRoot(disabledPlugins, false)]
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  async function requireManagedPlugin(id) {
    const key = safeId(id);
    for (const root of [activePlugins, disabledPlugins]) {
      const directory = path.join(root, key);
      if (!within(root, directory)) continue;
      if (await readJson(path.join(directory, managedMarker))) return { directory, root, enabled: root === activePlugins };
    }
    throw error("Managed plugin not found.", 404, "CAPABILITY_NOT_FOUND");
  }

  async function installPlugin(input = {}) {
    const id = safeId(input.id || input.manifest?.name);
    const manifest = input.manifest && typeof input.manifest === "object" ? input.manifest : {};
    if (!String(manifest.name || "").trim()) throw error("Plugin manifest name is required.");
    const files = input.files && typeof input.files === "object" ? Object.entries(input.files) : [];
    if (files.length > 100) throw error("Plugin contains too many files.", 413, "CAPABILITY_TOO_LARGE");
    const existing = (await listPlugins()).find((item) => item.id === id);
    if (existing) throw error("Plugin already exists.", 409, "CAPABILITY_CONFLICT");
    const directory = path.join(activePlugins, id);
    await atomicWrite(path.join(directory, ".codex-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await atomicWrite(path.join(directory, managedMarker), `${JSON.stringify({ id, installedAt: new Date().toISOString() }, null, 2)}\n`);
    for (const [relative, content] of files) {
      const target = path.join(directory, relative);
      if (!within(directory, target) || path.isAbsolute(relative) || Buffer.byteLength(String(content)) > 1024 * 1024) {
        await fs.promises.rm(directory, { recursive: true, force: true });
        throw error("Plugin file is invalid.");
      }
      await atomicWrite(target, String(content));
    }
    return (await listPlugins()).find((item) => item.id === id);
  }

  async function setPluginEnabled(id, enabled) {
    const plugin = await requireManagedPlugin(id);
    if (plugin.enabled === Boolean(enabled)) return (await listPlugins()).find((item) => item.id === id);
    const targetRoot = enabled ? activePlugins : disabledPlugins;
    const target = path.join(targetRoot, safeId(id));
    await fs.promises.mkdir(targetRoot, { recursive: true });
    await fs.promises.rename(plugin.directory, target);
    return (await listPlugins()).find((item) => item.id === id);
  }

  async function updatePlugin(id, input = {}) {
    const plugin = await requireManagedPlugin(id);
    if (input.manifest) await atomicWrite(path.join(plugin.directory, ".codex-plugin", "plugin.json"), `${JSON.stringify(input.manifest, null, 2)}\n`);
    return (await listPlugins()).find((item) => item.id === id);
  }

  async function removePlugin(id) {
    const plugin = await requireManagedPlugin(id);
    if (!within(plugin.root, plugin.directory)) throw error("Plugin path is invalid.");
    await fs.promises.rm(plugin.directory, { recursive: true, force: true });
    return { ok: true, id: safeId(id) };
  }

  async function listConfig() {
    const items = [];
    for (const [id, resource] of textResources) {
      const content = await fs.promises.readFile(resource.path, "utf8").catch(() => null);
      if (content == null) continue;
      const stat = await fs.promises.stat(resource.path);
      items.push({ id, category: "config", label: resource.label, source: resource.path, digest: digest(content), preview: redactConfig(content), updatedAt: stat.mtime.toISOString(), capabilities: { view: true, edit: resource.editable } });
    }
    return items;
  }

  async function listHooks() {
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    const settings = await readJson(settingsPath);
    const disabledPath = path.join(homeDir, ".claude", ".vibelink-disabled-hooks.json");
    const disabled = await readJson(disabledPath) || {};
    const active = Object.entries(settings?.hooks || {}).map(([event, hooks]) => ({
      id: `claude:${event}`,
      category: "hooks",
      label: event,
      source: settingsPath,
      enabled: true,
      count: Array.isArray(hooks) ? hooks.length : 1,
      capabilities: { view: true, enable: true, run: false }
    }));
    const inactive = Object.entries(disabled).map(([event, hooks]) => ({ id: `claude:${event}`, category: "hooks", label: event, source: settingsPath, enabled: false, count: Array.isArray(hooks) ? hooks.length : 1, capabilities: { view: true, enable: true, run: false } }));
    return [...active, ...inactive];
  }

  async function setHookEnabled(id, enabled) {
    const event = String(id || "").startsWith("claude:") ? String(id).slice(7) : "";
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(event)) throw error("Hook id is invalid.");
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    const disabledPath = path.join(homeDir, ".claude", ".vibelink-disabled-hooks.json");
    const settings = await readJson(settingsPath) || {};
    const disabled = await readJson(disabledPath) || {};
    settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
    if (enabled) {
      if (settings.hooks[event] == null && disabled[event] != null) { settings.hooks[event] = disabled[event]; delete disabled[event]; }
    } else if (settings.hooks[event] != null) {
      disabled[event] = settings.hooks[event]; delete settings.hooks[event];
    }
    await atomicWrite(disabledPath, `${JSON.stringify(disabled, null, 2)}\n`);
    await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    return (await listHooks()).find((item) => item.id === `claude:${event}`);
  }

  function listSubagents() {
    return getTasks().map((task) => ({ ...task, parentTaskId: task.parentTaskId || task.meta?.parentTaskId || "" }))
      .filter((task) => task.parentTaskId)
      .map((task) => ({ id: task.id, category: "subagents", label: task.title || task.id, parentTaskId: task.parentTaskId, status: task.status, agent: task.agent || "", updatedAt: task.updatedAt || "", capabilities: { view: true, stop: ["running", "starting"].includes(task.status) } }));
  }

  async function list(category) {
    if (category === "plugins") return listPlugins();
    if (category === "hooks") return listHooks();
    if (category === "automations") return automationRuntime?.list() || [];
    if (category === "subagents") return listSubagents();
    if (category === "config") return listConfig();
    throw error("Unknown capability category.");
  }

  async function updateTextResource(id, input = {}) {
    const resource = textResources.get(String(id));
    if (!resource || !resource.editable) throw error("Resource is read-only.", 405, "CAPABILITY_READ_ONLY");
    const current = await fs.promises.readFile(resource.path, "utf8").catch(() => "");
    if (!input.expectedDigest || digest(current) !== input.expectedDigest) throw error("Resource changed since it was loaded.", 409, "CAPABILITY_CONFLICT");
    const text = String(input.text || "");
    if (Buffer.byteLength(text) > 1024 * 1024) throw error("Resource is too large.", 413, "CAPABILITY_TOO_LARGE");
    await atomicWrite(resource.path, text);
    return (await listConfig()).find((item) => item.id === id);
  }

  return { list, installPlugin, updatePlugin, setPluginEnabled, removePlugin, setHookEnabled, updateTextResource };
}
