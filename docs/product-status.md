# VibeLink 产品状态与剩余差距

最后更新：2026-07-18

本文只记录当前产品边界和仍值得追踪的差距。设计方案和 contract fixture 不等于可用能力；只有已经接入产品运行链路的实现才计入“当前能力”。

## 当前产品形态

VibeLink 已形成三个清晰层次：

- **Codex Desktop Remote**：按需读取和遥控已安装的 Codex Desktop，复用 Desktop 当前模型、权限和登录状态。
- **VibeLink Agent**：通过 Codex、Claude、豆包、GLM 等 Provider 执行任务，统一 Workspace、工具事件、审批、恢复和审计。
- **Live Call Assistant**：负责音频采集、转写和问题检测；问题形成后交给 VibeLink Agent。

Web 与 Android 已覆盖会话和任务、Codex Remote、Workspace 文件/Git/Test/PTY、Settings、Approvals、Devices、Tool events、附件/系统分享、通知和 Live Call。Windows portable 当前是 Rust 前门 + loopback Node 后端的混合包：普通 `vibelink.exe` 会启用已迁移的 Rust 路由，未迁移流量继续转发给 Node；`vibelink.exe bridge` 和 `npm start` 保留直接 Node 路径。

## 最近已落地

- `/api/search` 统一搜索 session、task、message 和 Workspace 文本文件，并支持 scope、cursor、tag、favorite 过滤；Android 已接入搜索状态、结果去重和目标跳转。
- Thread metadata 已迁入 SQLite，支持标签、收藏、批量编辑和 revision/field revision 冲突检测；旧 `thread-state.json` 仅做一次兼容导入。
- 全局 command registry 已接入 Web 命令面板，并向 Android 暴露导航、搜索、会话、Workspace、Live Call、Review、Settings 和 Approval 动作。
- PR review 已有本地持久 session/comment API 和 Android Review 工作流。当前实现保存在 `reviews.json`，属于本地审查工作台，不等于 GitHub/GitLab 在线 review 同步。
- Provider registry 已统一 readiness、capability、reasoning effort 和 catalog metadata；动态 catalog resolver 已实现校验、TTL cache、stale/fallback 语义，但生产 registry 尚未注入 runtime loader，当前仍返回内置模型目录。
- Codex app-server 已有针对受审版本的 schema/capability contract gate 和独立 probe；它还没有成为 Agent runtime adapter，未知版本会按设计降级而不是尝试宽松解析。
- SQLite 已增加 `execution_bindings`、host event cursor 和 approval outbox，具备连续序列校验、幂等 ingest/ack、decision version 与 transactional outbox 基础。`execd`、独立 worker 和审批投递器尚未实现，因此这不是“进程已可跨重启接管”。
- Windows Rust 前门已覆盖 Status、Doctor、Devices、设备写操作、Pairing、Audit、Settings、Tool Events REST/SSE 和 Workspace 文件写入；其余 HTTP/SSE/WebSocket 仍透明转发 Node，并保留逐 slice 回退。
- Android 补齐了凭据加密、鉴权附件流、原生 push 注册、前后台实时流挂起/恢复、音频流有界重试、中英文运行文案，以及搜索、标签/收藏、命令发现和 PR review 入口。

## 仍然存在的核心边界

### P0

- 无法接管电脑上任意已运行进程的 stdin/stdout/PTY。只有未来由 VibeLink worker 从启动时持有句柄的 execution 才可能提供可靠重连；外部进程永久属于 `external`。
- 服务重启可以恢复 SQLite 状态、历史和事件，但当前 Node 仍直接持有 Agent、Workspace command 和 PTY 子进程，重启后不能重新绑定这些 OS 句柄。
- Codex Desktop 未公开稳定的完整 tool 输出、退出码、所有权和审批 continuation。Remote 只能按需采样、实时近似并在完成后校准。
- Desktop UI 遥控依赖 Windows UIA、前台窗口、控件文案和 Electron UI 结构，必须 fail-closed，不能视为稳定第一方协议。
- tool-call 级审批 continuation 尚未闭环。当前高风险 VibeLink 工具可在批准后重跑受支持动作，新的 outbox 只完成持久化与状态机基础，尚未投递到同一个 upstream request/tool call。
- durable execution host 目前只有 ADR、named-pipe protocol、Codex contract gate 和 SQLite persistence；`execd`、worker、Job Object、ConPTY/stdio backend、spool/replay 和启动 reconciliation 均未实现。

### P1

- VibeLink Agent 缺少统一任务队列、并发上限、失败重试、后台调度面板和 durable execution owner。
- Provider registry 的公共结构已经统一，但动态 loader、健康探测、catalog 持久缓存，以及 execution ownership/fidelity 仍未接入完整生产链。
- Rust 前门已成为 Windows 默认入口，但产品仍捆绑 Node；Workspace/Git/command/approval、task/history/terminal、Provider 和 Live Call 等职责尚未完成 Rust 所有权迁移。
- 统一搜索是有界的即时扫描，不是索引式全文搜索：Workspace 单文件上限 256 KiB、每个 Workspace 最多扫描 1200 个文件，大仓库的排序、增量索引和性能仍需完善。
- Workspace 仍缺大文件分页、富二进制预览、更完整的批量操作和成熟冲突处理。
- Git 已支持常用状态、diff、stage、commit、push、pull、PR 创建、branch、stash、worktree、per-hunk 和冲突动作；新增的本地 PR review 工作台仍缺远端 PR 同步、review 提交和完整 worktree 生命周期管理。
- 测试视图仍是通用文本解析，缺少 Jest/Pytest/Vitest 结构化适配和单测重跑。
- Live Call 已支持 pause/resume、本地 PCM 文件列表/删除、ASR provider 诊断和可选 whisper.cpp；缺少可默认交付的生产 ASR 配置、长时间真实 PCM/弱网 QA 和录音生命周期策略。没有可用 whisper.cpp binary/model 时仍回退 deterministic mock。
- 事件已有 cursor catch-up 和 Rust/Node replay 路径，但客户端 ack、retention/compaction、spool quota marker 和多设备冲突策略尚未闭环。
- 公网入口已有配对、设备 token、撤销/轮换、Host allowlist、审计、限流和 Cloudflare 向导，但不是完整账号系统。
- 尚无 iOS 客户端。

### P2

- 缺少插件、Hooks、Automations、Subagents 和 AGENTS/config 可视化管理。
- 缺少内置浏览器视图、浏览器测试轨迹和手机端浏览器遥控。
- 缺少跨资源增量索引、保存搜索和更完整的搜索/命令历史体验。
- Office、表格、PDF、Notebook 等 artifact 仍缺专门预览和编辑体验。

## Android 收口状态

Android 已不再是 MVP 壳层，主要闭环包括：

- Token/QR/Deep Link 配对、设备审批、撤销、过期处理和 Keystore 凭据保护。
- 会话统一搜索、归档、置顶、重命名、fork、标签、收藏、批量编辑、新建和继续任务。
- Composer 附件、鉴权预览、图片、文件夹、系统分享，以及消息编辑/删除/重新生成。
- Markdown、代码块、表格、引用、数学公式、图片和消息级动作。
- Workspace 文件编辑、Git、测试、PTY terminal 和本地 PR review 工作台。
- Settings、Security、Approvals、Devices、Audit、Doctor 和 Provider/command registry 发现。
- Tool event 生命周期、SSE catch-up、弱网 polling、前后台流控制和恢复策略。
- Live Call 会话恢复、事件回放、pause/resume、助手与 ASR 选择、转录、麦克风推流、电平、PCM 文件管理和问答卡片。
- 原生 push capability 注册、中英文选择和主要运行时状态本地化。

后续 Android 工作应围绕真实设备长时间稳定性、弱网、多设备一致性、搜索规模、可访问性和剩余硬编码文案，而不是继续维护逐条“已完成”清单。

## Codex 集成结论

- Windows 上 `codex remote-control start --json` 的 daemon lifecycle 不可用，但手工启动 `codex app-server --listen ws://127.0.0.1:<port>` 可工作。
- 第二客户端必须在已有 rollout 后显式 `thread/resume`，才能收到后续 turn delta；被动连接不会得到完整 turn 流。
- 当前 contract gate 只接受已审查的 Codex CLI 0.117 schema，并校验 command/file-change approval、permission request、dynamic tool call、output delta 和 completion 等关键协议面；它是兼容性门禁，不是已启用的 Provider adapter。
- UIA 可以定位 Desktop composer 和发送按钮；纯 `ValuePattern.SetValue` 不会触发前端输入事件，可靠路径是窗口校验、点击 composer、剪贴板粘贴、发送并做 postflight。

## 下一批优先级

1. 实现 durable execution host Phase 1/2：`execd`、独立 worker、Job Object、ConPTY/stdio、spool/replay 和 Bridge restart reconciliation。
2. 把 approval outbox 接到 schema-gated Codex app-server continuation，并在 Web/Android 展示 delivery/attach/fidelity 状态。
3. 为 Provider registry 注入真实动态 catalog/health loader，补齐任务并发、重试和调度策略。
4. 完成 Live Call 生产 ASR 配置与长时间真实音频/弱网 QA。
5. 补强搜索索引、事件 ack/retention、Workspace 结构化结果和多设备冲突处理。
