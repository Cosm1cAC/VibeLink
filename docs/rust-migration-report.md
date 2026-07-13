# VibeLink Rust 迁移报告

最后更新：2026-07-12

本文是 Rust 迁移唯一的人工维护报告。机器可读状态保存在 `docs/rust-migration-status.json`，架构决策见 `docs/decisions/ADR-0001-rust-data-plane-sidecars.md`。

## 迁移原则

- Node 继续负责 HTTP API、认证、配对、审批、Provider 编排、REST/SSE 和产品状态机。
- Rust 只承接经过测量的高频、流式或 CPU/IO 热路径，优先使用 JSONL sidecar。
- 所有生产 Rust 路径必须保留 Node 或 Worker 回退；缺少二进制、健康检查失败、超时、无效 JSON 和进程退出都不能破坏用户任务。
- 状态按 `planned -> contract -> opt-in -> canary -> default-on` 推进。没有真实收益或代表性运行证据时不得升级。
- Android/Web 继续使用现有 HTTP/SSE 契约，不感知底层执行语言。

## 当前状态

| Slice | 状态 | 生产路由 | 下一步 |
| --- | --- | --- | --- |
| Workspace 目录扫描器 | `canary` | `auto`/显式开启，持久 sidecar | 有限交互会话后评估 default-on |
| MCP 持久 stdio 会话 | `canary` | `auto`/显式开启，持久 sidecar | 观察有限自然生产会话 |
| 事件存储 append/replay sidecar | `canary` | `auto`/显式开启，可回退 Worker/同步 SQLite | 有限真人运行会话并采集统计 |
| 实时音频低延迟管线 | `contract` | 无 | 仅在新证据表明 Node 成为瓶颈时重评 |
| 压缩与上下文预算辅助器 | `contract` | 无 | 仅在生产负载显著变化时重评 |

当前没有任何 slice 达到 `default-on`。Audio 和 Compression 不是“尚未接线”，而是测量结果明确不支持增加生产 sidecar 边界。

## Workspace Tree

实现：`src/workspaces.js`、`src/workspaceTreeSidecarClient.js`、`vibelink workspace-tree-sidecar`，一次性回退命令为 `vibelink workspace-tree`。

主要开关：

- `VIBELINK_RUST_WORKSPACE_TREE`
- `VIBELINK_RUST_WORKSPACE_TREE_SESSION`
- `VIBELINK_RUST_BIN`
- `VIBELINK_WORKSPACE_TREE_SIDECAR_MAX_PENDING_REQUESTS`

已覆盖 Node/Rust 路径、类型、排序、Windows metadata、根目录与嵌套 `.gitignore`、截断检测、签名缓存、内容缓存、背压和进程生命周期。持久 session 失败时依次回退到一次性 Rust CLI 和 Node `listDirectory()`；`auto` 模式找不到二进制时直接使用 Node，不记为 Rust 故障。

2026-07-12 的认证 HTTP canary 覆盖 `/tree`、`/context` 和 `/api/status`，得到 3 次 Rust miss、3 次缓存 hit、1 个 sidecar，失败、回退、pending 和背压拒绝均为 0。

晋级要求：有限交互会话继续保持支持子集完全一致、缓存正确失效、零失败/回退、pending 可排空，并保留 session -> one-shot -> Node 回滚链。

## MCP Persistent Sessions

实现：`src/mcpRuntime.js`、`vibelink mcp-session-sidecar`。

主要开关：

- `VIBELINK_MCP_RUST_SIDECAR`
- `VIBELINK_MCP_RUST_SIDECAR_COMMAND`
- `VIBELINK_MCP_RUST_SIDECAR_ARGS_JSON`
- `VIBELINK_MCP_SESSION_SIDECAR_MAX_ACTIVE_REQUESTS`
- `VIBELINK_MCP_PERSISTENT_SESSIONS`

已覆盖 initialize/tools 缓存、调用、超时、崩溃重建、多 server 并发、全局活动请求上限、客户端 pending 上限、背压和干净关闭。Rust readiness、probe 或 call 失败后回退现有 Node stdio 路径。

代表性结果：

- 单次 workload 将 MCP server spawn 从 13 次降到 1 次，减少 92.3%。
- 5 个独立 session 的 soak 将 spawn 从 65 次降到 5 次，5/5 干净结束。
- 认证 HTTP fixture canary 完成 1 次 probe 和 12/12 次调用，只启动 1 个 Rust sidecar 和 1 个 MCP server。
- 已安装的 codebase-memory 与 Headroom 均通过认证 HTTP 路径，各完成 3/3 次只读调用；失败、回退、pending 和背压拒绝均为 0。
- 产物不保存命令路径、登录 token、参数值或工具响应正文。

晋级要求：自然生产会话继续保持命令可用后的 readiness fallback 为 0、正常负载无背压、`tools/list` 可复用、pending 干净排空，并持续验证 `VIBELINK_MCP_RUST_SIDECAR=0` 回滚。

## Event Store

实现：`src/db.js`、`src/eventStoreSidecarClient.js`、`vibelink event-store-sidecar <db-path>`。

主要开关：

- `VIBELINK_EVENT_STORE_RUST_SIDECAR`
- `VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND`
- `VIBELINK_EVENT_STORE_RUST_SIDECAR_ARGS_JSON`
- `VIBELINK_EVENT_STORE_RUST_SIDECAR_TIMEOUT_MS`
- `VIBELINK_EVENT_STORE_WORKER` 及 task/tool/live-call batch 开关

已覆盖 task/tool/live-call 事件追加、统一事件与 replay 查询、只读模式、健康检查、超时、无效 JSON、进程退出、Worker/同步 SQLite 回退、批处理统计和服务端真实路由。约 1.01GB 现有数据库的只读 canary 在 9 组比较中保持完全一致。

门槛：

- readiness 后失败、回退、pending 和背压必须为 0。
- 本地 24 轮比较使用 10% trimmed mean；Rust append 不得比基线慢 10% 以上。CI 对低毫秒抖动额外允许 10ms margin。
- runtime canary 平均延迟上限为 50ms。
- server canary 的 500ms 是异常存活上限，不作为稳定性能样本。
- `GET /api/tool-events/stats` 用于真实会话前后对比，运行时统计在 bridge 重启后归零。

晋级要求：有限真人运行会话继续满足上述门槛，并保留 Rust -> Worker -> 同步 SQLite 回滚路径。

## 状态响应契约组装

实现：`src/statusRuntime.js`、`apps/windows/src/status_sidecar.rs`、`vibelink status-sidecar`。当前为 `opt-in`：Node 保留 Host/鉴权和动态状态采集，Rust 负责强类型校验及最终响应组装；首次 health、持久进程复用、超时、失败熔断和 Node 原快照回退均有自动测试。

认证 HTTP canary 连续请求 `/api/status`，要求匿名访问为 401、Rust readiness 成功、单一 sidecar、失败/回退/pending/背压均为 0。公网 canary 使用真实 HTTPS origin 和设备 token，校验 Rust runtime 计数增量、历史故障计数、pending 排空和公网 p95；token 只能通过 `VIBELINK_PUBLIC_CANARY_TOKEN` 环境变量传入，不进入命令行或 JSON 产物。完成有限公网请求观察后再评估 `canary`；各状态源迁入 Rust 后，同一契约处理器再提升为直接 HTTP 路由。

## Audio Pipeline

实现：`src/liveCallAudioPipeline.js` 的协议常量、`apps/windows/src/audio_pipeline_sidecar.rs`、`vibelink audio-pipeline-sidecar`。协议 v1 只处理确定性 PCM16 level/peak/RMS、序号、ring buffer 和背压，不包含 ASR、Provider、重采样或 VAD。

2026-07-12 的代表性测试中，Node 48kHz stereo -> 16kHz mono 重采样 p95 为 0.031-0.151ms，完整 2 秒 VAD 序列 p95 为 0.332ms；Rust JSONL RMS 往返 p95 为 0.290-0.641ms。Node 工作负载均低于 1ms 实质瓶颈阈值，Rust 也没有更快。

结论：保持 `contract`，不接入 live-call 生产路由。只有生产遥测或负载形态发生显著变化时才重新运行 benchmark。

## Compression

实现：`src/compressionContract.js`、`apps/windows/src/compression_sidecar.rs`、`vibelink compression-sidecar`。协议只提供 UTF-8 安全字节裁剪、日志首尾抽样和统计，不提供语义摘要或 Provider tokenizer 精度。

两次代表性 benchmark 中，约 1.01GB 数据库里最大的真实任务流经过当前 Node hot path 后 p95 为 0.253-0.353ms；1000 事件、200 万字符的合成上界为 0.425-0.547ms，均远低于 10ms 实质瓶颈阈值。

结论：保持 `contract`，`src/compactService.js` 和 `src/contextBudget.js` 继续作为生产权威实现。

## 验证命令

```bash
npm run rust:migration:check
npm run test:rust-sidecars

npm run status:server-canary -- --delete-temp
$env:VIBELINK_PUBLIC_CANARY_TOKEN="<device-token>"; npm run status:public-canary -- --base-url https://bridge.example.com --requests 10 --max-p95-ms 2000 --output .tmp/status-public-canary.json

npm run workspace-tree:canary
npm run workspace-tree:real-canary -- --workspace . --paths src,docs
npm run workspace-tree:server-canary -- --delete-temp

npm run mcp-session:canary
npm run mcp-session:server-canary -- --calls 12 --delete-temp
npm run mcp-session:real-canary -- --calls 3
npm run mcp-session:soak

npm run event-store:canary:all
npm run event-store:real-data-canary -- --limit 50

npm run audio-pipeline:benchmark
npm run compression:benchmark -- --require-real
```

六条独立 Windows workflow 分别覆盖 Status、Workspace、MCP、Event Store、Audio 和 Compression。相关文档或实现变更会触发对应 workflow，定时 canary 产物保留 30 天。

## 剩余计划

无需人工参与的代表性 canary、故障测试、回退测试和 CI gate 已基本齐备。剩余工作不是继续增加 sidecar，而是：

1. Status：有限公网请求及 runtime stats。
2. Workspace：有限交互会话。
3. MCP：有限自然生产会话。
4. Event Store：有限真人运行会话及前后 runtime stats。
5. Audio/Compression：等待新的瓶颈证据；没有证据时不推进。

## 全量控制面迁移与桌面发布

“全量 Rust 重写”采用 strangler 路线，不做一次性替换：

1. **桌面运行边界**：Rust launcher 已负责进程监督、包内 Node 解析、sidecar 命令注入、配对 QR、doctor 和命名 Cloudflare Tunnel 安全预检/监督。
2. **可分发包**：`npm run package:windows` 生成 Windows x64 portable ZIP，固定 Node LTS 与 cloudflared 版本，仅安装服务端生产依赖，并输出 SHA256。
3. **公网入口**：`vibelink tunnel --check-only` 必须验证固定 hostname、loopback upstream、Host allowlist、端口一致、legacy login 禁用和 404 fallback；通过后才允许运行 connector。
4. **HTTP 路由迁移**：后续按 status/doctor -> pairing/device -> settings/audit -> workspace/tool -> task/live-call 的顺序迁入 Rust。每批保留同一 OpenAPI、Android/Web 契约和 Node 回退。
5. **删除 Node**：只有路由使用统计为 0、契约/故障/回滚测试齐全、桌面包和公网 canary 连续通过后，才删除对应 Node 实现。最后一批路由移除后，portable 包才取消 Node runtime。

当前桌面包仍是经过验证的 Rust + Node 混合包，不宣称已经完成控制面全量重写。
