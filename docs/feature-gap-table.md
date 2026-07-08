# VibeLink 与 Codex 功能差异表

最后更新：2026-07-06

本文只记录 VibeLink 相对 Codex Desktop / Codex App 仍存在的差异、边界和后续增强项。已经补齐到“可用且差异很小”的能力不再作为缺口保留；如果仍保留在表中，说明还存在产品体验、稳定性或上游能力边界。

状态约定：

- `missing`：当前未实现。
- `partial`：已有雏形或主体能力，但体验、稳定性或覆盖面仍弱于 Codex。
- `blocked`：受上游能力、系统权限或产品边界影响，不能用同样方式实现。
- `planned`：已确认要做，但尚未产品化实现。

## 本轮校准

已经从“缺失”或高风险口径中下调的能力：

- Codex Desktop Remote 已有严格 preflight、最小化后恢复并重新校验、postflight 验证、SQLite 持久队列、draft/send probe 和 target fail-closed。
- 公网访问已具备 QR pairing session、已登录设备 approve/deny、device token hash、revoke/rotate/expiry、Host allowlist、审计日志、限流和 Cloudflare 向导；公网 Host 下 legacy `/api/login` 默认不能绕过设备确认。
- Node 运行时约束已提升到 `node >=22.5.0`，匹配 `node:sqlite` / `DatabaseSync`。
- Task SSE 已支持 cursor、`Last-Event-ID` / `after`、REST catch-up 和错误后 polling fallback，不再在 `onopen` 后立即并行轮询。
- Markdown 渲染、图片查看、消息操作、Workspace 文件树、链接路径定位、基础终端、Git 操作和测试输出视图已经有可用实现，但仍保留部分差异项。

当前最需要继续追的高优先级差异：

- `P0`：不能真正接管电脑上已经在 Codex App / 终端里运行的进程，只能读取历史、CLI resume、新开任务或 Desktop UI 遥控。
- `P0`：Codex Desktop Remote 输出仍只能做到“实时近似 + 完成后校准”，无法凭空获得 Codex Desktop 未暴露的完整 tool 输出、退出码和内部归属。
- `P0`：权限与审批仍不是 Codex 原生等价，缺少逐条命令级审批、危险操作解释和细粒度网络/沙箱 UI。
- `P0`：Desktop UI 遥控仍依赖 Windows UIA、前台窗口、控件文案和 Electron UI 稳定性，不能等同原生协议。

## 非 T0/P0 差异说明

- 用户消息没有额外 `text` 拼接 / 非增量元数据，不再作为 T0/P0 差异记录；除非后续影响上下文恢复或交互一致性。
- Codex Desktop Remote 的模型、权限、推理强度默认是“使用当前 Codex Desktop 设置”；需要确定性参数时走 VibeLink Agent。

## 会话与任务

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| blocked | 真正接管电脑上已经在 Codex App / 终端里运行的进程 | 不能夺取已有进程的 stdin/stdout/PTY。当前可选模式是读取 JSONL 历史后由 VibeLink Agent resume，或通过 Codex Desktop UI 遥控继续输入。 | P0 |
| blocked | Codex Desktop 原生回显 | 已验证网页端继续同一 thread 后，Codex Desktop App 不会自动把网页端消息回显到原生 UI。只能共享 thread 历史、手动/半自动按需同步，或 UI 遥控输入。 | P0 |
| planned | Codex app-server 客户端代理接入 | 已做 probe/spike，app-server 可作为未来增强；当前主线仍是 VibeLink Agent resume + Codex Desktop Remote，尚未产品化接入。 | P0 |
| partial | Codex Desktop UI 遥控 | 已有 Windows UIA 探测、窗口恢复、会话定位、target 校验、草稿检测、发送队列、postflight 验证和 SQLite 队列恢复；仍依赖前台 UI、控件定位和 Codex UI 稳定性。 | P0 |
| partial | Codex Desktop Remote 输出同步 | 不做常驻监听；仅在刷新浏览器/Android、点进绑定会话、发送/重试/聚焦等主动动作时采样可见 transcript 和状态。历史可从 JSONL 恢复，仍无法拿到 Codex Desktop 未暴露的完整 tool 输出、退出码和内部 tool 调用归属。 | P0 |
| partial | Codex thread 管理 | 已支持重命名、置顶、归档、恢复、分组、fork；但管理 UI 仍偏原型，不是 Codex 风格的批量/跨设备线程管理。 | P1 |
| partial | 历史上下文还原 | Codex / Claude 历史可扫描并按 turn/block 聚合，含命令摘要、权限模式等信息；仍不是完整 Codex App 状态，例如计划面板、插件状态、完整审批状态不能全量还原。 | P0 |
| partial | 搜索 | 可按标题、provider、cwd、sessionId 过滤；缺少全文搜索、标签、收藏和复杂过滤。 | P2 |
| missing | Agent 任务队列和并发管理 | Codex Desktop Remote 队列已持久化，但 VibeLink Agent 任务还没有优先级、并发上限、失败重试、批量取消和后台调度面板。 | P1 |
| partial | 运行中状态恢复 | 本服务启动的任务有 SQLite task event、JSONL 日志、SSE/catch-up；服务重启后能看历史事件，但不能重新绑定仍在跑的 OS 子进程。 | P0 |

## 输入区

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | 文件/文件夹选择器 | 已支持手机本地文件上传、文件夹上传、workspace 文件树选择并注入上下文；仍不是 Codex Desktop 原生文件选择器。 | P0 |
| partial | 附件能力 | 已支持图片、普通文件、文件夹上传、文本预览和本地路径注入；PDF/Office/表格可作为 artifact 打开或交给 agent，但富预览和内容抽取仍有限。 | P1 |
| partial | 模型选择 | Composer 有模型和推理强度选择器，VibeLink Agent 已接入 Codex、Claude、豆包、GLM provider；仍缺统一 provider registry 和动态模型 catalog。Codex Desktop Remote 继续使用 Desktop 当前设置。 | P1 |
| partial | slash commands | 已支持 `/image`、`/file`、`/folder`、`/workspace`、`/permissions`、`/model`、`/effort`、`/agent`、`/history`、`/clear`；尚未覆盖 `/plugins`、`/apps`、`/hooks` 等完整 Codex 命令。 | P1 |
| partial | 运行中补充输入 | Codex Desktop Remote 可继续排队；VibeLink Agent running task 可尝试写入输入并返回明确失败原因，但部分 provider exec 模式通常仍不接收 live stdin。 | P0 |

## 输出渲染

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | Markdown 渲染 | 已接入 `react-markdown`、GFM、代码高亮、任务列表、表格、引用、数学公式和本地文件链接；仍缺 Mermaid、复杂 HTML/组件化块、Codex 原生级流式块结构和更细的安全策略。 | P1 |
| partial | tool call 卡片 | VibeLink Agent 视图保留命令摘要卡和通用 tool call 卡，可显示文件、浏览器、插件、审批等类型的输入/输出 payload；Codex Desktop Remote 默认改用轻量 transcript 工具行。仍缺 Codex 原生 tool schema、完整生命周期、审批交互和 Desktop 原生内部 tool 输出。 | P0 |
| partial | Codex Desktop Remote transcript 视图 | 已为 Remote 单独渲染连续正文、hover 操作和轻量“已运行”工具行，避免默认展示 VibeLink Agent 审计卡片；仍需继续对齐 Codex 原生 turn 边距、顶部栏密度和更细粒度的命令折叠。 | P0 |
| partial | Codex Desktop Remote 命令摘要 | 可从可见 transcript 和历史推断“已运行 N 条命令”和部分命令文本，并以轻量行插回 transcript；仍没有完整输出、退出码和精确 tool 调用归属。 | P0 |
| partial | diff/change card | 已有 workspace/task Git status/diff 摘要、完整 patch 浏览、未跟踪文本文件伪 diff、复制 patch、文件定位、接受/拒绝文件变更和全部暂存；仍缺 per-hunk 操作、冲突处理、review 评论和 Codex 原生 change set。 | P1 |
| partial | 图片显示 | 已支持本地图片代理、附件图片展示、错误占位、放大、下载、新窗口打开和多图图库；仍缺标注、缩放平移和更完整的媒体管理。 | P2 |
| partial | artifact 视图 | 已有 artifact 列表，PDF/Text 可 iframe 预览，其他文件可下载或新窗口打开；仍缺 Office、PPT、表格、Notebook 等专门预览和结构化编辑。 | P2 |
| partial | 消息操作 | 已支持复制、编辑、重新生成、折叠/展开、删除、定位和代码块复制；当前主要是前端会话态操作，不会回写 Codex/Claude 原始历史，也没有跨设备同步。 | P2 |

## 权限与安全

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | 权限模型 | VibeLink Agent 任务支持 sandbox、approval policy、network access、trusted workspace UI；Codex Desktop Remote 仍使用当前 Desktop 设置，且不接管 Desktop 内部权限模型。 | P0 |
| partial | 逐条审批 | 已有危险任务设置拦截，并为 workspace 终端/测试命令新增命令级风险识别与 428 确认：递归删除、Git 历史重写、下载执行、提权、内联解释器、网络安装等会先暂停并写审计；仍缺 Agent tool call 级持久审批、权限升降级说明和审批后继续同一 tool call。 | P0 |
| partial | API key 存储 | 已接 Windows DPAPI、macOS Keychain、Linux Secret Service，`settings.json` 会清空明文 key，并迁移旧明文；仍需要更明确的失败提示、导入导出和无系统凭据库时的降级策略。 | P1 |
| partial | 访问审计 | 已有 `audit_log`，记录登录、设备、IP、UA、任务发送、文件访问、失败原因，并对登录、配对、任务、文件等接口限流；仍缺异常告警、审计导出、保留策略和风险看板。 | P1 |
| partial | 公网配对与设备策略 | 已有 QR pairing、短时 session、设备确认、token hash、revoke/rotate/expiry、Host allowlist 和 Cloudflare 向导；仍不是完整账号系统，也未内建 Cloudflare Access/证书自动化。 | P1 |

## Workspace / Git / 代码工作流

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | change card | 前端已有变更卡、diff viewer、文件级接受/拒绝、全部暂存和 task/workspace 变更摘要；仍缺 per-hunk stage、评论、冲突解决和历史快照对比。 | P1 |
| partial | 文件树 | 已有 workspace 文件树、目录导航、文本文件打开、二进制/过大文件占位；仍缺内联编辑、文件搜索、重命名/删除/新建和大文件分页。 | P1 |
| partial | 文件定位 | Markdown 链接、本地文件链接和可解析路径可跳到对应 workspace 文件与行号并高亮；仍依赖路径解析和已登记 workspace，裸路径自动识别、编译器/测试框架路径格式覆盖还不完整。 | P1 |
| partial | 内置终端 | 已有 workspace 命令运行器，可显示 stdout/stderr/退出状态，并接入危险命令逐条确认；仍不是交互式 PTY，没有 shell 会话保持、输入补充、任务树和 ANSI 完整渲染。 | P1 |
| partial | Git 完整工作流 | 已支持 status/diff、stage/unstage、stage all、commit、push、pull、`gh pr create` 和永久 worktree 创建；仍缺 branch 切换/删除、stash 管理、worktree 列表/移除、PR review、远端凭据引导和冲突向导。 | P1 |
| partial | 测试结果视图 | 已有测试命令入口、结构化 passed/failed 粗解析、失败行提取和日志折叠；仍缺 Jest/Pytest/Vitest 等框架适配、失败跳转、重跑单测和耗时趋势。 | P1 |

## Codex Desktop / UI 遥控与按需同步

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | 运行中检测 | 刷新、进入会话、发送/聚焦时按需扫描 Codex 侧栏最近会话、composer 状态、运行数量、可见 transcript 和草稿状态；仍受 UIA 可见性、Codex UI 改版、窗口状态影响。 | P0 |
| partial | 会话定位 | 可用侧栏 index、标题、项目名匹配并 focus，发送前 fail-closed；同名会话、滚动不可见、折叠列表仍可能需要用户重新绑定。 | P0 |
| missing | 手机观看 Desktop 实时画面 | 只能同步结构化状态和可见 transcript 摘要，不能像远程桌面一样观看/控制完整 Codex 窗口。 | P2 |

## Codex 生态能力

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| missing | 插件管理 UI | 没有插件安装、启用、配置、状态展示。 | P2 |
| missing | MCP 管理 | 没有 MCP server 配置、连接器授权、健康检查。 | P2 |
| missing | Hooks 管理 | 没有 hooks 生命周期管理和可视化规则。 | P2 |
| missing | AGENTS/config 可视化 | 不能查看、编辑、解释 `AGENTS.md`、`.codex/config.toml`、requirements。 | P2 |
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
| partial | 原生移动端 | 已有 Android MVP 工程和构建脚本，但当前主体验仍是网页/PWA；没有完整 Android/iOS App、后台任务、原生通知和系统分享入口。 | P1 |
| partial | 通话实时转写/面试辅助 | Windows audio probe（list/probe/level/stream）、后端 Live Call API + SQLite 持久化、WebSocket PCM 推流（`/api/live-calls/:id/audio`）、Mock ASR pipeline（`liveCallAsr.js`）、VibeLink Agent 自动触发（`liveCallAgent.js`）、前端 Live Call 面板（创建/停止/电平/转录/问答/Agent delta SSE）已完成。**尚未完成**：真实 ASR provider 接入、真实 PCM 端到端 10 分钟 QA、前端暂停/恢复/录制管理。详见 `docs/windows-bluetooth-call-transcription-mvp.md`。 | P1 |
| partial | 推送通知 | 已有 Web Push 订阅、关键事件通知入口和邮件 fallback 配置；仍缺 iOS/Android 原生 APNs/FCM/Expo Push、通知偏好和投递状态。 | P0 |
| partial | 断线恢复 | task events、按需产生的 desktop observations、live call events 均可写入 SQLite；任务和 live call 仍有 SSE/catch-up，Codex Desktop Remote 前端默认不订阅后台 observer。仍缺 ack、保留策略、压缩和多设备一致性测试。 | P0 |
| partial | 公网访问 | 已有 QR 配对、设备确认、token hash、revoke/rotate/expiry、Host allowlist、审计、限流和 Cloudflare 向导；仍缺完整账号系统、域名/证书自动化、Cloudflare Access 深度集成和部署体检。 | P1 |

## Claude Code 支持

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | Claude CLI 包装 | 有基础 `--print --output-format stream-json --include-partial-messages` 支持，模型/effort/permissionMode 可透传；测试覆盖和错误恢复仍不如 Codex 路线。 | P1 |
| partial | Claude 历史解析 | 能扫描 `.claude/projects` JSONL 文本；未完整映射 Claude 的工具事件、权限、session 状态。 | P1 |
| partial | 多 provider 抽象 | Codex/Claude 混合列表可用，但内部数据模型仍偏 Codex 优先。 | P1 |

## UI / 体验

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | 动效 | 已限制逐字动画只在实时 agent 输出中触发，历史回看/点击消息不会反复播放；整体动效、转场和微交互仍不如 Codex 细腻。 | P1 |
| partial | Codex 风格布局 | 侧栏、composer、turn block、变更卡和 workspace 面板已接近 Codex；设置页、管理菜单、权限/审批交互仍偏原型。 | P1 |
| partial | 设置页 | 设置页可配置模型命令、权限、安全、公网和凭据状态；缺少配置中心层级、风险解释、导入导出和配置验证报告。 | P1 |
| partial | Live Call 面板 | 已有右侧抽屉面板，含创建/停止通话、SSE 实时转录、音频电平条和问答卡片；仍需 ASR 集成、Agent 流水线和录制文件管理。 | P1 |
| missing | 暗色模式 | 不支持暗色模式。 | P2 |
| missing | 命令面板/快捷键 | 没有快捷键、命令面板、键盘导航体验。 | P2 |
| partial | 移动适配 | 基础响应式可用，但长时间手机操作、弱网恢复、触控密度和原生系统集成仍需打磨。 | P1 |

## 架构

| 状态 | 差异点 | 当前情况 | 优先级 |
| --- | --- | --- | --- |
| partial | 事件可靠性 | task、live call 事件已有 cursor、catch-up、SSE、去重和本地 cursor；desktop observation 改为按需采样记录，默认不常驻推送。还缺 ack、保留策略、压缩和重放边界测试。 | P0 |
| partial | 进程生命周期 | 服务可恢复历史和事件，但不能重新绑定重启前仍在跑的子进程。 | P0 |
| partial | 多设备同步 | 多设备可凭 device token 登录并共享事件流；缺少在线状态、冲突处理、消息操作同步和设备间协作策略。 | P1 |
| partial | 平台定位 | 当前仍是本机 bridge + 手机网页/Android MVP，不是完整公网安全远程 agent 平台。 | P0 |

## 建议下一批优先级

1. `P0`：按 `docs/vibelink-agent-architecture.md` 继续收敛 provider registry、模型 catalog 和统一事件恢复。
2. `P0`：继续增强 Codex Desktop Remote 输出同步，但保持手动/半自动触发：JSONL reconcile、tool 摘要归属、workspace diff/change card 自动关联和失败边界提示。
3. `P1`：把内置终端升级为 PTY 会话，支持 ANSI、输入补充、长期任务、停止和日志折叠。
4. `P1`：完善 Workspace/Git：裸路径自动链接、文件搜索/编辑、per-hunk 操作、branch/stash、worktree 列表/移除、PR review 和冲突向导。
5. `P1`：增强测试视图：框架适配、失败定位、单测重跑和测试历史。
6. `P1`：补动态模型 catalog、Desktop 原生菜单验证切换或明确继续保持“Desktop 使用当前设置”的产品边界。
7. `P1`：补 artifact 富预览：PDF 页级预览、Office/表格/PPT 预览、下载/打开策略和大文件处理。
