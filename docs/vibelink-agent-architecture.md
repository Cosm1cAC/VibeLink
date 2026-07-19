# VibeLink Agent 当前架构

最后更新：2026-07-19

本文只描述当前有效架构，并明确区分“已接入运行链路”和“已定义但尚未接入”的能力。产品差距见 `docs/product-status.md`，Rust 迁移证据见 `docs/rust-migration-report.md`，执行宿主设计见 `docs/decisions/ADR-0010-durable-execution-host.md` 与 `docs/execution-host-protocol.md`，HTTP 契约见 `docs/openapi.json`。

## 执行模式

### Codex Desktop Remote

用于遥控用户已安装并登录的 Codex Desktop。VibeLink 按需读取可见 transcript、恢复历史、定位会话、写入 composer 并验证发送结果。模型、权限、推理强度和审批策略由 Desktop 当前设置决定。

它不是 Agent Provider：不能接管已有进程，也不能获得 Desktop 未公开的完整 tool 输出、退出状态和 approval continuation。UI 自动化必须校验进程、窗口、目标会话、composer 和发送按钮，任一不匹配就 fail-closed。Desktop execution 固定视为 `external`、sampled fidelity。

### VibeLink Agent

VibeLink 自有的执行系统。Node control plane 负责启动或恢复任务并做产品投影；Codex、Claude 和 GLM CLI 的进程、stdio、退出状态与 stop 由 Rust execution host 的 per-execution worker 持有，豆包 Web bridge 仍属于外部浏览器执行。VibeLink 统一负责任务、Workspace、工具事件、审批、历史恢复和审计。

需要确定模型、权限、网络、沙箱、工具归属或可靠移动端 catch-up 时，应使用 VibeLink Agent。Bridge 会按 SQLite binding 和 host cursor 做启动 reconciliation；只有 VibeLink 从启动时拥有、且 binding owner 为 `execution-host` 的 execution 承诺重连，外部执行不具备这一语义。

### Live Call Assistant

负责 PCM 音频接入、标准化/VAD、ASR、问题检测和回答展示。ASR provider registry 当前包含 deterministic mock，并在本地 binary/model 可用时自动启用 whisper.cpp；问题形成后交给 VibeLink Agent，不依赖 Codex Desktop Remote 生成回答。

## 运行拓扑

Windows 用户入口当前采用混合拓扑：

```text
Web / Android
      |
      v
Rust HTTP front door
  |-- Rust-owned routes: Status, Doctor, Devices, Pairing, Audit,
  |                      Settings, Tool Events REST/SSE, Workspace file writes
  `-- byte-for-byte proxy --> loopback Node bridge
                               |-- task/provider orchestration and projection
                               |-- remaining HTTP/SSE/WebSocket routes
                               |-- SQLite product state, provider cache and event APIs
                               |-- execd / per-execution workers
                               `-- Rust sidecars with Node/Worker fallback
```

普通 `vibelink.exe` 通过 `default_rust_profile` 启用前门和当前已迁移 route flags。每个 Rust slice 仍可独立关闭或在失败前回放 Node；写事务一旦被 Rust 认领则不能自动重放。`vibelink.exe bridge` 是直接 Node 回滚入口，源码开发的 `npm start` 也直接运行 `src/server.js`。

这仍是混合包，不代表 Node 已退出 control plane，也不代表 migration ledger 中的 canary/opt-in slice 已完成退休门槛。

## 模块边界

- `apps/windows/src/http_frontdoor.rs` 与各 `*_http.rs`：外部监听、Rust 原生路由、透明代理和逐 slice 回退。
- `src/server.js`：Node HTTP/SSE/WebSocket 路由、认证、限流和仍未迁移的产品编排。
- `src/agents.js` 与 Provider runtime：任务启动/resume、host event 产品投影、输出解析和事件归一化。
- `src/providerRegistry.js`、`src/providerCacheLoader.js`、`src/providerCacheStore.js`：Provider readiness、capability、reasoning effort、动态 catalog/health resolver 和 SQLite last-known-good cache。
- `src/db.js`、`src/eventStore*`：SQLite 产品状态、事件 cursor、device ack、retention plan、compaction marker、查询和 Rust/Worker/同步回退。
- `src/executionHostClient.js`、`src/executionReconciliation.js`、`src/executionPersistence.js`：execution host facade、启动 reconciliation、binding 和 host event cursor。
- `src/approvalOutbox.js`、`src/approvalDispatcher.js`：transactional decision/outbox、周期投递和 delivered/applied/stale/outcome-unknown 状态；`src/codexApprovalBridge.js` 是尚未接入生产 app-server connection 的 provider-side adapter。
- `src/workspaces.js`、`src/terminalRuntime.js`：allowed roots 下的文件、上下文、Git、command 和 PTY；command/PTY execution 已通过 host facade 持有，文件写路由可由 Rust 前门直接认领。
- `src/mcpRuntime.js`：MCP 发现、probe、调用和持久 session 路由，可使用 Rust sidecar 并回退 Node stdio。
- `src/search.js`、`src/threadState.js`、`src/commandRegistry.js`、`src/reviews.js`：跨资源搜索、会话 metadata、全局动作目录和 review session；`src/githubReviewRuntime.js` 独立承载 GitHub PR 读取与 review 提交，不复用 Workspace command。
- `apps/web` / `apps/android`：共享 HTTP/SSE/WebSocket 契约的 Web 和 Android 客户端。

## Provider Registry 与 Adapter

`/api/provider-registry` 是客户端选择 Provider、模型和推理强度的公共来源。当前 registry 覆盖 Codex、Claude、豆包和 GLM，并返回 availability/status/reason、capabilities、models、reasoning efforts 和 catalog metadata；Web、Android 和 Live Call 助手选择均消费这一结构。

Provider adapter 只处理后端特有能力：命令或 bridge、resume/session id、模型参数、流式输出和错误映射。以下能力必须留在 VibeLink：

- `tasks`、`tool_runs`、`tool_events` 和统一事件归属。
- sandbox、network、approval 和 trusted workspace 策略。
- Workspace/Git/Terminal/MCP 工具入口。
- Web/Android 的恢复、catch-up、通知和审计展示。

生产 registry 已注入长生命周期 catalog/health resolver。Codex 通过真实 app-server `model/list` 发现当前登录态可用模型，Claude 和 GLM 使用各自模型 API，豆包使用本地 browser bridge doctor；catalog 使用 5 分钟 TTL、输入清洗、最多 200 个模型、single-flight、fresh/cached/stale/fallback，health 使用 30 秒 TTL、single-flight 和明确的 ready/unavailable/disabled/missing_credentials 状态。catalog 与 health 的最后成功结果写入 SQLite，Bridge 启动时可先恢复跨重启 cache 再后台刷新。`fresh=1` 会同时强制刷新两者，`/api/doctor` 等待真实 health，`/api/status` 读取同一 resolver 的缓存并以 stale-while-revalidate 方式非阻塞刷新。

每个 Provider 同时发布当前实际 adapter 的 `executionOwnership`、reattach、结构化 tool event、tool output、exit status、approval continuation、live input、protocol/version 和逐字段 fidelity。Codex、Claude、GLM CLI 的 stdio 进程、输出、退出状态与 stop 由 execution worker 持有，因此 owner 为 `vibelink-host`，Bridge startup reconciliation 会恢复订阅并发布 `reattach=true`。运行中输入会排队，并在当前 turn 完成后启动 CLI resume turn，不写入不支持 live input 的 stdin。豆包的模型执行发生在外部浏览器会话中，因此 owner 为 `external`，tool output 固定为 sampled。

## 状态、搜索与事件

`.agent-mobile-terminal/mobile-agent.sqlite` 是产品结构化状态和事件 cursor 的权威来源。SQLite 保存 Workspace、设备、thread metadata/revision、task、task/tool/live-call event、approval、audit、Desktop observation、Workspace FTS 文档元数据、保存搜索与搜索历史，以及新增的 execution binding/host event/outbox 表。

Codex/Claude 原生 JSONL 仍是原始 Agent 历史来源，不整库复制到 SQLite。大附件、图片和完整 diff 不进入数据库。PR review 当前是例外，仍由 `src/reviews.js` 保存到 `reviews.json`；旧 `thread-state.json` 只在首次使用时兼容导入 SQLite。

Task、Tool 和 Live Call 事件通过数值 cursor 支持 REST catch-up 与 SSE 续传。Rust event-store/tool-events 路径与 Node/Worker/SQLite 回退共享同一外部契约。Event Store 已有按 device/stream 单调递增的 ack repository、以最小 ack 计算 safe cursor 的 retention plan，以及 compaction marker；这些方法已进入 SQLite、Worker client 和 Rust sidecar contract。当前还没有 HTTP/客户端 ack、实际统一 retention/compaction executor 或 durable worker spool quota marker。

`/api/search` 在请求时聚合 history、task 和 message，并从 SQLite FTS5 查询 Workspace 文件，然后应用 scope/tag/favorite、排序和 offset cursor。Workspace 索引在服务启动时按 path/size/mtime 做增量校验，运行中在支持稳定递归监听的平台更新单个路径；Windows 默认使用定时全量元数据校验（可显式开启监听），Workspace 写 API 始终直接刷新受影响路径。搜索请求本身不读取 Workspace 文件。每个 Workspace 最多跟踪 100,000 个文件，正文索引上限 1 MiB，超限和二进制文件只索引路径。`saved_searches` 保存完整查询条件，`search_history` 按条件签名去重并累计使用次数。

Thread 标签、收藏和批量编辑写入 SQLite。每次变更增加 revision，并用 field revision 检测过期客户端对同一字段的冲突；add/remove tag 属于可合并操作。全局 command registry 只描述动作和参数，具体导航或 mutation 仍由 Web/Android 的 action router 执行。

## 当前执行持久化边界

代码已经具备 durable execution 与 approval delivery 的运行基础：

- `execution_bindings` 记录 owner、status、attach state、worker/process identity、capabilities 和三个 host cursor。
- `execution_host_events` 要求 host sequence 连续，支持幂等 ingest、冲突检测、分页读取和单调 ack。
- `approval_requests` 增加 continuation、available decisions、decision version 和 delivery status。
- `approval_outbox` 用 operation id 去重，在一个 SQLite 事务中记录 decision、审批状态、审计 decision 和待投递命令，并支持 claim/retry/applied 状态流转。

Rust execution host 已实现 `execd`、per-execution worker、named-pipe v1、Job Object、ConPTY/stdio backend、分段事件 spool 和启动身份校验。Terminal、Workspace command 与 Agent CLI spawn 已接入 host facade；Bridge 启动读取 SQLite binding，查询 execd，按 durable cursor 事务化补 ingest/产品投影/ack，并恢复 task/tool/terminal 订阅。状态统一收敛为 `attached`、`reconnecting`、`unreachable`、`lost` 或 `external`；approval continuation 的完整 rollout 仍未完成。

Bridge 内的 approval dispatcher 已周期 claim outbox，并通过 execution host facade 向存活 worker 投递；worker 的 provider approval events 可将 continuation 收敛为 `delivered`、`applied` 或 `stale`，不明确副作用则标记 `OUTCOME_UNKNOWN`。这只是通用传输闭环：当前 Codex/Claude/GLM CLI registry 仍发布 `approvalContinuation=false`，因为没有 adapter 持有可恢复的 upstream approval request connection。

ADR-0010 规定的目标边界保持有效：只有 VibeLink 从启动时拥有的 execution 才能承诺重连；worker crash 必须收敛为 `lost`；外部进程和 Desktop 永远不能伪装为 attachable；外部副作用结果不明确时返回 `OUTCOME_UNKNOWN`，不得自动重放。

## Codex app-server 边界

Windows 手工启动 `codex app-server --listen ws://127.0.0.1:<port>` 可工作；第二客户端只有在已有 rollout 后显式 `thread/resume`，才能收到后续 turn 流。

仓库已有两个不同层次的 probe：

- `src/codexAppServerProbe.js` 可手工启动真实 app-server，验证双客户端 start/resume 和 live delta，并保存诊断结果。
- `tools/codex-app-server/contract-probe.mjs` 生成实验 schema，并接受已审查的 Codex CLI 0.117/0.144 协议面；0.144.5 fixture 固定了真实 bundle hash、生命周期/输出方法、tool item 类型和 approval response 字段，缺失或漂移都会 fail-closed。
- `src/codexAppServerEvents.js` 纯函数归一化 thread/turn/item/tool/output/approval JSON-RPC 消息；approval request id 明确是 connection-scoped。`src/codexApprovalBridge.js` 已定义 register/resolve/dispatch/retry/stale/outcome-unknown 行为，但尚未绑定 production app-server connection。

当前没有 app-server Provider runtime adapter，也没有 worker 持有其 JSON-RPC connection；normalizer 仅由 contract/mock tests 驱动。CLI resume 仍是 VibeLink Agent 的稳定 Codex 路径，Desktop UIA 仍是独立的 sampled Remote 路径。

## 安全模型

- 文件操作必须通过 allowed roots 和已登记 Workspace 校验。
- 公网入口使用 pairing session、设备 token hash、过期/撤销、Host allowlist、限流和审计。
- Rust/Node 混合写路由遵循“认领前可回退、认领后不重放”，避免重复副作用。
- 高风险 VibeLink 工具返回 428 approval；现有受支持动作批准后可恢复执行。transactional outbox 已能投递到 execution host，只有声明 `approvalContinuation=true` 且持有原 upstream request 的 Provider adapter 才能把它视为同一次 tool call 的 continuation。
- 凭据使用系统凭据库；Android 使用 Keystore 包装持久 token，设置文件不保存明文 API key。
- Desktop Remote 和浏览器自动化必须验证目标，不能因“尽量发送”而注入错误窗口。

## 近期架构任务

1. 对 durable execution host 与产品侧 startup reconciliation 执行 Bridge/execd/worker crash rollout canary。
2. 验证 Terminal、Workspace command 和 Agent provider 的长时 ingest/ack、spool retention 与故障告警。
3. 让 execution worker 持有 schema-gated Codex app-server connection，将现有 approval dispatcher 接到真实 request，并验证 Bridge restart continuation。
4. 完成 Provider 任务持久队列、并发上限、失败重试和后台调度。
5. 暴露客户端 event ack，执行 ack-aware retention/compaction，并补齐多设备冲突和剩余 Rust route ownership；Node 只在所有产品职责通过观察与回滚门槛后退休。

## 并行实施评估

以下拆分按主要代码所有权评估，目的是减少多个分支同时修改 `src/server.js`、`src/db.js` 和 execution worker protocol 的合并冲突。

| 泳道 | 可独立推进的工作 | 主要边界 | 并行判断 |
| --- | --- | --- | --- |
| A. Execution reliability | Bridge/execd/worker crash canary、长时 spool/ack、故障指标与告警 | `tools/`、execution canary/tests、Rust host | 可立即独立推进；其结论是 approval restart 集成的验收门槛 |
| B. Codex app-server adapter | JSON-RPC connection owner、schema gate、approval request/decision adapter mock | `src/codexAppServer*`、独立 adapter/tests | mock 与 A 可并行；接入 worker protocol 和生产 dispatcher 时应在 A 的 host 接口稳定后串行合并 |
| C. Event ack/retention | OpenAPI 契约、HTTP ack、Web/Android ack、retention executor、compaction marker 展示 | `eventStore*`、客户端 API、OpenAPI | 契约冻结后，服务端 executor 与 Web/Android 客户端可并行；`db.js`/`server.js` 集成集中由一个 owner 合并 |
| D. Persistent search expansion | session/task/message 索引规模基准、查询调优和客户端消费 | `search*`、search tests | 持久增量索引与查询迁移已完成；后续规模验证可与 A、B、F 并行 |
| E. Provider scheduler | 持久任务队列、并发配额、retry/backoff、调度状态 API | `agents.js`、scheduler、Provider runtime | 设计与测试可并行；execution spawn、`server.js` 和 `db.js` 接线与 B/D/C 有共享热点，需单 owner 集成 |
| F. Product-side isolated work | Live Call 生产 ASR/弱网 QA、结构化测试结果树与单测重跑客户端接入 | 各自 runtime、tools 和客户端页面 | 各项彼此及与 A-E 基本独立，适合作为并行吞吐泳道 |

推荐第一波同时推进 A、B 的纯 adapter/mock、C 的契约设计，以及 F 中的一项；这一波不需要共享生产路由。第二波在契约冻结后并行实现 C 的服务端与客户端，同时让 B 接入 execution worker。D 和 E 都会集中修改 SQLite 与 Node control plane，若团队规模有限，应各自保持单 owner，并与 C/B 的集成提交错峰。最终端到端故障演练、OpenAPI 生成、全量 build 和 Windows portable 验证必须串行收口。
