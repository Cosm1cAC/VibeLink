# VibeLink Bug 与功能缺口清单

最后更新：2026-07-29

审计基线：`main` 提交 `f785213`。本文是后续修复和功能评审的入口；迁移完成度仍以 `docs/route-ownership.json` 与 `docs/rust-migration-status.json` 为准，运行健康度以本文件和 `docs/product-status.md` 为准。

## 分类规则

- **产品 Bug**：在受支持配置下可重复触发，且实际行为违反现有产品契约。
- **测试基础设施 Bug**：会产生假失败、假跳过或无法可信验证当前代码，但未证明产品运行路径错误。
- **质量/证据缺口**：已有实现可运行，但自动化覆盖、长期观测或发布证据不足。
- **功能缺口**：产品当前明确没有该能力；只有产品确认进入范围后才转成实现任务。
- **环境前置条件**：外部账号、可选 CLI/MCP、物理设备、PATH 或 SDK 缺失。它们必须修复或在证据中声明，但不得登记为 Bug。

## 本轮实际验证

| 范围 | 命令/场景 | 结果 |
| --- | --- | --- |
| Node | `npm test` | 通过。 |
| Web | `npm run build` | 通过；2,072 modules。 |
| 依赖 | `npm audit --omit=dev --registry=https://registry.npmjs.org` | 0 vulnerabilities。 |
| Rust | `npm run rust:test` | 187 passed、1 ignored、0 failed。 |
| Rust 质量 | `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` | 通过。 |
| Android | `npm run android:test` | JVM tests 与 `assembleDebug` 通过；41 tasks。 |
| Ownership | `npm run rust:migration:check`、`npm run rust:node-removal:check` | 通过。 |
| HTTP/Status | `npm run rust-http:contract`、`npm run status:contract` | 隔离运行分别 12/12、17/17 通过。 |
| Codex app-server | `npm run codex-app-server:contract` | 14/14 及真实 schema probe 通过。 |
| Event Store | `npm run event-store:canary:all`，当前 release binary | 本地/runtime/server 三层通过，0 fallback/failure/backpressure。 |
| Workspace | local、real-repository、server 三种 canary | 全部通过，真实仓库 parity、缓存与 session drain 正常。 |
| MCP | persistent-session 与 server-route canary | 全部通过，单 server/session 复用，0 fallback，pending 排空。 |
| Execution Host | 当前 release binary，30 秒 reliability canary | 启动、重连、崩溃恢复、spool、ack、soak、告警全部通过。 |
| Browser | 当前 release Rust-only，桌面 1280×720、移动 390×844 | 实际打开产品；空目录首次配对失败，在标准 schema fixture 下完成配对、审批/领取、主界面、Settings 和移动端导航检查；移动端无横向溢出。 |

结论：本轮实际产品运行确认 3 项 P1/P2 缺陷和 1 项 P3 视觉缺陷；另有测试基础设施和证据缺口。缺陷均在隔离数据目录、当前 release 和真实浏览器中复现，不把 PATH、可选 CLI、账号或设备缺失登记为产品 Bug。

## 已确认产品 Bug

### PBUG-001 Rust-only 空数据目录无法完成首次启动

- **级别**：P1 产品阻塞；新用户首次启动无法进入配对流程。
- **复现**：使用由当前 `f785213` 源码本地重建的 release binary（非 2026-07-27 ZIP）和全新空 `VIBELINK_DATA_DIR` 启动 `rust-only`。`GET /api/status` 和 `POST /api/pairing-sessions` 均返回 `404 {"error":"Not found."}`；Web 的“Create pairing QR”直接弹出 `Not found.`。只创建 `settings.json` 仍因缺少 `devices` 表复现，说明不是单一配置文件缺失。
- **根因线索**：`status_http::prepare_route_request` 对未初始化 settings/schema 返回 `Pending`，Rust-only 没有 Node upstream 时由 frontdoor 退化为 404；启动时直接注册路由但没有先执行完整、幂等的 schema/bootstrap。
- **影响**：空目录安装无法创建短期配对会话，Rust-only 首次启动契约被破坏；现有 package smoke 先调用 `prepareRustOnlySmokeData()`，没有覆盖真正空目录。
- **修复评估**：优先在 Rust-only 监听前调用共享迁移/bootstrap，原子创建 settings、SQLite 表和默认投影；其次为未就绪状态返回明确的初始化响应，禁止把 pending 映射成 404。不要仅在 smoke fixture 中补表。
- **验收**：空目录启动后首次 `GET /api/status` 为可解释的 setup/ready 响应，创建 pairing session 返回 201，浏览器能展示 QR；重复启动不丢数据，既有数据迁移回归通过。
- **主要文件/测试**：`apps/windows/src/main.rs`、`apps/windows/src/status_http.rs`、共享 SQLite migration/bootstrap；新增空目录 Rust-only API + browser smoke。

### PBUG-002 Rust search watcher 启动写事务阻塞控制面

- **级别**：P1 产品稳定性；启动后约 15–20 秒内配对、鉴权、Settings 和任务页面间歇性不可用。
- **复现**：使用同一份由 `f785213` 源码本地重建的 release binary、标准 settings/schema 和默认 workspace 启动 Rust-only。启动 watcher 扫描 workspace/内容索引时，连续配对 POST 前 3–4 次返回 500（`database is locked`），随后约 20 秒才成功；认证 `/api/devices` 前 4 次返回 404，之后才 200。浏览器 Settings 可见 `Not found.`、`Product request failed.` 和“无配对设备”，与服务端 stderr 的 SQLite lock/fallback 记录一致。
- **根因线索**：`apps/windows/src/task_http.rs` 的 `start_search_watcher` 在启动即执行 `refresh_search_index`/`refresh_content_index`。workspace 路径收集虽在事务外，但锁内仍逐文件执行 `fs::metadata`、`fs::read_to_string` 和大量 FTS 写入；内容索引也在收集历史文件后持有 `BEGIN IMMEDIATE` 批量写入。SQLite busy 错误经过 route fallback 后在无 Node upstream 的 Rust-only 中变成 404，已认领的 mutation 则变成 500。
- **影响**：这是 Rust-only 默认启动路径的系统性可用性问题，不是测试环境锁残留；停止 Node、checkpoint WAL、只保留 Rust 进程后仍可复现。
- **修复评估**：将逐文件 metadata/content 读取移出写事务，改为预计算快照后短批次 FTS/投影写入，或交给带退避的后台队列；设置合理 busy timeout。frontdoor 必须把 transient busy 映射为 503/Retry-After 或明确错误，不能伪装成 404；已认领 mutation 不得重复回放。
- **验收**：在真实/非空 workspace 启动并并发执行预期成功的 pairing、status、devices、settings、task 请求 20 轮，除业务语义导致的资源不存在 404 外无 404/500；若人为注入锁，客户端收到可重试 503，锁解除后自动恢复，日志包含结构化 busy 原因，并记录锁持有时间上限。
- **主要文件/测试**：`apps/windows/src/task_http.rs`、`apps/windows/src/http_frontdoor.rs`、共享 SQLite 事务 helper；新增启动并发集成测试。

### PBUG-003 已声明的 legacy token login 在 Rust-only 中缺失

- **级别**：P2 兼容功能缺口；默认关闭，但设置页和 OpenAPI 仍把能力作为可用路由声明。
- **复现**：在 Settings 开启 `allowLegacyPairingTokenLogin`，输入有效 legacy pairing token，Web 调用 `POST /api/login` 返回 `404 Not found.`。`docs/route-ownership.json`、`docs/openapi.json` 和 Node `src/server.js` 均声明/实现该接口，Rust 源码无对应 handler。
- **修复评估**：短期在 Rust 实现 Node 当前兼容语义和审计：`allowLegacyPairingTokenLogin || (!isPublicHost && activeDevices.length === 0)`。因此本地非公网且无活动设备时，即使开关为 false 也允许首设备登录；开关为 true 时 Node 也允许公网或已有设备场景。`pairDevice` 当前不会轮换/吊销 pairing token，不能在 Rust 修复中擅自声称旧 token 失效。若产品要收紧为“公网/已有设备始终拒绝”或改为一次性 token，必须作为独立安全变更同步修改 Node、OpenAPI、安全文档和合同。当前 ownership 已标 Rust-owned，默认方案是补 Rust handler。
- **验收**：Node/Rust 合同覆盖“本地无设备 + 开关 false 允许”“本地已有设备 + 开关 false 拒绝”“公网 + 开关 false 拒绝”“开关 true 时按 Node 允许”；成功响应、重复 pairing token 行为、错误/过期 token 状态码和审计与 Node 一致。
- **主要文件/测试**：`apps/windows/src/*login*`（新 handler）、`apps/windows/src/http_frontdoor.rs`、`docs/openapi.json`；补 Rust-only login contract。

### PBUG-004 配对卡片标题和说明无视觉间距

- **级别**：P3 视觉回归。
- **复现**：当前 Web build 的桌面浏览器 1280×720 配对页显示 `QR pairingCreate a short-lived...`，标题 `<strong>` 和说明 `<small>` 都是 inline，肉眼连成一行。代码位于 `apps/web/src/main.jsx:3156`，外层 `.pairing-card` 在 `public/styles.css:3945`，但内层 `<div>` 没有排版规则。
- **修复评估**：为卡片内层建立纵向 grid/flex 并保留 4px 间距，避免依赖默认 inline 流；不改变文案或配对状态逻辑。
- **验收**：桌面和 390px 移动断点截图中标题、说明分行且不溢出；配对创建/错误/过期状态均保持布局稳定。
- **主要文件/测试**：`apps/web/src/main.jsx`、`public/styles.css`；补 desktop/mobile visual smoke。

## 已确认 Bug

### TBUG-003 Canary 会静默优先使用陈旧 release 二进制

- **级别**：P1 测试可信度。
- **证据**：`event-store:canary:all` 首次自动选择已有 `target/release/vibelink.exe`，因旧协议缺少 `compactEvents` 失败；当前 debug binary 协议完整，重新构建当前 release 后三层 canary 全部通过。脚本仅按“release 文件存在”选择，不验证其与源代码/commit 是否一致。
- **风险**：对当前源码产生假失败，或更危险地使用旧实现产生假通过。
- **建议修复**：正式 gate 必须显式传 `--command/--bin`；默认选择时复用 `rustBinaryIsCurrent` 并验证 build commit/protocol hash。性能 canary 遇到 debug binary 应明确拒绝，而不是把 debug 性能与 release 阈值比较。
- **验收**：陈旧 release fixture fail-fast 并给出 rebuild 命令；当前 release 三层 canary 通过；debug 模式只允许功能合同、不执行 release 性能判定。
- **主要文件**：`tools/event-store/*.mjs`、其他采用相同默认 binary 选择逻辑的 canary、`test/rustTestSupport.js`。

## 已关闭记录

### TBUG-001 Rust HTTP 合同并发运行会超时

- **关闭日期**：2026-07-30。
- **级别**：P1 测试可靠性；产品影响未证实。
- **修复**：提交 `f785213` 使用确定性的请求 framing、listener ready 信号和有界测试线程等待；未将整个 Rust suite 全局串行化。
- **门禁证据**：最新源码构建的 `vibelink.exe` 下，Rust `http_frontdoor` 合同与 Rust status sidecar 合同并发循环 20/20 通过，前门每轮 15/15、sidecar 每轮 1/1，0 timeout；隔离前门 15/15；默认并发 `cargo test` 为 199 passed、0 failed、1 ignored（既有 execution-host 专项）。
- **结论**：并发调度/请求 framing 假红已关闭；后续若出现超时应以新的复现和稳定 ID 记录。
- **主要文件**：`apps/windows/src/http_frontdoor.rs` 及对应测试辅助代码。

### TBUG-002 Cargo 探测把可用环境误判为不可用

- **关闭日期**：2026-07-30。
- **级别**：P1 测试覆盖。
- **修复**：`test/rustTestSupport.js` 改为解析 Cargo 可执行文件并执行 `cargo metadata --format-version 1 --no-deps`；移除 `where.exe link.exe` 猜测，不再把 rust-lld 或其他有效 linker 配置判为不可用。缺失环境返回结构化诊断；CI 默认 fail-closed，仅 `VIBELINK_ALLOW_MISSING_CARGO=1` 可显式 opt-out。
- **门禁证据**：当前 Windows 环境 `cargo 1.97.1` 可用且 `where.exe link.exe` 返回缺失；`test/rustTestSupport.test.js` 4/4、`test/workspacesRustTree.test.js` 25/25 通过，合计 29/29，0 skip。event-store Rust sidecar 合同 5/5 通过。缺失 Cargo fixture、CI fail-closed 和显式 opt-out 均有回归覆盖。
- **结论**：6 个真实 workspace Rust 测试已恢复执行；后续 Cargo 探测失败会保留可机器解析的原因，不再静默伪装成普通缺失。
- **主要文件**：`test/rustTestSupport.js`、`test/rustTestSupport.test.js`、`test/workspacesRustTree.test.js`。

## 质量与证据缺口

### QG-001 Execution Host 集成测试仍被 ignored

- **现状**：`terminal_session_uses_execd_and_persists_control_events` 需要刚构建且支持 `execd` 的 `vibelink.exe`，默认 Rust suite 将其 ignored；独立 execution-host canary 已通过。
- **方案**：在 focused workflow 先构建一次当前 binary，再显式运行 ignored test；复用该 binary 给 canary，避免重复编译。
- **验收**：CI 中该测试不再只靠 ignored 状态，失败会阻断 execution-host 相关变更。
- **依赖**：先完成 TBUG-003 的 binary provenance 规则。

### QG-002 Android 编译告警债务

- **现状**：构建通过，但 `LiveCallAudioService` 使用弃用的 Notification action API；Compose 使用弃用的 `Icons.Filled.Send/Chat/Sort`；`MessageListViewModel` 有两处 unchecked cast。
- **方案**：改用当前 Notification action 构造方式与 AutoMirrored icons；把动态 payload 解析收敛到有类型 DTO/adapter，删除调用点强转。
- **验收**：相关 JVM/UI 测试与 `assembleDebug` 通过，目标告警为 0；不以全局 suppress 作为修复。
- **并行性**：可与全部 Rust/发布工作并行。

### QG-003 自然运行与外部集成证据不足

- **现状**：受控 MCP fixture、server route 和 soak 已通过；本机未安装/索引可选 `codebase-memory-mcp`，因此自然 MCP 测试按设计 skip。真实 Provider 长任务、终端长会话、弱网 Live Call 和每个 release 的 Android 物理设备证据仍需持续采集。
- **方案**：用脱敏 evidence manifest 记录 commit、binary hash、外部实现版本、请求量、fallback/failure/p95 与清理结果；缺少外部账号/工具时标记 `not-run: prerequisite unavailable`。
- **验收**：发布候选至少有一条真实 Provider 任务、一条自然 MCP 或明确豁免、一轮终端恢复、弱网 Live Call 和 Android 设备 checklist。
- **说明**：这是发布证据缺口，不是产品 Bug，也不要求为审计临时引入不受信任的全局工具。

### QG-004 当前 commit 尚无对齐的正式 release tag

- **现状**：仓库最新 tag `v0.1.0` 指向 2026-07-12 的 `2608fdc`；2026-07-27 的 Rust-only ZIP/校验和证据对应后续 commit，而当前审计基线为 `f785213`。
- **方案**：先完成测试基础设施修复与 release candidate gate，再生成 manifest、SBOM/依赖审计、hybrid rollback ZIP 和 Rust-only ZIP；验证 hash 后创建不可变 tag 和 release notes。
- **验收**：tag、manifest commit、ZIP 内 commit、SHA-256 和 release notes 五者一致；升级/回滚 smoke 通过。
- **依赖**：TBUG-003、QG-001；是否阻断于 QG-003 由 release owner 明确决定。

### QG-005 Hybrid Node 兼容源码尚未退役

- **现状**：Rust-only 包已经不含 Node，但仓库仍保留 Node bridge/route 实现用于开发、契约对照和 hybrid rollback。
- **方案**：先按 route family/后台职责记录运行引用为 0，再以可逆小批次删除；每批更新共享 fixtures、OpenAPI、ownership gate 和 rollback artifact。不要一次性删除 `src/`。
- **验收**：每批 `npm test`、Rust contracts、Web/Android E2E 与 hybrid rollback smoke 通过；没有未登记 runtime import。
- **依赖**：QG-003 观察窗口和 QG-004 可恢复发行基线。

## 功能缺口候选

以下项目是当前文档明确的产品边界，不是缺陷。进入实现前必须先确认目标用户、成功指标和平台范围。

### FG-001 iOS 原生客户端

- **现状**：Web 与 Android 已实现，iOS 尚不存在。
- **建议方案**：先冻结 OpenAPI、SSE/WebSocket 恢复语义、附件和 Workspace DTO；以 SwiftUI 建立最小 API client 与 pairing/session shell，再按 Android capability matrix 分阶段对齐。
- **规模/风险**：XL；主要风险是后台音频、通知、证书分发和 Web/Android 行为漂移。
- **产品决策**：是否需要原生 iOS，还是先以移动 Web/PWA 覆盖。

### FG-002 Codex Desktop Remote 完整状态保真

- **现状**：只能读取 Codex Desktop 可见 transcript 与可恢复历史，无法取得 Desktop 未暴露的完整 tool 输出、退出码和内部归属，也不能事后接管任意已启动 CLI。
- **建议方案**：优先使用官方可观察接口或 app-server 事件；UIA 继续只做可见状态遥控。不要通过高频 UI 抓取伪造“完整状态”。
- **规模/风险**：L/不确定；受上游公开能力约束，可能只能改善而无法完全消除。
- **产品决策**：把目标定义为“可靠遥控”还是“完整镜像”；两者验收标准不同。

### FG-003 Workspace 远端协议与离线同步

- **现状**：Workspace 只操作 bridge host 已挂载路径，不内置 SFTP/云盘客户端，也没有跨设备离线缓存或冲突合并。
- **建议方案**：若确认需求，优先定义 provider-neutral mount/sync contract、凭据隔离、冲突模型和审计，再选择 SFTP/对象存储 adapter；不要把协议实现混入现有 allowed-root 文件 API。
- **规模/风险**：XL；安全、冲突与大文件成本高。
- **产品决策**：继续要求 OS 层挂载，还是把远端同步纳入核心产品。

## 建议实施顺序

| 阶段 | 工作 | 依赖 | 可并行 |
| --- | --- | --- | --- |
| 1 | PBUG-001 空目录 bootstrap；PBUG-002 watcher/SQLite 锁 | 无 | 两项共享 Rust 启动与 SQLite 生命周期，先由同一 owner 设计 bootstrap/事务边界，再可分支实现；不能独立合并后再猜接口。 |
| 2 | TBUG-003 binary provenance | PBUG-001/002 不要求代码依赖，但必须先有稳定可启动 fixture | TBUG-003 继续复用已收口的 Cargo 探测辅助层。 |
| 3 | PBUG-003 legacy login；PBUG-004 pairing layout；QG-001/QG-002 | PBUG-003 依赖 Rust 控制面稳定；PBUG-004 无后端依赖 | PBUG-003、PBUG-004、Android 告警可并行；QG-001 仍依赖 binary provenance。 |
| 4 | QG-003 运行证据与 release candidate package | PBUG-001/002 关闭或 release owner 明确豁免 | Provider、MCP、Live Call、Android 设备证据可分四路并行。 |
| 5 | QG-004 tag/release | 阶段 4 | 只能由一个 release owner 串行完成。 |
| 6 | QG-005 Node 兼容源码退役 | 稳定 release/rollback 基线 | 不同 ownership slice 可并行开发，按共享 gate 顺序合并。 |
| 设计轨 | FG-001/002/003 产品 discovery 与 ADR | 不阻塞阶段 1–4 | 三项可并行调研；没有产品决定前不进入实现。 |

## 并行协作边界

- 测试基础设施 owner 先冻结 binary provenance 与 skip policy，避免多个分支各自发明探测方式。
- Android 告警清理只改客户端，可独立交付。
- 运行证据任务只提交脱敏 manifest/文档，不同时修改核心协议。
- Node 兼容源码删除必须按 ownership slice 小步合并；同一共享 fixture/OpenAPI 变更由单一 integration owner 收口。
- PBUG-001 与 PBUG-002 共同触及 Rust-only 启动、SQLite schema 和 frontdoor 错误语义；先冻结共享 bootstrap/事务与错误码合同，再将 watcher、route 和测试分支并行。
- PBUG-003 只改 Rust pairing/login ownership；PBUG-004 只改 Web 样式和截图测试，两者可完全并行。
- release tag、校验和和发布说明必须在最终 commit 上串行生成，不能由多个并行分支分别发布。

## 明确排除的环境问题

- 当前 Codex Desktop 进程未继承新持久化 PATH，命令需临时补入 Cargo 路径；Cargo 本身已安装且可构建。
- Android SDK/JDK/Gradle cache 的本机配置已经修复，Android 测试通过。
- 可选 `codebase-memory-mcp` 或索引项目不可用，只影响自然 MCP 证据。
- 外部 Provider 凭据、物理 Android 设备、真实电话链路和公网弱网场景不可用时，只能标为未执行/待补证据。

这些条件不得转换成产品 Bug；若相同能力在满足前置条件后仍违反契约，再新增稳定 ID 和最小复现。
