# VibeLink Rust 迁移报告

最后更新：2026-07-15

本文是 Rust 迁移唯一的人工维护报告。机器可读状态保存在 `docs/rust-migration-status.json`，架构决策记录在 `docs/decisions/ADR-0001` 至 `ADR-0008`。

## 迁移原则

- Rust canary 已可负责外部 TCP/HTTP 监听；Node 退到 loopback backend，继续负责尚未迁移的 HTTP API、认证、配对、审批、Provider 编排、REST/SSE 和产品状态机。
- 迁移阶段继续用测量决定 sidecar 是否值得接入；最终桌面包要求所有产品必需的 HTTP/SSE/WebSocket、Provider、事件和实时通话职责都由 Rust 所有，不能以性能收益不足为由永久保留捆绑 Node。
- 所有生产 Rust 路径必须保留 Node 或 Worker 回退；缺少二进制、健康检查失败、超时、无效 JSON 和进程退出都不能破坏用户任务。
- 状态按 `planned -> contract -> opt-in -> canary -> default-on` 推进。没有真实收益或代表性运行证据时不得升级。
- Android/Web 继续使用现有 HTTP/SSE 契约，不感知底层执行语言。
- 不新增 Web 管理后台；未来桌面管理壳使用原生 Win32 `windows-rs`，不嵌 WebView。

## 当前状态

| Slice | 状态 | 生产路由 | 下一步 |
| --- | --- | --- | --- |
| Rust HTTP 前门 | `canary` | Rust 外部监听，Node loopback backend | 验证 Status/Doctor/Devices opt-in 不影响透明转发流量 |
| 状态响应契约组装 | `canary` | 公网 bridge 显式开启，Node 快照回退 | 继续作为 Status 动态快照强类型契约层 |
| Status 原生 HTTP 路由 | `opt-in` | Rust Host/鉴权/状态码/响应，Node 仅供受保护快照 | 远端 CI 与公网拒绝路径已通过；待受控公网认证成功路径后晋级 |
| Doctor 原生 HTTP 路由 | `opt-in` | Rust Host/鉴权/状态码/响应，Node 保留受保护诊断执行器 | 远端 CI 与公网拒绝路径已通过；待受控公网认证成功路径后晋级 |
| Devices 只读原生 HTTP 路由 | `opt-in` | Rust Host/鉴权/SQLite 查询/字段过滤；写操作由独立 Rust slice 接管 | 远端 CI 与公网拒绝路径已通过；待受控公网认证读取证据后晋级 |
| Devices 审计化写操作原生 HTTP 路由 | `opt-in` | Rust 令牌轮换/吊销、限流和事务化审计 | 远端 CI、便携包和公网拒绝路径已通过；待受控公网认证写入证据后晋级 |
| Pairing 原生 HTTP 路由 | `opt-in` | Rust create/status/list/approve/deny/claim，Node 仅供提交前 settings 快照 | 远端 CI、便携包和公网拒绝路径后保持观察 |
| Audit Log 原生 HTTP 路由 | `opt-in` | Rust 鉴权、拒绝审计、游标分页、字段投影 | 远端 CI、便携包与公网拒绝路径后保持观察 |
| Settings 原生 HTTP 路由 | `opt-in` | Rust 校验/dry-run/导入导出/原子写入/DPAPI/审计；Node 仅做受保护内存重载 | 公网拒绝路径已通过；等待远端 CI、便携包与受控公网认证成功路径 |
| Workspace 目录扫描器 | `canary` | `auto`/显式开启，持久 sidecar | 有限交互会话后评估 default-on |
| Workspace 文件写操作原生 HTTP 路由 | `opt-in` | Rust allowed-root 文件操作，Node 回退 | 继续迁移 Git/command/approval |
| 统一事件同步原生 HTTP 路由 | `opt-in` | Rust unified replay、设备 ack、retention/compaction 与 marker | 远端 CI、便携包和受控公网认证 canary |
| MCP 持久 stdio 会话 | `canary` | `auto`/显式开启，持久 sidecar | 观察有限自然生产会话 |
| 事件存储 append/replay sidecar | `canary` | `auto`/显式开启，可回退 Worker/同步 SQLite | 有限真人运行会话并采集统计 |
| 实时音频低延迟管线 | `contract` | 无 | 仅在新证据表明 Node 成为瓶颈时重评 |
| 压缩与上下文预算辅助器 | `contract` | 无 | 仅在生产负载显著变化时重评 |

当前没有任何 slice 达到 `default-on`。Audio 和 Compression 不是“尚未接线”，而是测量结果明确不支持增加生产 sidecar 边界。

## Rust HTTP 前门

实现：`apps/windows/src/http_frontdoor.rs`、`src/runtimeBinding.js`、`src/supervisorMonitor.js`，显式入口为 `vibelink.exe --rust-canary --rust-http-canary` 或 `start-vibelink-http-canary.cmd`。

Rust 在 canary 模式下直接占用外部 `host:port`，Node 只绑定每次启动重新分配的 `127.0.0.1` 端口。前门逐字节双向转发非迁移 HTTP、SSE 和 WebSocket 连接，限制最多 256 条活动连接，上游 2 秒不可达时返回不含内部细节的 JSON `503`。关闭 `--rust-http-canary` 后 Node 立即恢复直接监听；Rust 进程退出时，Node 通过 supervisor PID 监控执行现有排空逻辑，避免孤儿进程。

2026-07-13 的本地进程验证覆盖 Keep-Alive、页面、未认证 API、SSE、WebSocket Upgrade、非法 Host、认证 Status/Doctor、连续 ephemeral 端口重启、全新设置目录和关闭前门后的 Node 直接监听回滚。两个首次发现的问题——Windows accepted socket 继承 nonblocking 导致 `WSAEWOULDBLOCK`，以及 persisted port 覆盖新 ephemeral port——均先以失败测试复现，再修复并通过回归。

公网部署使用提交 `ec2a26311102e225001874bccedee86851641120`，Windows x64 ZIP SHA256 为 `6a6749d7b1d704ce935c0984d8b3e1d08eb07d2831804720a72bace24001cf42`。`8787` 当前由 Rust 前门监听，Node 仅监听 `127.0.0.1:50369`；公网根路径为 200，未认证 Status 为 401，认证 Status 5/5 通过且 p95 为 3275.1ms，Doctor 返回 24 项检查，失败、回退、超时、背压和 pending 均为 0。Rust 前门观测时 Working Set 约 6.7MiB、Private Memory 约 1.1MiB，错误日志为空，配对 token 日志保持隐藏。

2026-07-14 已将公网 canary 更新到提交 `35b3c864731dd83e687085271e07ad0701e8c644`，同时显式开启 `--rust-status-http` 与 `--rust-doctor-http`。Windows x64 ZIP SHA256 为 `198d726eacdc96009d30c77fcfaae89980d2945cf839d00447f9eb90820bd138`，`8787` 由新 Rust 前门监听，Node 仅监听 `127.0.0.1:60590`。公网根路径连续 3/3 返回 200；Status 与 Doctor 未认证请求均返回带 `X-VibeLink-Control-Plane: rust` 的 401，未迁移的 Tool Registry 请求不带该响应头并继续由 Node 处理。部署后 Rust Working Set 约 12.2MiB、Private Memory 约 1.2MiB，错误日志为空，配对 token 日志保持隐藏；旧 `ec2a2631110` release 目录继续保留用于进程级回滚。

同日公网 canary 继续更新到提交 `55048a441c2e3332f534b0012915f1f0a25b3f7e`，新增 `--rust-devices-http`。Windows x64 ZIP SHA256 为 `e278927c5c3f6a931e41432ab6354cd6fb3d9f830c36c65148d7f4c2e976f174`；Node 仅监听 `127.0.0.1:58400`。公网根路径返回 200，Status、Doctor、Devices 未认证请求均由 Rust 返回 401，Tool Registry 继续由 Node 返回且不带 Rust 所有权头。部署后 Rust Working Set 约 7.8MiB、Private Memory 约 1.2MiB，错误日志为空；首次探针脚本因 PowerShell header API 不兼容自动回滚成功，修正探针后再次滚动成功，证明上一 release 的进程级回滚可用。

2026-07-15 在当前分支提交 `0df73850f694621288ff9c353a77b2da03690b15` 上重建 release，并显式开启 Status、Doctor、Devices、Device Mutations、Pairing、Audit 与 Settings 七组 Rust 路由。发布前 71 项 Rust 单测、`clippy -D warnings`、13 项 Rust HTTP 合同和累计 39 项 release HTTP canary 全部通过；官方 npm registry 的生产依赖审计为 0 漏洞。切换后 Rust PID `28792` 监听 `0.0.0.0:8787`，Node PID `32376` 仅监听 `127.0.0.1:61042`，既有命名 Cloudflare Tunnel 保持活动连接。Rust/Node/cloudflared 的 Working Set 分别约为 7.6/76.0/24.0MiB，Private Memory 分别约为 1.3/81.7/67.2MiB；这些数字记录混合运行时总成本，不代表纯 Rust 内存结论。公网根路径连续 3/3 返回 200，Status 匿名请求连续 3/3 返回带 Rust 所有权头的 401，Settings export 匿名请求返回带 Rust 所有权头的 401，Tool Registry 继续由 Node 返回且无该头；观测请求为 918-1616ms，错误、回退和敏感日志均未出现。由于生产环境仍不保存设备明文 token，本轮没有伪造认证成功请求，所有直接路由继续保持 `opt-in`。

该 slice 只证明外部监听、隔离与透明转发已 Rust 化；Status、Doctor、Devices 需分别开启独立路由开关才计为直接 Rust HTTP 所有权。

### Status 原生 HTTP 路由

`--rust-status-http` 仅在 Rust HTTP 前门开启时生效。Rust 对 `GET /api/status` 执行 64KiB 有界解析、Host allowlist、SQLite 设备 token 鉴权和最终 JSON 响应；Node 只通过 loopback-only、进程随机 token 保护的 `/internal/status-snapshot` 提供动态快照。内部 JSON 采用 16MiB 流式上限；读取、超限、快照或强类型校验失败时，前门逐字节重放原请求给 Node。关闭该独立开关即可恢复全量透明转发。

2026-07-13 本地真实进程 canary 经 Rust 前门完成代理登录、一次 Rust 匿名拒绝、三次认证 Status 和一次 Node Doctor 转发。Rust Status failure、fallback、pending 均为 0，Doctor 返回 24 项检查。远端 Windows CI 已通过；该 slice 当前为 `opt-in`，待公网认证 canary 通过后晋级 `canary`。

2026-07-14 的 release canary 与远端 Windows CI 再次完成代理登录、Rust 匿名拒绝和三次认证 Status；本地 runtime 为 8/8 响应，failure、fallback、pending 均为 0。相同提交已部署公网并证明 Rust 拒绝路径和 Node 非迁移路由隔离；由于部署环境没有可用于自动探针的设备明文 token，本轮不把该 slice 晋级为 `canary`。

### Doctor 原生 HTTP 路由

`--rust-doctor-http` 仅在 Rust HTTP 前门开启时生效。Rust 对 `GET /api/doctor` 执行与 Status 相同的有界解析、Host allowlist 和 SQLite 设备鉴权，再通过 loopback-only、进程随机 token 保护的 `/internal/doctor-report` 调用现有诊断执行器。Node 继续负责 24 项平台探测、`system.doctor` tool run 和审计写入；Rust 在共享的 16MiB 内部 JSON 上限内校验报告契约、附加 `controlPlaneRuntime.doctorHttp` 指标并生成最终 HTTP 响应。关闭独立开关或内部执行失败时恢复 Node 路由。

2026-07-13 本地 debug 与 release 真实进程 canary 均通过一次 Rust 匿名拒绝和一次认证 Doctor，返回 24 项检查；attempts/responses 为 2/2，failure、fallback、pending 为 0。canary 同时回查 `toolRunId` 和 `system.doctor` 审计记录，设备 ID 与 `/api/doctor` 路径均保持。该 slice 当前为 `opt-in`，待远端 CI 与公网认证 canary 通过后晋级。

2026-07-14 的本地 release canary 与远端 Windows CI 再次通过 Rust 匿名拒绝、认证 Doctor、24 项检查、`system.doctor` tool run 和审计回查；attempts/responses 为 2/2，failure、fallback、pending 为 0。公网部署已证明 Rust 401 所有权和非迁移路由隔离，但尚缺设备 token 的公网成功响应证据，因此继续保持 `opt-in`。

### Devices 只读原生 HTTP 路由

`--rust-devices-http` 仅在 Rust HTTP 前门开启时生效。Rust 对精确的 `GET /api/devices` 复用 Status 的有界解析、Host allowlist 和 SQLite 设备鉴权，随后以只读连接直接查询公开设备字段，计算过期状态，并保持 `currentDeviceId`、活动时间排序、`meta` JSON 与嵌套 `fields` 过滤契约。查询不读取 `token_hash`；配对、撤销和令牌轮换由各自独立的 Rust opt-in slice 处理。

2026-07-14 的本地 release canary 与远端 Windows CI 完成代理登录、Rust 匿名拒绝、认证设备列表和 `fields=id,label` 过滤，返回当前设备且所有直接响应均带 Rust 所有权头；`controlPlaneRuntime.devicesHttp` 为 3/3 响应，failure、fallback、pending 均为 0。配置、数据库或映射错误会由前门逐字节回放原请求给 Node。相同提交已部署公网并证明 Rust 拒绝路径与 Node 非迁移路由隔离；尚缺生产设备 token 的公网成功响应，因此该 slice 继续保持 `opt-in`。

### Devices 审计化写操作原生 HTTP 路由

`--rust-device-mutations-http` 仅在 Rust HTTP 前门开启时生效，独立接管当前设备和指定设备的 token 轮换，以及指定设备吊销。轮换生成 32 字节随机值并只保存 SHA-256，明文 token 只在成功响应中出现；有效期、每目标每 IP 十分钟六次的限流头、目标不存在的 `404` 以及吊销的 `200 {ok:false}` 均保持 Node 合同。设备变更与审计记录位于同一 SQLite immediate transaction。

写路由采用比读路由更严格的回退边界：设置或数据库尚未初始化时可继续转发 Node；Rust 完成鉴权并认领请求后，数据库、审计、序列化或 socket 错误都不得回放同一请求。故障注入使用缺列审计表证明吊销更新会回滚、客户端收到 Rust `500` 且 Node upstream 未接收请求。关闭开关后，后续请求恢复 Node 所有权。

2026-07-14 本地 release 真实进程 canary 完成 Rust 匿名拒绝、连续六次当前设备轮换、第七次 `429`、旧 token `401`、新 token 继续认证、另一设备首次吊销 `true` 和再次吊销 `false`。审计回查得到六条成功 `device.rotate`、一条 `rate_limit` 和两条 `device.revoke`；全部直接响应带 Rust 所有权头。

同一切片提交 `43e03fc4efc72dba9044b8d3914559b935d75029` 的 6 条远端 workflow 全部通过，Status workflow 包含新增的真实设备写 canary。Windows x64 portable ZIP SHA256 为 `281cd6e15ba3eece6b06524473c5f53419484bcf3328e942287e05512ad725c2`，包内 `vibelink.exe` SHA256 为 `da38fcf70a1c49c046d50d6e1902959d1d9a5a230c1b1e5ceb55355cd3f994d6`；release manifest 和累计启动器均指向该提交，包内二进制再次通过完整 canary。

部署首次启动未显式继承生产 `VIBELINK_DATA_DIR`，新旧 release 都会读取 `%LOCALAPPDATA%\VibeLink` 的无公网 allowlist 设置并返回 `403`；实际回滚和显式数据目录恢复已验证。最终进程显式使用项目 `.agent-mobile-terminal` 数据目录，`43e03fc` Rust 前门监听 `0.0.0.0:8787`，Node 仅监听 `127.0.0.1:57102`。公网 Status 和设备写匿名请求连续返回带 Rust 所有权头的 `401`，Tool Registry 仍由 Node 返回且无该头；Rust 错误日志为空。Cloudflare 重启后的短暂旧连接响应通过连续探针排除。由于生产环境不保留明文设备 token，本轮不执行或伪造公网认证写操作，slice 保持 `opt-in`。

### Pairing 原生 HTTP 路由

`--rust-pairing-http` 第一阶段接管公开 `GET /api/pairing-sessions/:id`、认证 `GET /api/pairing-sessions` 以及 approve/deny。公开轮询只执行设置/数据库/Host 前置检查，不因附带 token 改写设备 `last_seen`；过期 `pending` 映射、stored-status 过滤、20 条上限、嵌套 `fields`、每 IP/session 每分钟 60 次轮询限流均保持 Node 合同。批准/拒绝与审计位于同一 SQLite immediate transaction，认领后失败不回放 Node。

create/claim 使用 1 MiB 有界 `Content-Length` body reader；已读取 body 始终追加到原请求 prefix，unsupported transfer encoding、非法长度和超限 body 在 canary 阶段仍可完整回放 Node。创建由 Rust 生成 UUIDv4、六位大写 code、五分钟 expiry 和 220px SVG QR；领取在事务前通过 loopback-only、进程随机 token 保护的 `/internal/public-settings` 取得安全设置投影，再原子创建 90 天设备 token、更新 session 并写审计。code/token 明文只出现在各自单次响应，SQLite 只保存 SHA-256。

完整 release canary 已完成 Rust create、pending status、认证 list、approve、claim 和 claimed status；批准与领取审计连续可查，旧 Node create/claim 不再处理正常 Web/Android `Content-Length` 请求。分片 body 测试证明跨 TCP read 的 JSON 可正确拼合并保留重放字节，故障注入继续证明认领后的决策/审计失败会回滚且不触达 Node。前门可选路由同时重构为 `FrontdoorRoutes` 配置对象，避免后续迁移继续扩张函数参数列表。

完整 Pairing 提交 `515032dc5c0f73663979d7a2c4da501a45c39d98` 的 6 条远端 workflow 全部通过；Workspace Tree workflow 首轮仅因共享 Windows runner 的 warm p95 72.9ms 超过 50ms 阈值失败，所有功能检查通过，失败任务重跑通过，本机 10/30 次 warm workload 均为 2.3ms p95。Windows x64 portable ZIP SHA256 为 `431894c733e3c5038761143f2c08802cf9840925c5bb781dcf09577ebc98223f`，包内 `vibelink.exe` SHA256 为 `972f7d7dc19c44af97efe539b8ded4bd989eb7b9adc77d9152eec3026c3132d7`；release manifest 指向同一提交，包内完整 28 项 HTTP canary 全部通过。

生产切换继续显式使用项目 `.agent-mobile-terminal` 数据目录。`515032d` Rust 前门 PID `34920` 监听 `0.0.0.0:8787`，Node fallback PID `15588` 仅监听 `127.0.0.1:60487`；Rust working set 约 12.5 MiB、private bytes 约 1.4 MiB，错误日志为空。公网随机不存在 Pairing session 连续 5 次返回 `404` 且带 Rust 所有权头，Status 返回 `401` 且带 Rust 所有权头，Tool Registry 仍由 Node 返回且无该头。为避免产生生产配对记录，本轮没有调用公开 create/claim；其完整写路径由隔离数据目录中的包内 canary 覆盖。该 route family 保持 `opt-in` 观察。

### Audit Log 原生 HTTP 路由

`--rust-audit-http` 接管认证 `GET /api/audit-log`，保持 `cursor > after`、cursor 倒序、默认 200 条、嵌套 `fields` 和 `{ items }` 响应合同。Rust 使用只读参数化 SQLite 查询，将 nullable 文本映射为空字符串、success 映射为布尔值，并与 Node 一样保留合法 JSON meta、仅把无效 JSON 或 `null` 映射为 `{}`。`after` 归一为非负整数，`limit` 限制为 1–5000，关闭旧 Node `LIMIT -1` 可触发的无界读取。

Host 或设备鉴权失败由 Rust 写入 `host.blocked`/`auth.failed` 后返回拒绝响应，转发 IP 仅取第一项。初始化、鉴权存储、拒绝审计或读取失败发生在响应所有权之前，因此前门可完整回放 Node。模块单测覆盖游标/limit/fields、拒绝审计和未就绪回退，真实 release canary 已验证 Rust `401`、最新拒绝审计读取和严格 after 空页。

Audit 提交 `841a3dbcfa4a4df0a9498ae084657ce697a7b8ae` 的 6 条远端 workflow 全部通过，包内累计 31 项 HTTP canary 全绿。Windows x64 portable ZIP SHA256 为 `df577c591a64ce11cb70cc1790d35b61251fef984f14d9da4894ab2d7f8ba66c`，包内 `vibelink.exe` SHA256 为 `d79b3b524c7400fba90e5f873d71e9279dc36817966d0ef1ac09119a36f4acae`，manifest 和累计启动器均指向该提交及 Audit flag。

首次生产切换在 Rust 前门已经可响应时过早检查 Node listener；1.2GB SQLite 恢复尚未完成，部署脚本按计划自动回滚到 `515032d`，公网保持健康。就绪条件修正为同时等待 Rust 路由和 loopback Node 最长 60 秒后，重试成功：`841a3db` Rust PID `36760` 监听 `0.0.0.0:8787`，Node PID `17732` 仅监听 `127.0.0.1:51751`；Rust working set 约 7.9 MiB、private bytes 约 1.2 MiB，错误日志为空。公网 Audit 匿名请求连续返回 `401` 且带 Rust 所有权头，该路由保持 `opt-in` 观察。

### Settings 原生 HTTP 路由

`--rust-settings-http` 累计接管 `POST /api/settings`、`GET /api/settings/export` 和 `POST /api/settings/import`。Rust 移植字段校验、清洗、MCP `configured` secret placeholder 合并、导入导出 allowlist、changed keys、公共设置投影和 dry-run；导出不包含 API key、通知邮箱、VAPID 公私钥或 MCP env/header 值。写请求通过共享 mutex 串行化，`settings.json` 使用已同步临时文件同目录替换，落盘前强制清空 API key。

Windows API key 与 FCM 服务账号继续使用当前用户 DPAPI，Rust 显式加载系统 `Microsoft.PowerShell.Security` 模块，明文只通过子进程环境传递。设置文件和每个受影响的 `.dpapi` 文件在写入前分别快照；Node 内存重载或审计失败时全部恢复。Rust 读取 mutation body 后拥有请求，后续失败只返回 Rust `500`，绝不向 Node 重放；故障测试和并发测试分别证明文件回滚及两个同时写入的事务串行提交。

混合阶段的 Node 仍有未迁移路由缓存 `settings`，因此 Rust 成功落盘后调用随机内部 token 保护、仅 loopback 可达的 `POST /internal/reload-settings`。该端点只重新载入兼容内存副本和执行现有通知设置归一化，不是 Web 管理后台，也不负责公开请求的验证、凭据或审计策略。删除 Node 前必须把通知密钥初始化迁入 Rust 并删除该兼容端点。

本地 71 项 Rust 单测全绿；完整 release HTTP canary 累计通过 39 项检查，其中 Settings 覆盖匿名 `401`、无 secret 导出、无落盘 dry-run、DPAPI 更新、导入预览/提交、三类成功审计和受控关闭。2026-07-15 的公网切换进一步证明 Settings export 匿名请求由 Rust 拒绝，未迁 Tool Registry 仍由 Node 透明处理；当前仍缺远端 CI、可分发包和受控公网认证成功路径，因此该 route family 继续保持 `opt-in`。

### Tool Events 非流式原生 HTTP 路由

`--rust-tool-events-http` 仅在 Rust HTTP 前门开启时生效，并只接管精确的非流式 `GET /api/tool-events`。Rust 保持 `cursor > after` 升序回放、`Last-Event-ID` 后备游标、`toolRunId`/`workspaceId`/`taskId` 过滤、默认 500/最大 5000 条、嵌套 `fields` 和 `{ items }` 响应合同。事件存储 sidecar 与 HTTP route 共同依赖 `tool_events_store.rs` 的参数化 SQL 和 event JSON/cursor 映射；HTTP 数据查询使用只读 SQLite 连接，不复制第二份查询实现。

Host 与设备鉴权继续复用 Rust 控制面前置检查，`host.blocked`/`auth.failed` 拒绝审计在返回 `403`/`401` 前写入。设置、鉴权存储、审计、schema 或查询失败均发生在响应所有权之前，前门会逐字节回放原请求。`stream=1` 在匹配前排除，因此 SSE 订阅、live append 通知和断开清理仍由 Node 负责；关闭独立开关后所有 Tool Events 请求恢复 Node 所有权。

2026-07-16 的隔离 release 单路由 canary 为 12/12；累计开启 Status、Doctor、Devices、Pairing、Audit、Settings 与 Tool Events 的 canary 为 44/44。验证覆盖 Rust 匿名拒绝、真实 SQLite fixture 的认证过滤/投影、严格 after 空页、Node `text/event-stream` 所有权、拒绝审计、与其他路由的组合顺序和受控关闭。默认 release 二进制正被公网服务占用，因此验证使用独立 `CARGO_TARGET_DIR`，没有停止或替换公网进程。该 slice 当前为 `opt-in`：正常 JSON replay 少经过 Node HTTP、Worker 选择和 JSONL 跳数，但 Node 仍因 SSE 与其他路由常驻，单独启用不会显著降低整机常驻内存。

### 统一事件同步原生 HTTP 路由

`--rust-event-sync-http` 接管 `/api/events/unified`、ack/retention-plan/compaction-marker 读取，以及 ack/compact 写操作。ack 的设备身份只取认证结果，忽略 body 中的 `deviceId`；`expectedCursor` 提供设备内 CAS 冲突检测。retention 的安全游标取所有未撤销、未过期设备的最小 ack，任何未 ack 的有效设备都会阻止删除；task、live-call 与 tool-event 压缩和 marker 写入共享 Rust event-store core。

Rust 对 ack 与 compact 分别执行每分钟 240/20 次的设备级限流并返回标准限流头，成功写和限流拒绝均进入审计。mutation body 被 Rust 有界读取后即认领，后续存储或审计失败返回 Rust 4xx/500 且绝不重放 Node。quota 超限仍受安全游标约束，并写入 `spool_quota` marker；关闭开关后请求恢复 Node 所有权。2026-07-20 本地 110 项 Rust 测试和 Node event-store 契约通过，当前保持 `opt-in` 等待远端、包内与公网 canary 证据。

## Workspace Tree

### Workspace File Mutations

`--rust-workspace-http` 接管认证 `POST /api/workspaces/:id/file` 的 write、delete 和 rename。Rust 从 SQLite 读取 workspace root，执行 canonical allowed-root 校验、1MiB JSON/text 上限、父目录创建与文件操作，并写入 `workspace.file` audit 记录；路径穿越、绝对路径、非文件目标和冲突目标均拒绝。请求解析、数据库未就绪或 Rust 操作失败时，前门保留原始请求并回退 Node。

当前本地 78 项 Rust 测试覆盖文件写入、重命名、删除、路径穿越拒绝和现有控制面回归。该切片已纳入默认 `vibelink.exe` Rust 前门 profile；Git/command/approval 仍由 Node 负责，直到后续 workspace/tool slices 完成。

实现：`src/workspaces.js`、`src/workspaceTreeSidecarClient.js`、`apps/windows/src/workspace_tree.rs`、`vibelink workspace-tree-sidecar`，一次性回退命令为 `vibelink workspace-tree`。

主要开关：

- `VIBELINK_RUST_WORKSPACE_TREE`
- `VIBELINK_RUST_WORKSPACE_TREE_SESSION`
- `VIBELINK_RUST_BIN`
- `VIBELINK_WORKSPACE_TREE_SIDECAR_MAX_PENDING_REQUESTS`

已覆盖 Node/Rust 路径、类型、排序、Windows metadata、根目录与嵌套 `.gitignore`、截断检测、签名缓存、内容缓存、背压和进程生命周期。持久 session 失败时依次回退到一次性 Rust CLI 和 Node `listDirectory()`；`auto` 模式找不到二进制时直接使用 Node，不记为 Rust 故障。

2026-07-13 的受控验证先通过纯 sidecar、真实仓库和认证 server canary：真实仓库 `src,docs` 的 18/18 项 metadata 与 context 完全一致，暖态为 8.4ms；server route 最大 38.4ms。随后公网认证会话覆盖 `/tree`、`/context` 和 `/api/status`，得到 3 次 Rust miss、3 次缓存 hit、1 个 sidecar，失败、回退、pending 和背压拒绝均为 0。公网 p95 为 6785.04ms，主要由 Cloudflare 往返和 context 传输主导，因此本轮只证明正确性与回退门槛，不据此晋级 `default-on`。

晋级要求：有限交互会话继续保持支持子集完全一致、缓存正确失效、零失败/回退、pending 可排空，并保留 session -> one-shot -> Node 回滚链。

## MCP Persistent Sessions

实现：`src/mcpRuntime.js`、`apps/windows/src/mcp_session_sidecar.rs`、`vibelink mcp-session-sidecar`。

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

实现：`src/db.js`、`src/eventStoreSidecarClient.js`、`apps/windows/src/event_store_sidecar.rs`、`vibelink event-store-sidecar <db-path>`。

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

portable 包的累计 HTTP 入口按迁移顺序保留，并由 `start-vibelink-tool-events-http-canary.cmd` 启用当前全部 Rust HTTP opt-in 路由；打包器支持显式 `CARGO_TARGET_DIR`，因此可以在现网默认 release 二进制被占用时从隔离 target 构建，不需要先停止服务。

对应 Windows x64 ZIP SHA256 为 `61841ac3f92ea70dd65f07bbcc0698c969595037df67a4f93bfcbe62d1e45c3a`。该包此前以 `vibelink.exe --rust-canary bridge --host 0.0.0.0 --port 8787` 监督公网 bridge；暖态认证探针确认 Status、Workspace 和 Event Store ready，MCP persistent session/sidecar 可用，全部 pending、failure 和 fallback 为 0，三个事件 batch 开关均已启用。该阶段 5 次认证公网 Status canary 的 p95 为 2020.43ms，Rust attempt/response 各增加 5，错误计数仍为 0。公网根路径为 200，未认证本地/公网 status 均为 401，配对 token 日志保持隐藏。

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
npm run rust-http:contract

vibelink.exe --rust-canary --rust-http-canary bridge --host 0.0.0.0 --port 8787
npm run status:http-canary -- --command apps/windows/target/release/vibelink.exe --devices-http --device-mutations-http --delete-temp
npm run status:http-canary -- --command apps/windows/target/release/vibelink.exe --pairing-http --delete-temp
npm run status:http-canary -- --command apps/windows/target/release/vibelink.exe --audit-http --settings-http --delete-temp

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

1. Status：直接 Rust HTTP 路由已进入 `opt-in`，远端 CI 与公网拒绝路径已通过；完成受控公网认证成功路径后晋级。
2. Workspace：扩大自然交互观察窗口。
3. MCP：完成自然生产会话观察；受控真实/soak 证据已通过。
4. Event Store：扩大自然运行窗口并持续采集前后 runtime stats。
5. 控制面路由：设备、配对、审计、设置与 Tool Events 非流式读取均已进入 `opt-in`；Tool Events SSE 仍由 Node 持有，Settings 与 Tool Events 仍需远端 CI、便携包和受控公网认证成功路径，下一功能切片再评估 workspace/registry/MCP 或 SSE。
6. Audio/Compression：性能实验保持 `contract`；产品必需的实时通话与音频所有权仍按全量 Node 退役计划迁移。

## 全量控制面迁移与桌面发布

“全量 Rust 重写”采用 strangler 路线，不做一次性替换：

1. **桌面运行边界**：Rust launcher 已负责进程监督、包内 Node 解析、sidecar 命令注入、配对 QR、doctor 和命名 Cloudflare Tunnel 安全预检/监督。
2. **可分发包**：`npm run package:windows` 生成 Windows x64 portable ZIP，固定 Node LTS 与 cloudflared 版本，仅安装服务端生产依赖，并输出 SHA256。
3. **公网入口**：`vibelink tunnel --check-only` 必须验证固定 hostname、loopback upstream、Host allowlist、端口一致、legacy login 禁用和 404 fallback；通过后才允许运行 connector。
4. **HTTP 路由迁移**：status/doctor、pairing/device、audit/settings 和非流式 tool events 已进入 opt-in；后续按 workspace/registry/MCP/tool-events SSE -> task/provider/browser/terminal/desktop/live-call 的顺序迁入 Rust。每批保留同一 OpenAPI、Android/Web 契约和 staged rollback。
5. **删除 Node**：只有路由使用统计为 0、契约/故障/回滚测试齐全、桌面包和公网 canary 连续通过后，才删除对应 Node 实现。最后一批路由移除后，portable 包才取消 Node runtime。

当前桌面包仍是经过验证的 Rust + Node 混合包，不宣称已经完成控制面全量重写。
