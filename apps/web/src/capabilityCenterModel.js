export const capabilityCategories = [
  { id: "plugins", label: "Plugins" },
  { id: "hooks", label: "Hooks" },
  { id: "automations", label: "Automations" },
  { id: "subagents", label: "Subagents" },
  { id: "config", label: "AGENTS / config" }
];

export function capabilityCenterCopy(language = globalThis.navigator?.language || "zh-CN") {
  const english = /^en(?:-|$)/i.test(String(language));
  return english ? {
    ariaLabel: "Capability center",
    heading: "Capability center",
    subtitle: "Managed lifecycle and source-aware Agent configuration.",
    refresh: "Refresh capabilities",
    category: { plugins: "Plugins", hooks: "Hooks", automations: "Automations", subagents: "Subagents", config: "AGENTS / config" },
    pluginId: "Plugin id",
    pluginName: "Plugin name",
    pluginVersion: "Plugin version",
    install: "Install",
    automationTitle: "Automation title",
    scheduleType: "Schedule type",
    once: "Once",
    interval: "Interval",
    cron: "Cron",
    scheduleValue: "Schedule value",
    prompt: "Agent prompt",
    create: "Create",
    parentTask: "Parent task id",
    subagentPrompt: "Subagent prompt",
    provider: "Subagent provider",
    start: "Start",
    loading: "Loading...",
    empty: (name) => `No ${name} found.`,
    enable: "Enable",
    disable: "Disable",
    remove: "Remove plugin",
    run: "Run automation",
    delete: "Delete automation",
    stop: "Stop",
    save: "Save",
    enabled: "enabled",
    disabled: "disabled",
    parent: "Parent",
    agent: "agent",
    next: "next",
    last: "last",
    never: "never",
    operationCompleted: "Operation completed.",
    subagentStarted: "Subagent started.",
    hookEnabled: "Hook enabled.",
    hookDisabled: "Hook disabled.",
    subagentStopped: "Subagent stopped.",
    automationTitleRequired: "Automation title is required.",
    automationPromptRequired: "Automation prompt is required.",
    approvalRequired: "Explicit approval required.",
    approvalPending: (id) => id ? `Approval ${id} is pending in Settings > Approvals.` : "Open Settings > Approvals.",
    operationFailed: "Operation failed."
  } : {
    ariaLabel: "能力中心",
    heading: "能力中心",
    subtitle: "管理扩展生命周期与 Agent 配置。",
    refresh: "刷新能力",
    category: { plugins: "插件", hooks: "钩子", automations: "自动化", subagents: "子代理", config: "AGENTS / 配置" },
    pluginId: "插件 ID",
    pluginName: "插件名称",
    pluginVersion: "插件版本",
    install: "安装",
    automationTitle: "自动化标题",
    scheduleType: "计划类型",
    once: "一次性",
    interval: "间隔",
    cron: "Cron",
    scheduleValue: "计划值",
    prompt: "Agent 提示词",
    create: "创建",
    parentTask: "父任务 ID",
    subagentPrompt: "子代理提示词",
    provider: "子代理提供方",
    start: "启动",
    loading: "加载中...",
    empty: (name) => `暂无${name}。`,
    enable: "启用",
    disable: "停用",
    remove: "移除插件",
    run: "运行自动化",
    delete: "删除自动化",
    stop: "停止",
    save: "保存",
    enabled: "已启用",
    disabled: "已停用",
    parent: "父任务",
    agent: "代理",
    next: "下次",
    last: "上次",
    never: "从未运行",
    operationCompleted: "操作已完成。",
    subagentStarted: "子代理已启动。",
    hookEnabled: "钩子已启用。",
    hookDisabled: "钩子已停用。",
    subagentStopped: "子代理已停止。",
    automationTitleRequired: "请输入自动化标题。",
    automationPromptRequired: "请输入 Agent 提示词。",
    approvalRequired: "需要显式批准。",
    approvalPending: (id) => id ? `批准 ${id} 正在设置 > 批准中等待处理。` : "请打开设置 > 批准。",
    operationFailed: "操作失败。"
  };
}

export function automationDraftPayload(draft = {}, copy = capabilityCenterCopy("en-US")) {
  const title = String(draft.title || "").trim();
  const prompt = String(draft.prompt || "").trim();
  if (!title) throw new Error(copy.automationTitleRequired);
  if (!prompt) throw new Error(copy.automationPromptRequired);
  return { title, enabled: true, schedule: { type: draft.type || "interval", value: String(draft.value || "3600000") }, payload: { prompt } };
}

export function capabilityOperationMessage(error, successText = "Operation completed.", copy = capabilityCenterCopy("en-US")) {
  if (!error) return { tone: "success", text: successText };
  if (error.status === 428) {
    const id = error.data?.approvalId || error.data?.approval?.id || "";
    const reason = error.data?.error || error.message || copy.approvalRequired;
    return { tone: "approval", text: `${reason} ${copy.approvalPending(id)}` };
  }
  return { tone: "error", text: error.message || copy.operationFailed };
}
