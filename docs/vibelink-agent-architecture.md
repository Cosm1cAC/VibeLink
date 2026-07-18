# VibeLink Agent 当前架构

最后更新：2026-07-18

本文只描述当前有效架构，并明确区分“已接入运行链路”和“已定义但尚未接入”的能力。产品差距见 `docs/product-status.md`，Rust 迁移证据见 `docs/rust-migration-report.md`，执行宿主设计见 `docs/decisions/ADR-0010-durable-execution-host.md` 与 `docs/execution-host-protocol.md`，HTTP 契约见 `docs/openapi.json`。

## 执行模式

### Codex Desktop Remote

用于遥控用户已安装并登录的 Codex Desktop。VibeLink 按需读取可见 transcript、恢复历史、定位会话、写入 composer 并验证发送结果。模型、权限、推理强度和审批策略由 Desktop 当前设置决定。

它不是 Agent Provider：不能接管已有进程，也不能获得 Desktop 未公开的完整 tool 输出、退出状态和 approval continuation。UI 自动化必须校验进程、窗口、目标会话、composer 和发送按钮，任一不匹配就 fail-closed。Desktop execution 固定视为 `external`、sampled fidelity。

### VibeLink Agent

VibeLink 自有的执行系统。当前 Provider adapter 由 Node 启动或恢复 Codex CLI、Claude、豆包 Web bridge 和 GLM 后端；VibeLink 统一负责任务、Workspace、工具事件、审批、历史恢复和审计。

需要确定模型、权限、网络、沙箱、工具归属或可靠移动端 catch-up 时，应使用 VibeLink Agent。当前子进程句柄仍属于 Node 内存，持久 execution worker 尚未进入运行链。

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
                               |-- task/provider orchestration
                               |-- remaining HTTP/SSE/WebSocket routes
                               |-- SQLite product state and event APIs
                               `-- Rust sidecars with Node/Worker fallback
```

普通 `vibelink.exe` 通过 `default_rust_profile` 启用前门和当前已迁移 route flags。每个 Rust slice 仍可独立关闭或在失败前回放 Node；写事务一旦被 Rust 认领则不能自动重放。`vibelink.exe bridge` 是直接 Node 回滚入口，源码开发的 `npm start` 也直接运行 `src/server.js`。

这仍是混合包，不代表 Node 已退出 control plane，也不代表 migration ledger 中的 canary/opt-in slice 已完成退休门槛。

## 模块边界

- `apps/windows/src/http_frontdoor.rs` 与各 `*_http.rs`：外部监听、Rust 原生路由、透明代理和逐 slice 回退。
- `src/server.js`：Node HTTP/SSE/WebSocket 路由、认证、限流和仍未迁移的产品编排。
- `src/agents.js` 与 Provider runtime：任务启动/resume、进程输出解析和事件归一化。
- `src/providerRegistry.js`：Provider readiness、capability、reasoning effort、模型目录及动态 catalog resolver contract。
- `src/db.js`、`src/eventStore*`：SQLite 产品状态、事件 cursor、查询和 Rust/Worker/同步回退。
- `src/executionPersistence.js`、`src/approvalOutbox.js`：未来 durable execution 的 binding/event cursor 与 approval delivery 持久化基础。
- `src/workspaces.js`、`src/terminalRuntime.js`：allowed roots 下的文件、上下文、Git、command 和 PTY；除已迁移的文件写路由外，execution 仍由 Node 持有。
- `src/mcpRuntime.js`：MCP 发现、probe、调用和持久 session 路由，可使用 Rust sidecar 并回退 Node stdio。
- `src/search.js`、`src/threadState.js`、`src/commandRegistry.js`、`src/reviews.js`：跨资源搜索、会话 metadata、全局动作目录和本地 review session。
- `apps/web` / `apps/android`：共享 HTTP/SSE/WebSocket 契约的 Web 和 Android 客户端。

## Provider Registry 与 Adapter

`/api/provider-registry` 是客户端选择 Provider、模型和推理强度的公共来源。当前 registry 覆盖 Codex、Claude、豆包和 GLM，并返回 availability/status/reason、capabilities、models、reasoning efforts 和 catalog metadata；Web、Android 和 Live Call 助手选择均消费这一结构。

Provider adapter 只处理后端特有能力：命令或 bridge、resume/session id、模型参数、流式输出和错误映射。以下能力必须留在 VibeLink：

- `tasks`、`tool_runs`、`tool_events` 和统一事件归属。
- sandbox、network、approval 和 trusted workspace 策略。
- Workspace/Git/Terminal/MCP 工具入口。
- Web/Android 的恢复、catch-up、通知和审计展示。

动态 catalog resolver 已实现输入清洗、最多 200 个模型、5 分钟 TTL cache、fresh/cached/stale/fallback 状态和最后成功结果回退；但 `src/server.js` 当前调用 `buildProviderRegistry` 时没有注入 resolver/runtime loader。因此生产响应仍使用内置 catalog，不能把 resolver 的单测能力描述成已完成的动态模型发现。

## 状态、搜索与事件

`.agent-mobile-terminal/mobile-agent.sqlite` 是产品结构化状态和事件 cursor 的权威来源。SQLite 保存 Workspace、设备、thread metadata/revision、task、task/tool/live-call event、approval、audit、Desktop observation，以及新增的 execution binding/host event/outbox 表。

Codex/Claude 原生 JSONL 仍是原始 Agent 历史来源，不整库复制到 SQLite。大附件、图片和完整 diff 不进入数据库。PR review 当前是例外，仍由 `src/reviews.js` 保存到 `reviews.json`；旧 `thread-state.json` 只在首次使用时兼容导入 SQLite。

Task、Tool 和 Live Call 事件通过数值 cursor 支持 REST catch-up 与 SSE 续传。Rust event-store/tool-events 路径与 Node/Worker/SQLite 回退共享同一外部契约。当前已有 cursor replay，但还没有端到端客户端 ack、统一 retention/compaction 或 durable worker spool quota。

`/api/search` 在请求时聚合 history、task、message 和 Workspace 文本文件，再应用 scope/tag/favorite 和 offset cursor。Workspace 搜索是同步有界扫描：跳过常见生成目录，单文件不超过 256 KiB，每个 Workspace 最多 1200 个文件；当前没有持久倒排索引。

Thread 标签、收藏和批量编辑写入 SQLite。每次变更增加 revision，并用 field revision 检测过期客户端对同一字段的冲突；add/remove tag 属于可合并操作。全局 command registry 只描述动作和参数，具体导航或 mutation 仍由 Web/Android 的 action router 执行。

## 当前执行持久化边界

代码已经具备 durable execution 的 Phase 1 数据基础：

- `execution_bindings` 记录 owner、status、attach state、worker/process identity、capabilities 和三个 host cursor。
- `execution_host_events` 要求 host sequence 连续，支持幂等 ingest、冲突检测、分页读取和单调 ack。
- `approval_requests` 增加 continuation、available decisions、decision version 和 delivery status。
- `approval_outbox` 用 operation id 去重，在一个 SQLite 事务中记录 decision、审批状态、审计 decision 和待投递命令，并支持 claim/retry/applied 状态流转。

这些 repository 目前只由数据库层和测试使用，尚未连接 Server route、Provider runtime 或 execution host。当前不存在 Rust `execd`、per-execution worker、named-pipe server、Job Object、ConPTY/stdio backend、事件 spool 或启动 reconciliation。Bridge 重启仍会丢失 Node 所持有的运行中子进程句柄。

ADR-0010 规定的目标边界保持有效：只有 VibeLink 从启动时拥有的 execution 才能承诺重连；worker crash 必须收敛为 `lost`；外部进程和 Desktop 永远不能伪装为 attachable；外部副作用结果不明确时返回 `OUTCOME_UNKNOWN`，不得自动重放。

## Codex app-server 边界

Windows 手工启动 `codex app-server --listen ws://127.0.0.1:<port>` 可工作；第二客户端只有在已有 rollout 后显式 `thread/resume`，才能收到后续 turn 流。

仓库已有两个不同层次的 probe：

- `src/codexAppServerProbe.js` 可手工启动真实 app-server，验证双客户端 start/resume 和 live delta，并保存诊断结果。
- `tools/codex-app-server/contract-probe.mjs` 生成实验 schema，并只接受已审查的 Codex CLI 0.117 协议面；缺少审批方法、schema 漂移、未审 minor 或超限输入都会 fail-closed。

当前没有 app-server Provider adapter，也没有 worker 持有其 JSON-RPC connection。CLI resume 仍是 VibeLink Agent 的稳定 Codex 路径，Desktop UIA 仍是独立的 sampled Remote 路径。

## 安全模型

- 文件操作必须通过 allowed roots 和已登记 Workspace 校验。
- 公网入口使用 pairing session、设备 token hash、过期/撤销、Host allowlist、限流和审计。
- Rust/Node 混合写路由遵循“认领前可回退、认领后不重放”，避免重复副作用。
- 高风险 VibeLink 工具返回 428 approval；现有受支持动作批准后可恢复执行，未来 upstream tool-call continuation 由 transactional outbox 投递。
- 凭据使用系统凭据库；Android 使用 Keystore 包装持久 token，设置文件不保存明文 API key。
- Desktop Remote 和浏览器自动化必须验证目标，不能因“尽量发送”而注入错误窗口。

## 近期架构任务

1. 实现 Rust `execd`、per-execution worker、Job Object、ConPTY/stdio backend、event spool 和 startup reconciliation。
2. 将 Terminal、Workspace command 和 Agent provider spawn 迁移到 execution host facade，同时保持现有 HTTP ID 和客户端契约。
3. 将 approval outbox 接到 schema-gated Codex app-server request，验证 decision delivered/applied 和 Bridge restart continuation。
4. 为 Provider registry 接入真实动态 catalog/health loader，并发布 execution ownership、capability 和 fidelity。
5. 补齐事件 ack/retention/compaction、多设备冲突和剩余 Rust route ownership；Node 只在所有产品职责通过观察与回滚门槛后退休。
