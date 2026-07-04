# VibeLink 与 Codex 功能差异表

最后更新：2026-07-04

本文档只记录 VibeLink 相对 Codex Desktop / Codex App 仍存在的差异、边界和后续增强项；已对齐的能力不再保留在本表。

状态约定：

- `missing`：当前未实现。
- `partial`：已有雏形，但体验或能力仍明显弱于 Codex。
- `blocked`：受上游能力、系统权限或产品边界影响，不能用同样方式实现。
- `planned`：已确认要做，但尚未实现。

## 当前结论

仍有差异或边界的关键点：

- `partial`：workspace + Git/change card 已有 API 和基础 UI，但还不是 Codex 的完整“变更”体验。

仍未抹平的最高优先级：

- `P0`：不能真正接管已经在 Codex Desktop / 终端中运行的进程，只能通过 Desktop UI 遥控或 CLI/app-server 新开/续跑。
- `P0`：历史上下文仍不是完整 Codex App 状态，只是比以前更接近 Codex 的 turn/block 还原。
- `P0`：Desktop UI 遥控仍依赖 Windows UIA 和前台窗口，稳定性无法等同原生 Codex。
- `P0`：任务运行中重启恢复仍不能重新绑定已经存在的 OS 子进程。
- `P0`：公网安全仍是本机 bridge 原型级别，没有完整账号、审计、限流、设备策略和域名证书流程。

## 非 T0/P0 差异说明

- 用户消息没有额外 `text` 拼接 / 非增量元数据，不再作为 T0/P0 差异记录；除非后续影响上下文恢复或交互一致性。

## 会话与任务

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| blocked | 真正接管电脑上已经在 Codex App / 终端里运行的进程 | 不能夺取已有进程的 stdin/stdout/PTY。当前可选路线是：读取 JSONL 历史后用 CLI resume；或通过 Codex Desktop UI 遥控新输入。 | P0 |
| blocked | Codex Desktop 原生回显 | 已验证网页端继续同一 thread 后，Codex Desktop App 不会自动把网页端消息回显到原生 UI。只能做到共享 thread 历史或 UI 遥控输入。 | P0 |
| planned | Codex app-server 客户端代理接入 | 已做 spike，app-server 可作为未来路线，但当前主线仍是 CLI resume + Desktop remote；尚未产品化接入。 | P0 |
| partial | Codex Desktop UI 遥控 | 已有 Windows UIA 探测、窗口恢复、侧栏匹配、focus、发送队列；仍依赖前台 UI、控件定位和 Codex UI 稳定性。 | P0 |
| partial | Codex thread 管理 | 已支持重命名、置顶、归档/恢复、分组、fork；但管理 UI 仍是 prompt 弹窗，不是 Codex 风格的菜单/批量/跨设备体验。 | P1 |
| partial | 历史上下文还原 | Codex 历史已按 `turn_id` 聚合，含耗时和命令摘要；但仍不是完整 Codex App 会话状态，例如计划面板、插件状态、完整 tool card、审批状态还未还原。 | P0 |
| partial | 搜索 | 目前按标题、provider、cwd、sessionId 过滤；缺少全文搜索、标签、收藏、复杂过滤。 | P2 |
| missing | 任务队列和并发管理 | 没有优先级、并发上限、失败重试策略、批量取消和后台调度面板。 | P1 |
| partial | 运行中状态恢复 | 本服务启动的任务有 SQLite task event 和 SSE/轮询；服务重启后能看历史事件，但不能重新绑定仍在跑的 OS 子进程。 | P0 |

## 输入区

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | 文件/文件夹选择器 | 已支持手机本地文件上传、文件夹上传，以及 workspace 文件树选择并注入上下文；仍不是 Codex Desktop 原生文件选择器。 | P0 |
| partial | 附件能力 | 已支持图片、普通文件、文件夹上传、文本预览和本地路径注入；PDF/Office/表格目前作为文件路径交给 agent，尚无富预览。 | P0 |
| partial | 模型选择 | Composer 已有模型和推理强度选择器，Codex CLI 透传 `-m` 和 `model_reasoning_effort`，Claude 透传 `--model` 和 `--effort`；仍缺动态模型 catalog 和 Desktop remote 原生同步。 | P1 |
| partial | slash commands | 已支持 `/image`、`/file`、`/folder`、`/workspace`、`/permissions`、`/model`、`/effort`、`/agent`、`/history`、`/clear`；尚未覆盖 `/plugins`、`/apps`、`/hooks` 等完整 Codex 命令。 | P1 |
| partial | 运行中补充输入 | Desktop remote 可继续排队；CLI running task 现在允许尝试补充输入并返回明确失败原因，但 Codex/Claude exec 模式通常仍不接收 live stdin。 | P0 |

## 输出渲染

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | Markdown 渲染 | 支持文本、链接、图片；缺少代码高亮、表格、引用、任务列表、数学公式等完整 Markdown 能力。 | P1 |
| partial | tool call 卡片 | 已有命令摘要卡；其他工具类型仍未结构化，例如文件编辑、浏览器操作、插件调用、审批。 | P0 |
| partial | diff/change card | 已有 workspace/task Git status/diff 摘要卡；缺少完整 patch 浏览、文件定位、接受/拒绝变更、未跟踪文件预览。 | P0 |
| partial | 图片显示 | 支持本地图片代理和附件图片展示；缺少放大、下载、错误占位、图库。 | P1 |
| missing | artifact 视图 | 没有文档、表格、PPT、PDF 等专门预览。 | P2 |
| missing | 消息操作 | 没有复制、编辑、重新生成、折叠、删除、定位等操作。 | P2 |

## 权限与安全

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | 权限模型 | 只有基础 `permissionMode`；没有完整 sandbox、approval policy、命令级审批、网络权限和 trusted workspace UI。 | P0 |
| missing | 逐条审批 | 没有 Codex 风格命令级审批、危险操作确认、权限升降级说明。 | P0 |
| partial | API key 存储 | 勾选记住后仍明文写入 `.agent-mobile-terminal/settings.json`；未接系统凭据库。 | P0 |
| partial | 访问审计 | 有设备列表和 task/desktop event，但没有完整访问日志、IP 记录、限流和异常告警。 | P1 |

## Workspace / Git / 代码工作流

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | change card | 前端已有基础变更卡，能显示 workspace/task 变更摘要；缺少完整 diff viewer 和操作按钮。 | P1 |
| missing | 文件树 | 没有 workspace 文件树和文件打开能力。 | P1 |
| missing | 文件定位 | 没有点击消息路径跳转到文件和行号。 | P1 |
| missing | 内置终端 | 没有终端视图，只能看 agent 输出和命令摘要。 | P1 |
| missing | Git 完整工作流 | 没有 stage、commit、push、PR、worktree 管理 UI。 | P1 |
| missing | 测试结果视图 | 没有结构化测试结果、日志折叠、失败定位。 | P1 |

## Codex Desktop / UI 监听

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | 运行中检测 | 已扫 Codex 左侧最近会话和当前 composer 状态；仍受 UIA 可见性、Codex UI 改版、窗口状态影响。 | P0 |
| partial | 会话定位 | 可用侧栏标题/项目匹配并 focus；同名会话、折叠列表、滚动不可见时仍可能不准。 | P0 |
| missing | 手机观看 Desktop 实时画面 | 只能同步结构化状态和可见 transcript 摘要，不能像远程桌面一样观看/操控完整 Codex 窗口。 | P2 |

## Codex 生态能力

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| missing | 插件管理 UI | 没有插件安装、启用、配置、状态展示。 | P2 |
| missing | MCP 管理 | 没有 MCP server 配置、连接器授权、健康检查。 | P2 |
| missing | Hooks 管理 | 没有 hooks 生命周期管理和可视化规则。 | P2 |
| missing | AGENTS/config 可视化 | 不能查看/编辑/解释 `AGENTS.md`、`.codex/config.toml`、requirements。 | P2 |
| missing | 内置插件入口 | 没有 Documents、PDF、Spreadsheets、Presentations、Template Creator、Browser 等入口。 | P2 |
| missing | Subagents | 没有并行子代理工作流。 | P2 |
| missing | Automations | 没有定时提醒、monitor、后续唤醒、thread heartbeat。 | P2 |

## 浏览器能力

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| missing | in-app browser | 没有 Codex 内置浏览器视图和操作流。 | P1 |
| missing | Chrome profile 控制 | 不能使用用户 Chrome 已登录状态进行浏览器任务。 | P2 |
| missing | 浏览器测试轨迹 | 没有截图、DOM 检查、浏览器工具事件展示。 | P1 |
| missing | 手机观看浏览器 | 不能在手机端观看或控制 Codex 正在操作的浏览器页面。 | P2 |

## 移动端与公网

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| missing | 原生移动端 | 当前是网页端，不是 Android/iOS App。 | P1 |
| planned | 通话实时转写/面试辅助 | 已确定第一版自用 MVP 先走 Windows 蓝牙/Phone Link 路线：手机系统电话音频进入 Windows 后，用 WASAPI 数字回环捕获下行音频，外接麦克风作为电话上行，再接实时 ASR 和 Agent；详见 `docs/windows-bluetooth-call-transcription-mvp.md`。 | P1 |
| missing | 推送通知 | 任务完成、失败、需要确认时不会主动推送到手机。 | P0 |
| partial | 断线恢复 | task events 和 desktop observations 有 SQLite cursor；前端离线恢复、ack、重放边界仍不完整。 | P0 |
| partial | 公网访问 | Cloudflare Tunnel 可用，安全警告和 device token 已有；还没有产品化公网域名、证书、设备策略和部署向导。 | P0 |
| missing | 二维码配对 | 没有二维码登录、设备确认页和过期配对流程。 | P0 |

## Claude Code 支持

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | Claude CLI 包装 | 有基础 `--print --output-format stream-json` 支持；测试覆盖和错误处理不如 Codex 路线。 | P1 |
| partial | Claude 历史解析 | 能扫描 `.claude/projects` JSONL 文本；未完整映射 Claude 的工具事件、权限、session 状态。 | P1 |
| partial | 双 provider 抽象 | Codex/Claude 混合列表可用，但内部模型仍偏 Codex 优先。 | P1 |

## UI / 体验

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | 动效 | 有基础消息动画、思考状态、平滑滚动；整体还不如 Codex 细腻。 | P1 |
| partial | Codex 风格布局 | 侧栏、composer、turn block 已接近 Codex；设置页、管理菜单、变更视图仍偏原型。 | P1 |
| partial | 设置页 | 设置页可用，但缺少配置中心层级、解释、风险提示和导入导出。 | P1 |
| missing | 暗色模式 | 不支持暗色模式。 | P2 |
| missing | 命令面板/快捷键 | 没有快捷键、命令面板、键盘导航体验。 | P2 |
| partial | 移动适配 | 基础响应式可用，但长时间手机操作体验仍未打磨。 | P1 |

## 架构

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | 事件可靠性 | task events 和 desktop observations 有 cursor；还缺 ack、保留策略、压缩、重放边界测试。 | P0 |
| partial | 进程生命周期 | 服务可恢复历史和事件，但不能重新绑定重启前仍在跑的子进程。 | P0 |
| partial | 多设备同步 | 多设备可凭 device token 登录；没有冲突处理、在线状态、设备间消息同步策略。 | P1 |
| partial | 平台定位 | 当前仍是本机 bridge + 手机网页，不是完整公网安全远程 agent 平台。 | P0 |

## 建议下一批优先级

1. `P0`：把 Desktop remote 的 UIA 定位继续加固：发送按钮命中、会话定位、同名会话、窗口最小化/遮挡状态。
2. `P0`：补全公网安全：二维码配对、设备确认、限流、访问日志、token 轮换、Cloudflare 固定域名配置。
3. `P0`：补文件/文件夹选择器和普通附件上下文注入。
4. `P0`：把 change card 升级为完整 diff viewer，支持未跟踪文件预览和文件定位。
5. `P1`：把 thread 管理从 prompt 弹窗升级为 Codex 风格菜单。
6. `P1`：增加 workspace 文件树、文件预览、点击路径定位。
7. `P1`：补原生移动端路线：先 PWA 打磨，再评估 React Native / Expo。
