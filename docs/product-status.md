# VibeLink 产品状态与剩余差距

最后更新：2026-07-19

本文只记录当前产品边界和仍值得追踪的差距。设计方案和 contract fixture 不等于可用能力；只有已经接入产品运行链路的实现才计入“当前能力”。

## 当前产品形态

VibeLink 已形成三个清晰层次：

- **Codex Desktop Remote**：按需读取和遥控已安装的 Codex Desktop，复用 Desktop 当前模型、权限和登录状态。
- **VibeLink Agent**：通过 Codex、Claude、豆包、GLM 等 Provider 执行任务，统一 Workspace、工具事件、审批、恢复和审计。
- **Live Call Assistant**：负责音频采集、转写和问题检测；问题形成后交给 VibeLink Agent。

Web 与 Android 已覆盖会话和任务、Codex Remote、Workspace 文件/Git/Test/PTY、Settings、Approvals、Devices、Tool events、附件/系统分享、通知和 Live Call。Windows portable 当前是 Rust 前门 + loopback Node 后端的混合包：普通 `vibelink.exe` 会启用已迁移的 Rust 路由，未迁移流量继续转发给 Node；`vibelink.exe bridge` 和 `npm start` 保留直接 Node 路径。

## 最近已落地

- 统一搜索已将 session/task/message 纳入 SQLite FTS5 持久索引：Agent JSONL 按 byte offset 增量 tail，task event 按 cursor 追读并自动处理截断、缺失源和 FTS 损坏重建；`/api/search` 只查询持久索引，不再按请求聚合原生 history 与运行中 task。
- Workspace 文件读取已支持最大 1 MiB 的 UTF-8 byte cursor 分页；PDF、Office、CSV/TSV、Notebook 和文本复用 artifact runtime 提供有界、脱敏的结构化 preview。批量 mutation 支持最多 100 个 write/rename/delete，提供 atomic 预检、冲突汇总、失败回滚和 best-effort 逐项结果，并用 Workspace 级串行队列保护 revision 检查。
- `/api/search` 统一搜索 session、task、message 和 Workspace 文件，Workspace 已改用 SQLite FTS5 持久索引，通过启动增量校验、文件监听和定时补偿更新；API 支持 scope、cursor、tag、favorite、排序、保存搜索和去重搜索历史，Android 已接入条件恢复、结果跳转及管理入口。
- Thread metadata 已迁入 SQLite，支持标签、收藏、批量编辑和 revision/field revision 冲突检测；旧 `thread-state.json` 仅做一次兼容导入。
- 全局 command registry 已接入 Web 命令面板，并向 Android 暴露导航、搜索、会话、Workspace、Live Call、Review、Settings 和 Approval 动作。
- PR review 已有本地持久 session/comment API、Android Review 工作流，以及独立 GitHub/GitLab runtime；后端可同步 PR/MR metadata、changed files、diff、review threads/comment 状态，以 head SHA 检测冲突并提交 review decision。GitLab 支持 draft notes 批量发布、reviewer state 和 approval；session 仍保存在 `reviews.json`。
- Provider registry 已接入真实动态 catalog/health loader：Codex 走 app-server `model/list`，Claude/GLM 走模型 API，豆包走 browser bridge doctor；catalog/health 具备 TTL、single-flight、失败回退和 SQLite last-known-good 跨重启缓存，并发布当前 execution ownership、capability、protocol/version 和逐字段 fidelity。Status 与 Doctor 共用这份 readiness。
- Codex app-server contract gate 已审查 CLI 0.144.5，并覆盖 thread/turn/item/tool 生命周期、agent/command output、MCP progress 和 approval schema；execution worker 现在同时支持 `thread/start` 与 `thread/resume`，并在同一条存活 WebSocket 上把 command/file/permission 审批决定写回原始 JSON-RPC request。未知版本仍会 fail-closed。
- SQLite 已增加 `execution_bindings`、host event cursor 和 approval outbox；Rust `execd`、独立 worker、Job Object、ConPTY/stdio/app-server、分段 spool/replay/ack 和启动身份校验已实现。Bridge 启动会统一读取 binding、查询 execd、补 ingest/ack，并恢复 Terminal、Workspace command 与 Agent task/tool 订阅。通用 approval dispatcher 已轮询 transactional outbox 并向 execution host 投递，worker 事件可回写 delivered/applied/stale；Codex 新任务和恢复任务均走 durable app-server adapter。
- Agent 任务统一进入 SQLite `task_queue`；后台调度器提供可配置并发上限、优先级认领、指数退避失败重试、重启恢复，以及 Settings 内的运行/等待/失败队列面板和手动重试、取消操作。
- Event Store 已增加单调 device/stream ack、ack-aware retention plan 和 compaction marker repository，并同步覆盖 SQLite、Worker client 与 Rust sidecar contract；客户端 ack API、实际 compaction 执行和 spool quota 仍未接入。
- Workspace 测试命令已接入 Jest、Vitest 和 Pytest 结构化 adapter；Web 与 Android 均展示 suite/case 结果树、状态、耗时、文件位置和失败文本，并可从失败 case 直接执行后端生成的 rerun command。重跑仍经过 Workspace test 风险评估与审批链，Android 可在批准后回填结果。
- 只读 artifact runtime 已支持鉴权 metadata、bounded range，以及 PDF、CSV/TSV、XLSX、Notebook 和 OpenXML 文档的有界 best-effort preview；Web 目前只有 PDF/Text 基础内联，Android 主要提供附件识别与打开，尚未消费完整结构化 preview。
- Windows Rust 前门已覆盖 Status、Doctor、Devices、设备写操作、Pairing、Audit、Settings、Tool Events REST/SSE 和 Workspace 文件写入；其余 HTTP/SSE/WebSocket 仍透明转发 Node，并保留逐 slice 回退。
- Android 补齐了凭据加密、鉴权附件流、原生 push 注册、前后台实时流挂起/恢复、音频流有界重试、中英文运行文案，以及搜索、标签/收藏、命令发现和 PR review 入口。

## 仍然存在的优先问题

本节只收录能够通过后续工程工作关闭的事项；外部协议限制和明确不建设的产品范围单独列在“已知且不计划消除的边界”。

### P0 阻塞项

- **待签发：durable execution host 生产可靠性。** `execution-host:canary` 已覆盖 Bridge 重连、execd 两次崩溃重启、downtime spool replay、durable ack/prune、持续 spool/ack 和 worker crash 的 durable `execution.lost` 告警信号；本地 debug 二进制 60 秒样本完成 168 轮 ack 并通过全部检查。发布二进制仍必须产出 `execution-host:soak` 一小时报告后，才能把跨重启恢复视为达到生产可靠性门槛。

### P1 产品缺口

- Rust 前门已成为 Windows 默认入口，但产品仍捆绑 Node；Workspace/Git/command/approval、task/history/terminal、Provider 和 Live Call 等职责尚未完成 Rust 所有权迁移。
- Git 已支持常用状态、diff、stage、commit、push、pull、PR 创建、branch、stash、per-hunk 和冲突动作；worktree 已覆盖创建、列表、删除、prune、lock/unlock，并保护主 worktree、校验仓库归属。PR review 工作台已接入 GitHub/GitLab 远端同步、冲突检测和 review 提交。
- Live Call 已支持 pause/resume、本地 PCM 文件列表/删除、ASR provider 诊断、可选 whisper.cpp、默认生产配置、真实 PCM/弱网长时 QA，以及按天数、单文件和总容量约束的录音生命周期策略。缺少真实 provider 时会明确报错，deterministic mock 仅允许显式选择。
- 事件已有 cursor catch-up、Rust/Node replay、单调 ack repository、ack-aware retention plan 和 compaction marker；仍缺客户端 ack API、实际 retention/compaction 执行、spool quota marker 和多设备冲突策略。

### P2 后续能力

- 已有 Skills 扫描/刷新、Agent Reach skill 管理和 MCP tool registry，但仍缺通用插件生命周期、Hooks、Automations、Subagents，以及 AGENTS/config 可视化管理。
- Playwright browser session runtime 已实现有界 session/page、导航、截图和脱敏 trace，但尚未接入生产 HTTP 契约、内置 Web/Android 浏览器视图或手机端浏览器遥控。
- artifact 后端已有 PDF、表格、Notebook 和 OpenXML 文档的只读结构化 preview；仍缺 Web/Android 专门 renderer、交互式表格/Notebook 体验和编辑能力。

## 已知边界与当前非目标

- VibeLink 无法事后接管电脑上任意已运行进程的 stdin/stdout/PTY。只有从启动时即由 VibeLink execution worker 持有、且 binding owner 为 `execution-host` 的 execution 才承诺重连；外部进程永久属于 `external`。
- Codex Desktop 未公开稳定的完整 tool 输出、退出码、所有权和审批 continuation。Desktop Remote 只能按需采样、实时近似并在完成后校准，不能获得 VibeLink Agent 等级的权威执行状态。
- Desktop UI 遥控依赖 Windows UIA、前台窗口、控件文案和 Electron UI 结构，必须 fail-closed，不能视为稳定第一方协议。
- 公网入口采用配对、设备 token、撤销/轮换、Host allowlist、审计、限流和 Cloudflare 向导；当前产品范围不建设完整云账号系统。
- iOS 客户端是当前非目标，暂不开发，也不计入 P0/P1/P2 产品缺口。

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
- 当前 contract gate 接受已审查的 Codex CLI 0.117/0.144 schema；0.144.5 fixture 固定真实 bundle hash，并校验 thread/turn/item/tool 生命周期、command/file/permission approval、dynamic tool call 和 output/progress。通过门禁的 app-server adapter 已接入 execution worker；未审查版本不会回退到声称支持 continuation 的路径。
- UIA 可以定位 Desktop composer 和发送按钮；纯 `ValuePattern.SetValue` 不会触发前端输入事件，可靠路径是窗口校验、点击 composer、剪贴板粘贴、发送并做 postflight。

## 下一批优先级

1. 用发布二进制执行一小时 `execution-host:soak` 并归档 JSON 报告，签发 durable execution host 生产可靠性门槛。
2. 在 Web/Android 完整展示 approval delivery/attach/fidelity 状态。
4. 在发布流水线持续执行 Live Call 一小时真实音频/弱网门禁并归档质量基线。
5. 完成客户端事件 ack、实际 retention/compaction、Workspace 结构化结果的客户端消费和跨设备合并体验。
