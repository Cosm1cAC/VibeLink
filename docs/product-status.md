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

- `/api/search` 统一搜索 session、task、message 和 Workspace 文件，Workspace 已改用 SQLite FTS5 持久索引，通过启动增量校验、文件监听和定时补偿更新；API 支持 scope、cursor、tag、favorite、排序、保存搜索和去重搜索历史，Android 已接入条件恢复、结果跳转及管理入口。
- Thread metadata 已迁入 SQLite，支持标签、收藏、批量编辑和 revision/field revision 冲突检测；旧 `thread-state.json` 仅做一次兼容导入。
- 全局 command registry 已接入 Web 命令面板，并向 Android 暴露导航、搜索、会话、Workspace、Live Call、Review、Settings 和 Approval 动作。
- PR review 已有本地持久 session/comment API、Android Review 工作流和独立 GitHub runtime；后端可同步 PR metadata、changed files、diff、review threads/comment 状态，以 head SHA 检测冲突并提交 review decision。session 仍保存在 `reviews.json`。
- Provider registry 已接入真实动态 catalog/health loader：Codex 走 app-server `model/list`，Claude/GLM 走模型 API，豆包走 browser bridge doctor；catalog/health 具备 TTL、single-flight、失败回退和 SQLite last-known-good 跨重启缓存，并发布当前 execution ownership、capability、protocol/version 和逐字段 fidelity。Status 与 Doctor 共用这份 readiness。
- Codex app-server contract gate 已审查 CLI 0.144.5，并覆盖 thread/turn/item/tool 生命周期、agent/command output、MCP progress 和 approval schema；纯 normalizer、JSON-RPC mock 和 approval bridge 单元已落地，但 app-server JSON-RPC connection 尚未由 execution worker 持有，未知版本仍会 fail-closed。
- SQLite 已增加 `execution_bindings`、host event cursor 和 approval outbox；Rust `execd`、独立 worker、Job Object、ConPTY/stdio、分段 spool/replay/ack 和启动身份校验已实现。Bridge 启动会统一读取 binding、查询 execd、补 ingest/ack，并恢复 Terminal、Workspace command 与 Agent task/tool 订阅。通用 approval dispatcher 已轮询 transactional outbox 并向 execution host 投递，worker 事件可回写 delivered/applied/stale；当前 CLI Provider 仍发布 `approvalContinuation=false`，Codex app-server adapter 尚未接入。
- Event Store 已增加单调 device/stream ack、ack-aware retention plan 和 compaction marker repository，并同步覆盖 SQLite、Worker client 与 Rust sidecar contract；客户端 ack API、实际 compaction 执行和 spool quota 仍未接入。
- Windows Rust 前门已覆盖 Status、Doctor、Devices、设备写操作、Pairing、Audit、Settings、Tool Events REST/SSE 和 Workspace 文件写入；其余 HTTP/SSE/WebSocket 仍透明转发 Node，并保留逐 slice 回退。
- Android 补齐了凭据加密、鉴权附件流、原生 push 注册、前后台实时流挂起/恢复、音频流有界重试、中英文运行文案，以及搜索、标签/收藏、命令发现和 PR review 入口。

## 仍然存在的优先问题

### P0 阻塞项

- tool-call 级审批 continuation 尚未闭环。当前高风险 VibeLink 工具可在批准后重跑受支持动作，transactional outbox 到 execution host 的通用投递链已接入，但现有 CLI adapter 没有可恢复的 upstream request connection；真正的 Codex request/tool-call continuation 仍需 app-server adapter。
- durable execution host 已进入产品运行链，但尚缺 Bridge/execd/worker crash canary、长时 spool/ack 和故障告警证据。在这些验证完成前，不能把跨重启恢复视为已达到生产可靠性门槛。

### P1 产品缺口

- VibeLink Agent 已有 CLI durable execution owner、运行中输入的内存 queued resume，以及 Provider catalog/health 的 SQLite 跨重启缓存；任务执行仍缺统一持久队列、并发上限、失败重试和后台调度面板。
- Rust 前门已成为 Windows 默认入口，但产品仍捆绑 Node；Workspace/Git/command/approval、task/history/terminal、Provider 和 Live Call 等职责尚未完成 Rust 所有权迁移。
- Workspace 全文搜索已不再在请求内扫描文件；索引器最多跟踪每个 Workspace 100,000 个文件，单文件正文索引上限 1 MiB，超限或二进制文件仍索引路径。session/task/message 仍在请求内聚合原生 history 与运行状态，尚未进入同一持久全文索引。
- Workspace 仍缺大文件分页、富二进制预览、更完整的批量操作和成熟冲突处理。
- Git 已支持常用状态、diff、stage、commit、push、pull、PR 创建、branch、stash、worktree、per-hunk 和冲突动作；PR review 工作台已接入 GitHub 远端同步、冲突检测和 review 提交，仍缺 GitLab runtime 和完整 worktree 生命周期管理。
- 测试视图仍是通用文本解析，缺少 Jest/Pytest/Vitest 结构化适配和单测重跑。
- Live Call 已支持 pause/resume、本地 PCM 文件列表/删除、ASR provider 诊断和可选 whisper.cpp；缺少可默认交付的生产 ASR 配置、长时间真实 PCM/弱网 QA 和录音生命周期策略。没有可用 whisper.cpp binary/model 时仍回退 deterministic mock。
- 事件已有 cursor catch-up、Rust/Node replay、单调 ack repository、ack-aware retention plan 和 compaction marker；仍缺客户端 ack API、实际 retention/compaction 执行、spool quota marker 和多设备冲突策略。
- 尚无 iOS 客户端。

### P2 后续能力

- 缺少插件、Hooks、Automations、Subagents 和 AGENTS/config 可视化管理。
- 缺少内置浏览器视图、浏览器测试轨迹和手机端浏览器遥控。
- Workspace 已有增量全文索引、保存搜索和搜索历史；仍缺 session/task/message 的持久增量索引，以及更完整的命令历史体验。
- Office、表格、PDF、Notebook 等 artifact 仍缺专门预览和编辑体验。

## 已知且不计划消除的边界

- VibeLink 无法事后接管电脑上任意已运行进程的 stdin/stdout/PTY。只有从启动时即由 VibeLink execution worker 持有、且 binding owner 为 `execution-host` 的 execution 才承诺重连；外部进程永久属于 `external`。
- Codex Desktop 未公开稳定的完整 tool 输出、退出码、所有权和审批 continuation。Desktop Remote 只能按需采样、实时近似并在完成后校准，不能获得 VibeLink Agent 等级的权威执行状态。
- Desktop UI 遥控依赖 Windows UIA、前台窗口、控件文案和 Electron UI 结构，必须 fail-closed，不能视为稳定第一方协议。
- 公网入口采用配对、设备 token、撤销/轮换、Host allowlist、审计、限流和 Cloudflare 向导；当前产品范围不建设完整云账号系统。

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
- 当前 contract gate 接受已审查的 Codex CLI 0.117/0.144 schema；0.144.5 fixture 固定真实 bundle hash，并校验 thread/turn/item/tool 生命周期、command/file/permission approval、dynamic tool call 和 output/progress。它仍是兼容性门禁与纯事件 normalizer，不是已启用的 Provider runtime adapter。
- UIA 可以定位 Desktop composer 和发送按钮；纯 `ValuePattern.SetValue` 不会触发前端输入事件，可靠路径是窗口校验、点击 composer、剪贴板粘贴、发送并做 postflight。

## 下一批优先级

1. 对 durable execution host 和 startup reconciliation 执行 Bridge/execd/worker crash、长时 spool/ack 与故障告警 canary。
2. 让 execution worker 持有 schema-gated Codex app-server connection，把现有 approval dispatcher 接到真实 request continuation，并在 Web/Android 展示 delivery/attach/fidelity 状态。
3. 补齐 Provider 任务持久队列、并发上限、失败重试和后台调度。
4. 完成 Live Call 生产 ASR 配置与长时间真实音频/弱网 QA。
5. 将 session/task/message 纳入持久搜索索引，并完成客户端事件 ack、实际 retention/compaction、Workspace 结构化结果和多设备冲突处理。
