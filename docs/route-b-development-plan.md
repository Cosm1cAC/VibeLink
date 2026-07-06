# Route B CLI 能力补齐计划

> 基线：`reference/cli-analysis/`（Claude Code 泄露源码分析，作为架构参考，非代码来源）
> 前序文件：`docs/route-b-completion-report.md`、`docs/cli-capability-alignment-plan.md`
> 最后更新：2026-07-06

---

## 1. 阅读指引

本文档面向"参照 Claude Code 参考源码，把 VibeLink Route B 的 CLI 运行时能力补齐到可产品化程度"。内容分为三部分：

1. **已有能力的对应关系**——Claude Code 模块 → VibeLink 实现：说明本项目已经做了哪些、怎么做的。
2. **参照参考实现的补齐清单**——从 Claude Code 源码提炼的架构特征，逐个评估缺不缺、要不要补。
3. **对接 Route C 路线**——Live Call 检测到问题后怎么无缝走完 Route B 全链路。
4. **落地批次与排期**。

---

## 2. 已有能力的对应关系

### 2.1 Tool 注册表与执行管线

| Claude Code 模块 | 对应实现 | 说明 |
|-----------------|---------|------|
| `src/Tool.ts` — Tool 类型定义 + schema | `src/toolRegistry.js` | VibeLink 用 JSON schema 描述每个工具的 kind、permissionDomain、riskCategory、uiLabel |
| `src/tools.ts` — 工具池组装 | `src/toolRegistry.js` | `/api/tool-registry` 统一暴露 |
| `src/services/tools/toolOrchestration.ts` — 并发安全分组 | `src/toolRuntime.js` | VibeLink 按 tool run id 分组，目前单线程执行 |
| `src/services/tools/StreamingToolExecutor.ts` — 执行器 | `src/toolRuntime.js` | tool run 创建、审批、执行、事件 |
| `src/services/tools/toolExecution.ts` — 逐个工具执行 | `src/agentToolBridge.js` | stream-json 映射 + 回调 |

### 2.2 权限与审批

| Claude Code 模块 | 对应实现 | 说明 |
|-----------------|---------|------|
| `src/permissions/` — allow/ask/deny/always_allow | `src/commandSafety.js` + `approval_requests` | VibeLink 用风险评估 + 持久审批表 |
| `src/ui/PermissionRequest` — 交互审批 | Settings 面板 + `/api/approvals` | 跨设备用 HTTP 接口审批 |
| SandboxPermissionRequest | 策略型沙箱 + doctor | 当前没有原生沙箱后端，走 policy-only |

### 2.3 Memory / Transcript / Session

| Claude Code 模块 | 对应实现 | 说明 |
|-----------------|---------|------|
| `src/utils/sessionStorage.ts` — append-only JSONL | VibeLink 用 SQLite `task_events` + `tool_events` | 事件流相同，存储介质不同（SQLite vs JSONL） |
| `src/utils/sessionStoragePortable.ts` — 跨 session 复制 | 无 | **待补** |
| `src/services/api/sessionIngress.ts` — 远端 ingress | `restoreLiveCallSessions()` | Route C 的 SQLite 持久化已补，但通用 session ingress 未做 |
| `src/screens/ResumeConversation.tsx` — 恢复 | Web 端 ConversationList + WorkspaceWorkbench | 前端已有列表，但无"修复 tool result 关系"的恢复逻辑 |

### 2.4 Context / Budget / Compact

| Claude Code 模块 | 对应实现 | 说明 |
|-----------------|---------|------|
| `src/utils/context.ts` — 上下文窗口计算 | **未实现** | **核心缺口** |
| `src/services/compact/autoCompact.ts` — 自动压缩 | **未实现** | **核心缺口** |
| `src/services/compact/compactService.ts` — compact 编排 | **未实现** | **核心缺口** |
| `src/services/compact/summaryHelpers.ts` — summary 生成 | **未实现** | **核心缺口** |

### 2.5 Skills

| Claude Code 模块 | 对应实现 | 说明 |
|-----------------|---------|------|
| `src/skills/loadSkillsDir.ts` — 文件系统技能扫描 | **未实现** | 需补 Skills 发现 + 加载 |
| `src/skills/bundledSkills.ts` — 内建技能 | **未实现** | 需补 |
| `src/utils/promptShellExecution.ts` — Shell 执行包装 | 无 | 暂不优先 |

### 2.6 Multi-Agent

| Claude Code 模块 | 对应实现 | 说明 |
|-----------------|---------|------|
| `src/services/agent/` — subagent / teammate / swarm | **未实现** | Phase 5 范围 |

---

## 3. 参照参考实现的补齐清单

下面按优先级从高到低列出，每个条目附带参考源码路径和 VibeLink 的落地思路。

### P0：Web 前端终端视图

**参考**：Claude Code 的 `src/components/` TUI 组件体系

**现状**：workspace 终端 tab 只有输入框 + 输出区域，没有 ANSI 解析、没有终端仿真、没有历史回滚。

**需求**：
1. 在 workspace 终端 tab 里嵌入 ANSI 终端体验（至少支持颜色、回滚、行选择）
2. `terminal-session`  tool run 的事件流（`tool.output`）渲染为连续可滚动输出
3. 支持 stdin 输入（通过 `/api/workspaces/:id/terminal-session` 已有）

**落地方式**：
- 前端可用 `xterm.js` 或自建简化的 ANSI 解析器
- tool event stream → ANSI 渲染 → 持续滚动
- 现有 PTY session API 已完整，前端是唯一短板

**验收**：在 workspace 终端里能跑 `ping`、`npm test`、`top` 等持续输出命令，看到彩色 ANSI 输出，能 Ctrl+C 停止。

### P0：纯非交互命令，停止后有完整回滚，没有PTY，也能看到命令的全部输出，可上下滚动查看

**参考**：Claude Code 的 `BashTool.tsx` → `tool.output` + `tool.result`

**现状**：workspace shell 命令的 `tool.output` 事件在 tool card 里渲染为连续行，但前端 "workspace-git-output" 区域只显示最近几行，没有完整回滚。

**需求**：
1. workspace shell 命令的 `tool.output` 事件在 tool card 里的渲染要支持完整 scrollback
2. 停止后不应丢失已有输出，要能回滚查看
3. 输出区域支持行号、复制选区

**落地方式**：
- `tool.output` 事件已经带 `stream`（stdout/stderr）、`bytes`、`elapsedMs`
- 前端累积所有 `tool.output` 到一个可滚动的 `<pre>` 块
- tool card 头部添加"查看完整输出"展开/收起按钮

**验收**：跑一个 `ls -R` 或 `npm test`，输出超过 20 行时能完整回滚查看；停止后输出不丢失。

### P0：Agent 任务中的 tool output 流式渲染到消息列表

**参考**：Claude Code 的 `query.ts` → tool_use → tool_result 回流
  
**现状**：Route B Agent 任务通过 SSE 返回事件，但 **前端消息列表里对 Agent 调用的工具没有流式 tool output 渲染**——只有 task 完成的最终结果，中间没有工具调用卡片、输出和状态的实时更新。

**需求**：
1. Agent 运行中的 tool_run 创建、tool.output、tool.error、tool.result 事件在前端消息流里显示为 tool card
2. tool card 在 Agent 思考过程中实时更新（输出流式追加、状态变化）
3. 工具完成后 card 保留最终状态（成功/失败/取消/过期）

**落地方式**：
- 前端消息流已经订阅了 task/tool events SSE（`/api/tasks/${id}/events` 和 `/api/tool-events?taskId=${id}&stream=1` 两条路线）
- 新增前端 `ToolCard` 组件，按 `tool_run_id` 聚合 tool event 流
- ToolCard 支持展示生命周期、输出文本、错误、完成状态
- 利用 `tool_events` 的 `lifecycle` 字段和 `text` 输出

**验收**：启动 Route B Agent 任务（如 `claude prompt -p "帮我拉取代码并跑测试"`），前端消息列表实时看到 tool card 从 created → running → output → completed 的完整过程；输出追加显示。

### P0：统一 session event log（turn/block/tool_run/metadata/artifact/approval 分层）

**参考**：`src/utils/sessionStorage.ts`—append-only event stream，事件分为 user/assistant/attachment/system/tool 类型

**现状**：VibeLink 现在有三张事件表——`task_events`（通用事件）、`tool_events`（工具事件）、`live_call_events`（通话事件）。它们结构相似但独立。

**需求**：
1. 统一事件模型：一个 session 一个 append-only 流，事件类型的 header 区分 user/assistant/system/tool/tool_run/approval/artifact/transcript
2. 所有路线共用同一套事件表（至少提供视图层映射）
3. 事件带精确的 `parent_id`、`turn_id`、`block_id` 关系

**落地方式**：
- 在 `task_events` 表基础上扩展 `event_kind` 字段（`user_message` / `assistant_message` / `tool_run` / `tool_output` / `approval` / `artifact` / `system` / `transcript`）
- 新增 `parent_event_cursor`、`turn_id` 字段
- 把 `tool_events` 的 `event_type` 和 `lifecycle` 映射到统一 event model
- `live_call_events` 兼容到同一模型（通过 `session_id` 映射到 `task_id`）

**验收**：一个 Route B 任务从开始到结束的所有事件（agent 消息、工具调用、输出、审批、结果）能从同一张表按 cursor 排序流式重放。

### P1：上下文预算器 + 自动压缩

**参考**：`src/utils/context.ts`、`src/services/compact/autoCompact.ts`、`src/services/compact/compactService.ts`、`src/services/compact/summaryHelpers.ts`

**现状**：完全没有。当前依赖上游 CLI（Codex/Claude）自己的上下文管理能力，VibeLink 只透传不参与。

**需求**：
1. 任务启动前估算 prompt 长度（token count 用 `tiktoken` 或 `js-tiktoken`）
2. 过程关键节点自动插入 summary 事件
3. summary 事件携带压缩后的前文摘要，恢复时优先使用
4. 预留 `MAX_OUTPUT_TOKENS_FOR_SUMMARY` 类似的安全窗口

**落地方式**：
- `npm install js-tiktoken`（纯 JS 实现，不依赖 Python）
- `src/contextBudget.js` — 估算 + 预留
- `src/compactService.js` — 在 task_events 中插入 `type: "summarization"` 的 summary 事件
- 恢复任务时优先注入最新 summary，替代全量历史

**验收**：一个超长任务（>100 轮对话）中，VibeLink 自动插入至少一个 summary 事件；恢复后模型行为与未压缩前一致。

### P1：Skills 发现 + 加载

**参考**：`src/skills/loadSkillsDir.ts`、`src/skills/bundledSkills.ts`

**现状**：没有 VibeLink 自己的技能系统。只有 ZCode CLI 的 skills（来自外部插件），不在本项目范围内。

**需求**：
1. 从 `~/.vibelink/skills/` 目录加载 Markdown + YAML 技能文件
2. 技能注册为 `system.skill` kind 的 tool registry 条目
3. 技能在 Agent prompt 中以 system message 注入
4. 扫描本地 `.claude/skills/` 目录兼容加载

**落地方式**：
- `src/skills/loadSkillsDir.js` — 扫描 `.md` + `.yaml` 文件，解析 frontmatter
- `src/skills/bundledSkills.js` — VibeLink 内建技能（基础命令、工作流模版等）
- Skills 注入 tool registry，Agent 通过 tool_use 调用

**验收**：在 `~/.vibelink/skills/` 放一个 `review-pr.md` 技能文件，Agent 任务中能识别并调用。

### P1：CLI Command Registry

**参考**：`src/commands.ts` — 命令注册表，集中描述参数、权限、UI

**现状**：已有部分 slash commands（`/workspace`、`/model`、`/settings` 等），但分散在 main.jsx 里，没有统一注册表。

**需求**：
1. 新增 `/api/command-registry`，列出所有可用命令、参数、权限描述
2. 前端命令面板支持搜索、分类显示
3. 命令可以关联权限等级和 tool registry 条目

**落地方式**：
- `src/commandRegistry.js` — 集中注册所有 VibeLink 命令
- 每个命令带 `{ id, name, description, args, permission, toolKind }`
- 前端 `/commands` 面板从 API 拉取并渲染

**验收**：在手机端打开命令面板，能看到所有可用命令、描述和需要的权限。

### P2：Turn/Block 关系重建 + 恢复校准

**参考**：`src/utils/conversationRecovery.ts`、`src/screens/ResumeConversation.tsx`

**现状**：task_events 是扁平列表，没有 turn/block 关系。恢复时只能完整重放，不能局部校准。

**需求**：
1. 每个事件携带 `turn_id` 和 `block_id`，由 `createTask` 或第一个事件注入
2. 恢复时校验是否完整（没有 incomplete tool run、没有 orphaned approval）
3. 标记 incomplete 事件并在 UI 中显示

**落地方式**：
- `task_events` 表加 `turn_id` 和 `block_id` 字段
- `src/sessionRecovery.js` — 恢复时扫描校验
- 前端在消息列表中显示"工具调用未完成"标记

**验收**：中断一个 Agent 任务（Ctrl+C），恢复后前端能看到"此工具调用未完成"标记。

### P2：Memory / 项目知识

**参考**：`src/services/compact/summaryHelpers.ts`、`src/utils/memdir.ts`

**现状**：完全空白

**需求**：
1. 项目级 memory 文件：`~/.vibelink/memory/` 下每个项目一个 markdown
2. Agent 启动时注入相关 memory
3. 用户可在 Settings 中查看、编辑、清空 memory

**落地方式**：
- `src/memory/MemoryFileManager.js`
- `src/memory/projectMemory.js`
- 注入方式参考 Skills

**验收**：在 Settings 里查看、编辑一条 memory，重启 Agent 后 memory 内容出现在 prompt 中。

---

## 4. 对接 Route C 的完整链路

当前 Route C → Route B 的链路已经搭通（`liveCallAgent.js` → `dispatchLiveCallQuestion` → `createTask` → `appendAgentTaskLiveCallDelta`），但还缺少几个环节才能真正产品化：

### 4.1 已连通的环节

```
通话音频 → WASAPI loopback
  → windows-audio-probe stream (WebSocket PCM)
  → liveCallAudio.js (PCM 帧接收)
  → liveCallAsr.js (Mock/Whisper.cpp ASR)
  → recordLiveCallTranscript → SSE (live_call.transcript.partial/final)
  → question.detected (内置正则检测)
  → liveCallAgent.js → createTask (Route B CLI Agent)
  → live_call.agent.delta / live_call.agent.done SSE
  → Web UI 问答卡片
```

### 4.2 还需要补的环节

| 环节 | 现状 | 需要做的 |
|------|------|---------|
| **Tool card 流式渲染** | Agent 工具的 tool output 不实时显示 | 前端 ToolCard 组件聚合 tool_events 流 |
| **Agent 思考状态提示** | 只有最终答案，没有"正在分析问题…" | 前端显示 `live_call.agent.thinking` 事件 |
| **问题检测去重** | 连续 final 会重复触发 | `liveCallAgent.js` 已有 debounce 1500ms，还需 per-question-text hash 去重 |
| **历史上下文携带** | dispatch 时只带最近 6 条 transcript | P2 阶段接入统一 session event log，提供完整上下文 |
| **挂载到正确 workspace** | 用 process.cwd() 未指定 | 在 createLiveCallSession 时传入 `workspaceId`，agent 启动在该 workspace 下 |
| **通话结束后自动停止 agent** | 手动 stop，未自动 | stopLiveCallSession 已有 hook，已调用 stopLiveCallAgentTask |
| **Agent 结果写入 session event log** | agent.done 只写 live_call_events | 应同时写入 task_events，统一事件模型后自动覆盖 |

### 4.3 Route C 专属前端面板完善

| 功能 | 现状 | 需要做的 |
|------|------|---------|
| 通话中 Agent 回答流式展示 | 只显示最终答案卡片 | 前端 LiveCallPanel 接入 `live_call.agent.delta` 流式追加 |
| Agent 思考状态动画 | 无 | 显示"正在思考…"占位，delta 到达后替换 |
| 问题手动重试 | 无 | 在问答卡片加"重试"按钮调用 `/api/live-calls/:id/answer` |
| 暂停/恢复 ASR | 无 | LiveCallPanel 加 pause/resume 按钮，控制 ASR 输入开关 |

---

## 5. 落地批次与排期

### Batch 1：前端工具体验闭环（P0，预估 3-5 天）

| 任务 | 文件范围 | 依赖 |
|------|---------|------|
| ToolCard 组件 + tool_events 流式聚合 | `apps/web/src/main.jsx` (新组件) | 无 |
| Workspace shell 输出完整 scrollback | `apps/web/src/main.jsx` + `public/styles.css` | 无 |
| Agent tool output 流式渲染 | `apps/web/src/main.jsx` (消息渲染) | ToolCard 组件 |
| Workspace 终端 ANSI 回滚 | `apps/web/src/main.jsx` (workspace tab) | 无 |

**验收**：跑一个 `npm test` 看到完整输出；Agent 任务中工具输出实时渲染为 tool card；PTY 终端输出可回滚。

### Batch 2：统一 session event log（P0，预估 2-3 天）

| 任务 | 文件范围 | 依赖 |
|------|---------|------|
| task_events 扩展 `event_kind` + `turn_id` + `block_id` | `src/db.js` | Batch 1 |
| tool_events → task_events 统一映射 | `src/toolRuntime.js`、`src/db.js` | 无 |
| live_call_events 兼容到统一模型 | `src/liveCall.js`、`src/db.js` | 无 |
| `/api/tasks/:id/events` 统一事件流 | `src/server.js` | 上述 |

**验收**：一个 Route B 任务的所有事件（agent 消息、工具调用、输出、审批、结果）能从同一张表按 cursor 排序流式重放。

### Batch 3：上下文预算 + 自动压缩（P1，预估 3-5 天）

| 任务 | 文件范围 | 依赖 |
|------|---------|------|
| js-tiktoken 安装 + token 估算 | 新增 `src/contextBudget.js` | Batch 2 |
| summary 事件 generation | 新增 `src/compactService.js` | 无 |
| 恢复时优先注入 summary | `src/liveCallAgent.js`、`src/agents.js` | Batch 2 |

**验收**：超长任务自动插入 summary；恢复后模型行为一致。

### Batch 4：Command Registry + Skills（P1，预估 3-4 天）

| 任务 | 文件范围 | 依赖 |
|------|---------|------|
| commandRegistry.js | 新增文件 | 无 |
| `/api/command-registry` | `src/server.js` | 无 |
| 前端命令面板 | `apps/web/src/main.jsx` | 无 |
| Skills 扫描加载 | 新增 `src/skills/` 目录 | 无 |

**验收**：命令面板显示所有命令；skills 加载后可被 Agent 使用。

### Batch 5：Route C 前端完善（P1，预估 2-3 天）

| 任务 | 文件范围 | 依赖 |
|------|---------|------|
| agent.delta 流式展示 | `apps/web/src/main.jsx` | Batch 1 |
| 思考状态动画 | `apps/web/src/main.jsx` | Batch 1 |
| 手动重试 + 暂停/恢复 ASR | `apps/web/src/main.jsx` + `src/liveCallAudio.js` | 无 |

**验收**：通话中 Agent 回答逐字流式展示；可暂停/恢复 ASR。

---

## 6. 与参考实现的差异决策

| 差异点 | Claude Code 做法 | VibeLink 做法 | 理由 |
|-------|----------------|-------------|------|
| 终端 | TUI (ink React) | Web UI (React DOM) | 移动端优先，不依赖终端 |
| 存储 | JSONL 文件 | SQLite | 结构化查询、断线恢复、跨设备 |
| 审批 | 终端内交互 | HTTP/SSE 跨设备 | 移动端必须 |
| 沙箱 | bwrap/macOS native | policy-only + doctor | Windows 优先，等原生后端就绪 |
| 上下文预算 | 进程内 | 事件内 summary | 兼容多条路线、断线恢复 |
| Skills | 文件系统 + bundled | 文件系统 + bundled + Slash | 复用已有 slash 生态 |

---

## 7. 附录：参考文档映射

| Claude Code 分析文档 | 对应 VibeLink 侧重点 |
|---------------------|-------------------|
| `04b-tool-call-implementation.md` | tool 注册表 + 执行管线 |
| `04c-skills-implementation.md` | Skills 发现 + 加载 |
| `04d-mcp-implementation.md` | MCP 管理（已有） |
| `04e-sandbox-implementation.md` | 策略型沙箱 + doctor |
| `04f-context-management.md` | 上下文预算 + 自动压缩 |
| `04g-prompt-management.md` | Prompt 模板管理（暂不优先） |
| `04h-multi-agent.md` | 多 Agent（暂不优先） |
| `04i-session-storage-resume.md` | 统一 session event log + 恢复 |
