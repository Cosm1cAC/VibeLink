export const PROJECT_VISIBLE_LIMIT = 5;

function latestDate(...values) {
  let bestValue = "";
  let bestTime = -Infinity;
  for (const value of values) {
    const time = new Date(value || 0).getTime();
    if (!Number.isNaN(time) && time > bestTime) {
      bestTime = time;
      bestValue = value;
    }
  }
  return bestValue || values.find(Boolean) || "";
}

export function projectNameFromPath(value) {
  const clean = String(value || "").replace(/[\\/]+$/, "");
  if (!clean) return "No project";
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean;
}

export function projectKeyFromPath(value) {
  const clean = String(value || "").trim();
  return clean ? `project:${clean.toLowerCase()}` : "project:none";
}

function projectPathFromWorkspace(workspace) {
  return workspace?.path || workspace?.allowedRoot || "";
}

function ensureProject(projects, input) {
  const key = projectKeyFromPath(input.cwd);
  const existing = projects.get(key) || {
    key,
    kind: "project",
    provider: input.provider || "codex",
    title: input.title || projectNameFromPath(input.cwd),
    cwd: input.cwd,
    workspaceId: input.workspaceId || "",
    updatedAt: input.updatedAt || "",
    count: 0,
    children: []
  };
  if (input.workspaceId && !existing.workspaceId) existing.workspaceId = input.workspaceId;
  existing.updatedAt = latestDate(existing.updatedAt, input.updatedAt);
  projects.set(key, existing);
  return existing;
}

export function buildConversationTree(items, expandedProjects = {}, options = {}) {
  const projects = new Map();
  const noProject = [];
  const visibleLimit =
    options.projectItemLimit === Infinity
      ? Infinity
      : Number.isFinite(options.projectItemLimit)
        ? Math.max(0, options.projectItemLimit)
        : PROJECT_VISIBLE_LIMIT;

  for (const workspace of options.knownProjects || []) {
    const cwd = projectPathFromWorkspace(workspace);
    if (!cwd) continue;
    ensureProject(projects, {
      cwd,
      title: workspace.title || projectNameFromPath(cwd),
      updatedAt: workspace.lastUsedAt || workspace.updatedAt || workspace.createdAt || "",
      provider: "codex",
      workspaceId: workspace.id || ""
    });
  }

  for (const item of items) {
    if (!item.cwd || item.kind === "fork") {
      noProject.push(item);
      continue;
    }

    const project = ensureProject(projects, {
      cwd: item.cwd,
      title: projectNameFromPath(item.cwd),
      updatedAt: item.updatedAt,
      provider: item.provider
    });
    project.count += 1;
    project.children.push(item);
  }

  const nodes = [];
  for (const project of [...projects.values()].sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())) {
    const expanded = Boolean(expandedProjects[project.key]);
    const visibleChildren = expanded ? project.children : project.children.slice(0, visibleLimit);
    const hiddenCount = Math.max(0, project.children.length - visibleChildren.length);

    nodes.push({ ...project, expanded, hiddenCount });
    if (visibleChildren.length) {
      nodes.push(...visibleChildren.map((child) => ({ ...child, parentProjectKey: project.key, nested: true })));
    } else {
      nodes.push({ key: `${project.key}:empty`, kind: "project-empty", parentProjectKey: project.key });
    }
    if (hiddenCount) {
      nodes.push({ key: `${project.key}:more`, kind: "project-more", parentProjectKey: project.key, hiddenCount });
    }
  }

  if (noProject.length) {
    const key = "project:none";
    const expanded = Boolean(expandedProjects[key]);
    const visibleChildren = expanded ? noProject : noProject.slice(0, visibleLimit);
    const hiddenCount = Math.max(0, noProject.length - visibleChildren.length);

    nodes.push({
      key,
      kind: "project",
      provider: "codex",
      title: "No project",
      cwd: "",
      updatedAt: latestDate(...noProject.map((item) => item.updatedAt)),
      count: noProject.length,
      expanded,
      hiddenCount,
      children: noProject
    });
    nodes.push(...visibleChildren.map((child) => ({ ...child, parentProjectKey: key, nested: true })));
    if (hiddenCount) {
      nodes.push({ key: `${key}:more`, kind: "project-more", parentProjectKey: key, hiddenCount });
    }
  }

  return nodes;
}

export function filterConversationNodes(nodes, query) {
  const value = query.trim().toLowerCase();
  if (!value) return nodes;

  const visibleProjects = new Set();
  const matched = nodes.filter((item) => {
    if (item.kind === "project-empty" || item.kind === "project-more") return false;
    const text = `${item.title} ${item.provider} ${item.cwd} ${item.sessionId}`.toLowerCase();
    if (item.kind !== "project" && text.includes(value)) {
      if (item.parentProjectKey) visibleProjects.add(item.parentProjectKey);
      return true;
    }
    return item.kind === "project" && text.includes(value);
  });

  return nodes.filter((item) => {
    if (matched.includes(item)) return true;
    return item.kind === "project" && visibleProjects.has(item.key);
  });
}

export function filterConversationsByOrigin(items, sessionOrigin) {
  if (!sessionOrigin || sessionOrigin === "all") return items;
  return items.filter((item) => item.sessionOrigin === sessionOrigin);
}
