# VibeLink Rust 迁移报告

最后更新：2026-07-13

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
| 状态响应契约组装 | `canary` | 公网 bridge 显式开启，Node 快照回退 | 持续定时与自然请求观察后迁移直接 HTTP 路由 |
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

2026-07-13 的受控验证先通过纯 sidecar、真实仓库和认证 server canary：真实仓库 `src,docs` 的 18/18 项 metadata 与 context 完全一致，暖态为 8.4ms；server route 最大 38.4ms。随后公网认证会话覆盖 `/tree`、`/context` 和 `/api/status`，得到 3 次 Rust miss、3 次缓存 hit、1 个 sidecar，失败、回退、pending 和背压拒绝均为 0。公网 p95 为 6785.04ms，主要由 Cloudflare 往返和 context 传输主导，因此本轮只证明正确性与回退门槛，不据此晋级 `default-on`。

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
- 2026-07-13 针对已安装 `codebase-memory-mcp` 的真实 canary 完成 3/3 次 `get_architecture`，平均 33.3ms、最大 65.4ms；5 session x 12 calls soak 的 spawn 减少 92.3%。
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

已覆盖 task/tool/live-call 事件追加、统一事件与 replay 查询、只读模式、健康检查、超时、无效 JSON、进程退出、Worker/同步 SQLite 回退、批处理统计和服务端真实路由。1,154,035,712-byte（约 1.154GB）现有数据库的只读 canary 在 9/9 组比较中保持完全一致。

2026-07-13 的首个 24 轮冷样本受主机抖动影响，task append 比门槛慢 1.3ms；未放宽阈值，而是用两个独立 48 轮样本复核。两轮 Rust task/tool/live-call trimmed mean 分别为 2.6/2.9/2.7ms 与 2.5/2.7/2.7ms，均快于对应 Node 基线。24 x 100 x 3 runtime canary 平均为 3.2/3.3/2.8ms，失败和回退为 0。公网会话通过正式审批执行 3 次只读 `git status --short --branch`，`insertToolEvents` 增加 3、平均 4.6ms，失败、回退、pending 和背压均为 0。

门槛：

- readiness 后失败、回退、pending 和背压必须为 0。
- 本地 24 轮比较使用 10% trimmed mean；Rust append 不得比基线慢 10% 以上。CI 对低毫秒抖动额外允许 10ms margin。
- runtime canary 平均延迟上限为 50ms。
- server canary 的 500ms 是异常存活上限，不作为稳定性能样本。
- `GET /api/tool-events/stats` 用于真实会话前后对比，运行时统计在 bridge 重启后归零。

晋级要求：有限真人运行会话继续满足上述门槛，并保留 Rust -> Worker -> 同步 SQLite 回滚路径。

## 状态响应契约组装

实现：`src/statusRuntime.js`、`apps/windows/src/status_sidecar.rs`、`vibelink status-sidecar`。当前为 `canary`：Node 保留 Host/鉴权和动态状态采集，Rust 负责强类型校验及最终响应组装；首次 health、持久进程复用、超时、失败熔断和 Node 原快照回退均有自动测试。

认证 HTTP canary 连续请求 `/api/status`，要求匿名访问为 401、Rust readiness 成功、单一 sidecar、失败/回退/pending/背压均为 0。公网 canary 使用真实 HTTPS origin 和设备 token，校验 Rust runtime 计数增量、历史故障计数、pending 排空和公网 p95；token 只能通过 `VIBELINK_PUBLIC_CANARY_TOKEN` 环境变量传入，不进入命令行或 JSON 产物。

2026-07-13 在 `https://bridge.vibelink.cloud` 对提交 `5a04f25295b28da2cf54158edeb927f4440f76e4` 完成 10 次认证公网请求：attempt、Rust response 和 sidecar request 均增加 10，fallback、failure、timeout、backpressure 和 pending 均为 0，公网 p95 为 3678.07ms。当前 Cloudflare 网络往返主导总延迟，因此本轮使用 5000ms 异常上限；进入直接 HTTP 路由前必须以同一网络基线做 20% 回归比较。下一步是保持定时 canary 和自然请求稳定，再迁移 Status/Doctor 的直接 Rust HTTP 所有权。

## 可复现 Canary 启动配置

提交 `981fc5ebcfd1ee90bdfead13b0e76cacb005c8a5` 为 Windows launcher 增加全局 `--rust-canary`，portable 包同时生成 `start-vibelink-canary.cmd`。该配置只为未显式设置的变量启用当前 Status、Workspace、MCP、Event Store 与三个事件 batch canary，现有环境覆盖仍优先，普通 `vibelink.exe` 默认行为不变。

对应 Windows x64 ZIP SHA256 为 `61841ac3f92ea70dd65f07bbcc0698c969595037df67a4f93bfcbe62d1e45c3a`。公网 bridge 当前由该包的 `vibelink.exe --rust-canary bridge --host 0.0.0.0 --port 8787` 监督；暖态认证探针确认 Status、Workspace 和 Event Store ready，MCP persistent session/sidecar 可用，全部 pending、failure 和 fallback 为 0，三个事件 batch 开关均已启用。新包下 5 次认证公网 Status canary 的 p95 为 2020.43ms，Rust attempt/response 各增加 5，错误计数仍为 0。公网根路径为 200，未认证本地/公网 status 均为 401，配对 token 日志保持隐藏。

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

1. Status：保持公网 canary 与 runtime stats 稳定，准备直接 Rust HTTP 路由契约。
2. Workspace：扩大自然交互观察窗口。
3. MCP：完成自然生产会话观察；受控真实/soak 证据已通过。
4. Event Store：扩大自然运行窗口并持续采集前后 runtime stats。
5. Audio/Compression：等待新的瓶颈证据；没有证据时不推进。

## 全量控制面迁移与桌面发布

“全量 Rust 重写”采用 strangler 路线，不做一次性替换：

1. **桌面运行边界**：Rust launcher 已负责进程监督、包内 Node 解析、sidecar 命令注入、配对 QR、doctor 和命名 Cloudflare Tunnel 安全预检/监督。
2. **可分发包**：`npm run package:windows` 生成 Windows x64 portable ZIP，固定 Node LTS 与 cloudflared 版本，仅安装服务端生产依赖，并输出 SHA256。
3. **公网入口**：`vibelink tunnel --check-only` 必须验证固定 hostname、loopback upstream、Host allowlist、端口一致、legacy login 禁用和 404 fallback；通过后才允许运行 connector。
4. **HTTP 路由迁移**：后续按 status/doctor -> pairing/device -> settings/audit -> workspace/tool -> task/live-call 的顺序迁入 Rust。每批保留同一 OpenAPI、Android/Web 契约和 Node 回退。
5. **删除 Node**：只有路由使用统计为 0、契约/故障/回滚测试齐全、桌面包和公网 canary 连续通过后，才删除对应 Node 实现。最后一批路由移除后，portable 包才取消 Node runtime。

当前桌面包仍是经过验证的 Rust + Node 混合包，不宣称已经完成控制面全量重写。
