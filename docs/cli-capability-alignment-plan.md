# CLI 能力对齐计划

最后更新时间：2026-07-04

本文用于规划 VibeLink 需要向成熟 CLI agent 运行时对齐的能力。`reference/cli-analysis/src` 只作为架构研究材料：可以学习模块边界、状态机和产品能力分层，不能复制、内嵌、改名搬运其中源码、提示词或私有协议。

## 对齐边界

- 目标不是把参考 CLI 并入项目，而是把 VibeLink 补成自己的本地优先 agent 运行时。
- 优先补“运行时能力”，再补“界面表现”。例如先有持久 tool event 和审批队列，再让前端渲染更丰富的 tool card。
- Desktop remote 仍是 UI 遥控路线，只能作为补充通道；需要确定性参数、权限、沙箱、审批、事件归属时，应优先走 VibeLink 自己的 CLI runtime。
- 所有新能力都要落到 SQLite cursor / SSE / REST catch-up / audit log 这条已有基础设施上。

## 已学习到的参考实现模式

1. 会话不是纯文本日志，而是 append-only 的消息与元数据事件流。恢复时根据 parent/turn/tool 关系重建图，并修复不完整的 tool result、进度块、标题和上下文元数据。
2. tool runtime 是核心边界。每个工具都有 schema、权限判断、调用上下文、进度事件、结果事件、UI 渲染数据和审计信息。
3. 权限不是一个全局开关。命令、文件、网络、MCP、子 agent 都要经过 allow / ask / deny；显式 deny 和 ask 必须比“沙箱可执行”优先。
4. 沙箱是权限系统的一个执行后端，不是免审批理由。运行前要把 workspace、只读路径、可写路径、网络 allowlist、系统限制翻译为 runtime config，并提供 doctor/降级原因。
5. 上下文管理要有预算器。需要预留 summary token、压缩阈值、压缩后状态再注入、工具输出裁剪和失败兜底。
6. 多 agent 不是简单并发调用，而是主 agent、子 agent、任务列表、消息通道、权限桥接和恢复机制的组合。

## 能力对齐矩阵

| 能力 | 参考模式 | VibeLink 当前情况 | 目标形态 | 优先级 |
| --- | --- | --- | --- | --- |
| 统一 tool runtime | 工具注册表 + schema + permission + progress/result render data | 目前有 task event、workspace API、命令摘要和通用 tool card，但工具事件来源仍分散 | 新增本项目自己的 `tool_runs` / `tool_events` 模型，所有 shell、file、git、browser、approval、plugin 调用都走同一生命周期 | P0 |
| 持久化逐条审批 | tool call 运行前创建审批请求，用户同意后继续原调用 | workspace 命令已有 428 风险确认，Agent tool call 还不能暂停恢复 | SQLite `approval_requests`，SSE/Push 通知，手机 approve/deny，审批后原 tool run 继续或失败关闭 | P0 |
| 命令执行与 PTY | Shell 工具输出进度事件，权限、沙箱、清理逻辑都在执行链路内 | 内置终端是非交互命令运行器，能显示 stdout/stderr/exit code | PTY 会话、ANSI 渲染、stdin、stop、timeout、长期任务、命令级审批和 task event 统一归档 | P0 |
| 沙箱与 trusted workspace | 权限上下文翻译为 FS/network runtime config，并有 doctor | 有 trusted workspace、permissionMode、approval policy、networkAccess、风险规则 | 明确 Windows 可用边界：先实现策略型沙箱和 doctor；后续按平台接入 WSL/bwrap/mac sandbox 等后端 | P0 |
| 会话事件与恢复 | append-only transcript，metadata tail，sidechain，恢复时修复 tool/result 关系 | 有 SQLite `task_events`、Codex/Claude 历史扫描、Desktop observation cursor | 增加 VibeLink 原生 session event log：turn、block、tool_run、metadata、artifact、approval 分层；恢复时校准 task 状态 | P0 |
| 上下文预算与压缩 | 预算器、自动 compact、summary、状态再注入 | 目前主要依赖 CLI 自身上下文能力和历史读取 | 本地 token 预算估算、长任务自动 summary、保留 open files / plan / workspace diff / approvals / invoked tools | P1 |
| Tool card 数据源 | UI 从结构化 tool event 渲染 | 已有命令摘要、diff/change card、通用 tool card，但部分仍从文本推断 | 前端只消费 `tool_events` payload；Desktop 文本推断作为低置信度来源并标注 | P1 |
| Workspace/Git 工作流 | Git、文件编辑、diff、worktree、PR 等作为工具族 | 已有文件树、文件定位、diff viewer、stage/commit/push/pull/PR create | per-hunk stage、branch/stash/worktree、冲突向导、PR review、文件编辑事件与审批接入 | P1 |
| 测试结果与日志 | Bash/测试输出可折叠、失败定位、进度事件 | 有粗解析和日志折叠 | Jest/Pytest/Vitest 等解析器、失败跳转、单测重跑、测试历史趋势 | P1 |
| CLI 命令面板 / slash commands | 命令注册表集中描述参数、权限和 UI | 已有部分 slash commands | 新增 command registry，前端命令面板、参数表单、权限预览、最近命令 | P1 |
| MCP / Plugin / Skill 管理 | MCP 工具进入 tool pool，插件有安装、信任、配置和健康检查 | 当前缺 UI 和 runtime 管理 | 只基于公开协议实现 MCP server 列表、连接状态、授权、工具清单、插件信任提示 | P2 |
| 多 agent / 子任务 | AgentTool、后台任务、mailbox、task list、权限桥接 | 当前缺子 agent 工作流 | 先做单机后台子任务和任务列表，再做 worker mailbox、权限代理、并发/取消/恢复 | P2 |
| Memory / 项目知识 | 项目记忆、团队记忆、上下文检索 | 当前主要靠 workspace 和历史 | 本地 memory 文件索引、用户可见编辑、注入记录和清理策略 | P2 |
| Doctor / 诊断 | sandbox、权限、MCP、插件、终端能力都有健康检查 | 有 Desktop probe、安全/公网设置，但不统一 | `/api/doctor` 聚合 Node、CLI、PTY、Git、gh、凭据库、Cloudflare、Desktop remote、sandbox 状态 | P1 |

## 落地批次

### Phase 0：运行时骨架

目标：先让所有后续能力有统一承载层。

- 已落地：新增 `tool_runs`、`tool_events`、`approval_requests`、`approval_decisions` 表。
- 已落地：新增 `src/toolRuntime.js`，覆盖 workspace command 的 tool run 创建、审批请求、审批通过/拒绝、tool event 和执行收尾。
- 已落地：workspace shell/test 命令接入持久审批；危险命令返回 `approvalId` / `toolRunId`，审批后继续执行原 tool run。
- 已落地：Agent task 创建的危险策略审批接入 `agent.task` tool run；审批通过后创建原任务，并回填 task/tool event 归属。
- 已落地：审批决策接口支持“已 approved 但原 tool run 仍未完成”的重试继续；服务重启或重复点击后不会只停在 already-decided 状态。
- 已落地：审批过期会同步为 `approval.expired` tool event，并把未完成 tool run 标记为 `expired`，前端 SSE/tool card 可恢复显示。
- 已落地：workspace Git action 与 Git file action 接入 `tool_runs` / `tool_events`，成功和失败都会形成结构化工具事件。
- 已落地：新增 `/api/approvals`、`/api/approvals/:id/decision`、`/api/tool-runs`、`/api/tool-events`，tool events 支持 cursor 查询和 SSE。
- 已落地：新增 `src/toolRegistry.js` 与 `/api/tool-registry`，集中描述内建工具/观察到的上游工具的 kind、权限域、风险、schema 和 UI 标签；tool created 事件会携带 registry 元数据。
- 已落地：Settings 安全面板显示 pending approvals，支持跨设备 approve/deny。
- 已落地：主消息区会按当前 task/workspace catch-up 并订阅 `tool_events`，聚合为结构化 tool card 渲染。
- 已落地：Agent/CLI stream-json 中的 `function_call`、`custom_tool_call`、`tool_call`、`tool_use/tool_result`、`patch_apply_end`、`mcp_tool_call_end` 会映射为统一 `tool_runs` / `tool_events`；浏览器、文件、shell、Git、审批、插件/MCP 会按名称归类为 tool card 数据源。
- 已落地：读取本地 Codex/Claude 历史 JSONL 时，会用确定性 `history:<provider>:<sessionId>` 归属回填历史 tool events；重复读取幂等，不会重复生成 tool card。
- 已落地：`tool_events` 支持 task/workspace/toolRun 过滤、SSE catch-up、stats 查询和受控 prune；默认保留最近事件，清理操作写入审计。
- 已落地：`tool_events` 新增统一 `lifecycle` 与 `sourceConfidence` 字段，前端/重放/诊断可直接读取生命周期阶段，而不是只从事件类型文本推断。
- 已落地：新增 tool event retention 配置与自动 prune 调度，Settings 可配置保留天数、最新保留数量、自动清理周期，并支持 stats、dry-run preview、手动 prune；手动/自动清理均写入审计。
- 已落地：新增 `system.doctor` runtime 工具与 `/api/doctor`，聚合 Node、SQLite、凭据库、模型 key、Git/gh、Codex/Claude 命令、Desktop remote、Host allowlist、trusted workspace、workspace 数量和 tool event 存储状态；结果区分 hard failures 与 warnings，并写入 `tool_runs` / `tool_events`。
- 已落地：Codex app-server probe 与 Desktop draft probe 迁移到统一 runtime，分别登记为 `system.codex_app_server_probe` 和 `desktop.draft_probe`，返回 `toolRunId`，并写入审计与结构化 tool events。
- 已落地：新增 VibeLink 自有 MCP 管理 runtime：`mcp.status` / `mcp.probe` 进入 `tool_runs` / `tool_events`，Settings 可配置 MCP servers，后端可按 MCP `initialize` -> `tools/list` 探测 stdio/http server，并按 `mcp__server__tool` 规范化工具名；探测结果、失败原因、tool list、审计与 doctor 摘要都进入统一模型。
- 已落地：新增最小 VibeLink 自有浏览器 runtime：`browser.fetch` 支持 HTTP/HTTPS 页面抓取、标题/描述/文本摘要提取、大小/超时限制、网络权限审批、审计、`tool.output` 进度和 `tool_events` 重放；Settings 提供手动抓取入口。
- 待补：完整内置浏览器操作仍需继续扩展，包括页面会话、点击/输入、截图、下载、cookie/登录态隔离和更细的域名 allow/deny 策略。
- 验收：服务重启后，待审批命令仍存在；审批后能继续；拒绝后 tool run 进入 rejected 并写审计。

### Phase 1：PTY 与沙箱策略

目标：把“内置终端”从一次性命令升级为可恢复观测的命令运行时。

- 已落地：workspace shell/test 命令的非 PTY fallback 已从一次性 stdout/stderr 结果升级为 `spawn` 流式执行；运行中 stdout/stderr chunk 会写入 `tool.output`，携带 stream、bytes、elapsedMs、command、cwd，并通过 `tool_events` cursor/SSE/catch-up 进入 tool card。
- 已落地：workspace shell/test 支持后台运行和 tool-run 级停止；前端拿到 `toolRunId` 后可调用 `/api/tool-runs/:id/stop`，运行时写入 `tool.cancel_requested` / `tool.cancelled`，并保留 stdout/stderr 与审计。
- 已落地：新增单个 tool run 详情读取 `/api/tool-runs/:id`，返回 tool run 与事件列表；Workspace 终端/测试面板会按 `toolRunId` 轮询兜底并从 `tool.output`/终态事件回填 completed/failed/cancelled 结果，避免后台命令完成后 UI 停在 running。
- 已落地：workspace shell/test 的命令审批已接入 `security.networkAccess`；当网络权限关闭且命令命中 curl/wget/iwr、包管理器安装、Git remote、ssh/scp、网络探测、容器 registry 等网络模式时，会创建持久审批请求并阻止直接执行。
- 已落地：workspace shell/test 的审批也接入 `security.requireTrustedWorkspace`；当目标 workspace 不在 trustedWorkspaces 内时，会创建持久审批请求并阻止直接执行，审批 payload 带 cwd、risk、policy 信息。
- 已落地：workspace shell/test 新增策略型 sandbox 权限分类，把命令归类为 `read-only`、`workspace-write`、`network`、`destructive`、`privileged`；`read-only` 模式下写 workspace、非 `danger-full-access` 下特权命令、`workspace-write` 下破坏性命令、`networkAccess=false` 下网络命令都会进入持久审批。普通请求体不能再用 `approved:true` 绕过审批，必须走 approval decision 恢复。
- 已落地：沙箱 doctor 返回 policy-only 后端状态、当前模式、allow roots、network 策略、approval policy、trusted workspace 要求和不可用原生后端原因；当前不宣称 Windows 原生进程隔离已完成。
- 已落地：终端 runtime doctor 返回 PTY capability 与降级边界；当前检测 `node-pty` 是否可用，未安装时明确使用非交互 `spawn` fallback，并报告 stdin、ANSI、resize、stop、cursor replay 能力。
- 已落地：workspace shell/test 在当前 task 上下文触发时，会把 command start/stdout/stderr/completion 同步写入 `task_events`；同一份输出仍写入 `tool_events`，因此 task SSE、tool card 和断线 catch-up 能看到一致的命令进度。
- 已落地：新增可选 workspace terminal session runtime 与 API：`/api/workspaces/:id/terminal-session` 会创建 `workspace.terminal_session` tool run，审批通过后优先使用 `node-pty`，不可用时按 `auto` 模式降级到 pipe-based `spawn` session；支持 stdin、stop、tool event 输出、task stream 镜像、session list/status，PTY 模式额外支持 resize/ANSI。
- 待补：前端接入完整 xterm/ANSI 终端视图，并把 `node-pty` 作为可安装/可诊断的可选原生依赖打包。
- 待补：按平台接入更强沙箱后端，例如 WSL/bwrap/mac sandbox/Windows job object 或容器隔离，并在 doctor 中区分 policy-only 与 native-enforced。
- 验收：长任务可实时输出、停止、断线 catch-up；危险命令必须审批；网络命令在关闭网络权限时被阻止或请求升级。

### Phase 2：会话恢复与上下文预算

目标：VibeLink 自己能稳定恢复任务上下文，而不是只依赖上游 CLI 历史。

- 建立 VibeLink 原生 session event log，区分 transcript、progress、metadata、tool、artifact。
- task 恢复时重建 turn/block/tool_run 关系，标记 incomplete/orphaned 事件。
- 增加 token budget 估算和自动 summary 事件。
- summary 后再注入 workspace open files、active plan、pending approvals、recent changes。
- 验收：刷新、断线、服务重启后，前端能重放一致的消息、工具卡、审批状态和 artifacts。

### Phase 3：Workspace/Git/测试工作流

目标：把代码工作流从“能操作”补到“适合长时间开发”。

- diff viewer 支持 per-hunk stage/unstage、discard、复制、定位。
- Git 增加 branch、stash、worktree、冲突状态、PR review。
- 文件树增加搜索、创建、重命名、删除、内联编辑。
- 测试视图增加框架解析器、失败定位、单测重跑、历史记录。
- 验收：一次普通修复任务可以在手机端完成查看 diff、跑测试、提交、推送、建 PR 的闭环。

### Phase 4：CLI 生态能力

目标：补命令面板、MCP/plugin/skill、doctor，让能力发现和配置可产品化。

- command registry 统一 slash commands、设置项、权限预览。
- MCP 管理：server 配置、连接状态、auth 状态、tools 列表、健康检查。
- 插件/skill 只做公开协议和本项目自有 manifest，不复用参考实现。
- `/api/doctor` 聚合所有本地依赖和远程访问状态。
- 验收：用户能从 UI 发现能力、配置依赖、看到失败原因和修复建议。

### Phase 5：多 agent

目标：在前面运行时稳定后，再做并发子任务。

- 后台子任务先复用 `tasks` / `tool_runs` / `approval_requests`。
- 增加共享 task list：claim、update、complete、cancel。
- 增加 mailbox：主任务与子任务互发消息，消息同样写事件流。
- 权限桥接：子任务申请危险操作时，主任务和手机端都可审批。
- 验收：主任务能派发多个子任务、查看进度、停止错误子任务、汇总结果，且审批和审计可追踪。

## 下一步建议

1. 优先把 VibeLink 自己发起的浏览器操作、插件/MCP 管理调用迁移到 `toolRuntime`，补齐 Phase 0 剩余 runtime 来源。
2. 然后再接 PTY；否则 PTY 输出会缺少持久事件和审批恢复承载层。
3. PTY 落地后继续补 sandbox doctor 的平台后端状态、网络策略和不可用降级原因。
