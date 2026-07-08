# VibeLink Agent 架构与改造方案

最后更新：2026-07-08

本文替代旧的“路线式”CLI 运行时文档。新的产品边界是：

- **Codex Desktop Remote**：遥控已有 Codex Desktop，使用 Desktop 当前模型和权限设置。
- **VibeLink Agent**：VibeLink 自己的原生 Agent 执行模式，可接入 GPT、Claude、豆包、GLM 等 provider。
- **Live Call Assistant**：上层输入场景，问题进入 Agent 后交给 VibeLink Agent 执行。

## 1. 核心决策

### 1.1 命名

产品侧统一使用 **VibeLink Agent**。技术侧在需要强调实现时使用 **VibeLink Agent Runtime**。

不再把它称为某条路线或单纯的 CLI Runtime，因为这会把能力误解为“继续某个第三方 CLI”。实际目标是 VibeLink 自己拥有：

- provider 选择权
- 模型参数解释权
- 工具生命周期
- 权限与审批
- 事件归属
- 断线恢复与审计

第三方 CLI 或 API 只是 provider adapter。

### 1.2 与 Codex Desktop Remote 的边界

| 维度 | Codex Desktop Remote | VibeLink Agent |
| --- | --- | --- |
| 模型选择 | Codex Desktop 当前设置 | VibeLink 选择 GPT / Claude / 豆包 / GLM 等 provider |
| 权限策略 | Codex Desktop 当前设置 | VibeLink runtime 统一管理 |
| 工具事件 | 只能读可见状态和历史近似 | `tool_runs` / `tool_events` 权威归属 |
| 审批 | 不接管 Desktop 内部审批 | VibeLink 持久审批队列 |
| 恢复 | 依赖 Desktop 可见状态和 JSONL | SQLite cursor / SSE / REST catch-up |
| 同步策略 | 手动 + 半自动：刷新、进入会话、发送/聚焦时按需采样 | 任务运行中持续事件流和 catch-up |
| 适用场景 | 人机接管、观察、远程输入 | 自动化任务、可控执行、多 provider |

### 1.3 与 Live Call Assistant 的边界

Live Call Assistant 只负责音频输入链路：

```text
audio -> ASR -> question detection -> VibeLink Agent task
```

它不拥有 Agent runtime。所有模型选择、工具调用、审批和结果归档都应落到 VibeLink Agent。

## 2. 当前实现状态

### 2.1 已经落地

| 能力 | 当前实现 |
| --- | --- |
| 任务事件 | `task_events` + SSE cursor |
| 工具生命周期 | `tool_runs` / `tool_events` |
| 持久审批 | `approval_requests` / `approval_decisions` |
| Workspace 命令 | shell/test/git/file action 接入 tool runtime |
| MCP 管理 | `mcp.status` / `mcp.probe` / `mcp.call` |
| Browser fetch | `browser.fetch` runtime tool |
| Desktop probes | Codex app-server probe / desktop draft probe 接入 tool runtime；Codex Desktop Remote 默认按需采样，不常驻监听 |
| Provider adapter | Codex CLI、Claude CLI、豆包 Web CLI、Zhipu/GLM adapter |
| Doctor | `/api/doctor` 聚合 runtime、凭据、CLI、workspace、desktop、sandbox |
| Live Call -> Agent | `liveCallAgent.js` 创建 VibeLink Agent task 并回写 delta |

### 2.2 已修正的实际落地问题

| 问题 | 调整 |
| --- | --- |
| 前端可选 `zhipu`，后端 schema 不接受 | `TaskInputSchema` 增加 `zhipu` |
| `agents.js` 未识别 `zhipu`，会 fallback 到 Claude | 新增 Zhipu/GLM provider adapter |
| `toolRegistry` 只声明 `codex/claude/doubao` | `agent.task` schema 增加 `zhipu` |
| `/api/doctor` 未把 Zhipu key 计入 model provider | `model-key` 检查包含 `hasZhipuKey` |
| thread fork 只保留 `claude` 否则归为 `codex` | provider 保留 `codex/claude/doubao/zhipu` |

### 2.3 仍不合理的落地点

| 区域 | 问题 | 建议 |
| --- | --- | --- |
| Provider 分发 | `agents.js` 仍有硬编码分支 | 抽出 `providerRegistry.js` |
| 模型列表 | 前端写死模型候选 | 由 provider registry 输出 model catalog |
| Provider 可用性 | 前端用 key/command 判断，后端另有 doctor 判断 | 统一为 `/api/provider-registry` |
| Zhipu adapter | 当前是最小 JSON adapter | 增加 streaming、错误码、重试、模型 catalog |
| Claude/Codex adapter | 参数映射散在 `agents.js` | 各 provider 拆成独立 adapter 模块 |
| Live Call 文案 | 旧注释容易把它误解为独立 runtime | 改为 Live Call -> VibeLink Agent |
| Desktop Remote 同步 | 旧实现会常驻 SSE/轮询 Desktop UI | 改为手动刷新 + 进入会话半自动同步，平时不监听 Codex Desktop |

## 3. 目标架构

```text
Web / Mobile
  -> /api/tasks
  -> VibeLink Agent Runtime
      -> Provider Registry
          -> codex adapter
          -> claude adapter
          -> doubao adapter
          -> zhipu/glm adapter
      -> Tool Runtime
          -> shell / file / git / browser / MCP / approval
      -> Session Event Log
          -> task_events / tool_events / approval_events
      -> Workspace Context
          -> allowed roots / cwd / git diff / attached files
```

### 3.1 Provider Registry

新增 `src/providerRegistry.js`，统一描述：

```js
{
  id: "zhipu",
  label: "智谱 GLM",
  kind: "api",
  available(settings),
  models(settings),
  defaultModel(settings),
  buildLaunchPlan(payload, settings),
  env(settings)
}
```

第一阶段先保持 JS 简单对象，不急着大改为 class。目标是减少硬编码漂移，而不是引入复杂框架。

### 3.2 Provider Adapter

每个 provider adapter 负责：

- 接收 VibeLink 标准 payload：`prompt`、`model`、`reasoningEffort`、`cwd`、`sessionId`、`mode`
- 输出 launch plan：`{ command, args, env }`
- 把 provider 输出转成 VibeLink 标准事件：assistant text、tool call、tool result、error

当前最小状态：

- Codex CLI：继续使用 `codex exec --json`
- Claude CLI：继续使用 `--print --output-format stream-json`
- Doubao：使用 standalone bridge CLI，必要时 fallback 到 CDP 原型
- Zhipu/GLM：使用 `src/zhipuCli.mjs` 走 OpenAI-compatible chat completions 形态

### 3.3 模型选择规则

- Codex Desktop Remote：不显示可编辑模型，只显示“当前 Desktop 设置”。
- VibeLink Agent：模型来自 provider registry。
- Doubao Web：默认使用网页当前模型，VibeLink 不强行选择。
- GLM：默认 `glm-5.2`，可选 `glm-5.1` / `glm-5.0` / `glm-4.7` / `glm-4.6`。

## 4. 改造计划

### Phase 1：命名与文档收敛（本次）

- README 改为“两个执行模式 + 一个输入场景”。
- 删除旧的路线式 CLI Runtime 文档。
- 新增本文作为 VibeLink Agent 架构与改造方案。
- 修正 feature gap、Android handoff、代码注释里的执行模式口径。

### Phase 2：Provider Registry

- 新增 `src/providerRegistry.js`。
- `agents.js` 改为通过 registry resolve launch plan。
- `/api/provider-registry` 输出 provider 可用性、模型列表、默认模型、能力标记。
- 前端 Composer 使用该 API 渲染 provider 和模型选择器。
- doctor 从 registry 生成 provider readiness 检查。

### Phase 3：统一事件与恢复

- 扩展 `task_events`：`event_kind`、`turn_id`、`block_id`、`parent_event_cursor`。
- 将 `tool_events`、`live_call_events` 提供统一 session replay 视图。
- 恢复时校准 incomplete tool run、orphaned approval 和缺失 final result。

### Phase 4：上下文预算与压缩

- `contextBudget.js` 继续用于 token 估算。
- `compactService.js` 插入 summary event。
- resume 时优先注入 summary、workspace diff、open files、pending approvals。

### Phase 5：Workspace/Git/Terminal 产品化

- xterm/ANSI 终端视图。
- per-hunk stage/unstage、branch/stash/worktree、冲突向导。
- 测试视图接 Jest/Pytest/Vitest parser。

## 5. Definition of Done

VibeLink Agent 达到产品化的最低标准：

- 用户能明确看到当前是 Codex Desktop Remote 还是 VibeLink Agent。
- Codex Desktop Remote 只在刷新、进入绑定会话、发送/聚焦等动作时同步，不在后台持续监听 Desktop UI。
- VibeLink Agent provider 可选择，模型列表和可用性来自同一个 registry。
- 每次工具调用都有 `tool_run_id`、生命周期、审批状态和结果事件。
- 服务重启、浏览器刷新、手机断线后能 replay 任务、工具卡和审批状态。
- Desktop Remote 的模型/权限设置不再与 VibeLink Agent 混淆。
- Live Call 触发的回答全部归档为 VibeLink Agent task。
