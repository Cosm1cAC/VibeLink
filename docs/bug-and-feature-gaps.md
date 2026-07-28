# VibeLink Bug 与功能缺口清单

最后更新：2026-07-28

审计基线：`main` 提交 `e32aa41`。本文是后续修复和功能评审的入口；迁移完成度仍以 `docs/route-ownership.json` 与 `docs/rust-migration-status.json` 为准。

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
| Browser | desktop `en-US`、phone `zh-CN` E2E | 23 trace events、12 pages；redaction/reconnect/cleanup 通过，无 console error/横向溢出。 |

结论：本轮没有确认的产品运行 Bug。下面三项是实际复现的测试基础设施 Bug，不能因为不影响最终用户就忽略，也不能写成产品功能故障。

## 已确认 Bug

### TBUG-001 Rust HTTP 合同并发运行会超时

- **级别**：P1 测试可靠性；产品影响未证实。
- **证据**：`rust-http:contract` 与其他 Rust/canary 工作并发时，`doctor_route_pending_replays_the_original_request_to_node`、`audit_route_failure_replays_the_original_request_to_node`、`proxy_preserves_bidirectional_bytes` 在 120 秒后超时；同一 commit 隔离重跑 12/12 在 0.13 秒完成。该模式在两次独立审计中出现。
- **风险**：并行 CI 或本地并行验证产生假红，掩盖真实回归并拖慢发布。
- **建议修复**：先用可控并发回归测试稳定复现；检查测试 listener/thread 生命周期、端口/accept 同步与共享资源，使用显式 ready channel 和有界 join 代替依赖调度时序。若被测模块必须串行，给相关测试加进程内资源锁并记录原因，不把整个 Rust suite 全局串行化。
- **验收**：相关合同与至少一个 Rust sidecar canary 并发循环 20 次，0 timeout；隔离运行仍 12/12；`cargo test` 默认并发全绿。
- **主要文件**：`apps/windows/src/http_frontdoor.rs` 及对应测试辅助代码。

### TBUG-002 Cargo 探测把可用环境误判为不可用

- **级别**：P1 测试覆盖。
- **证据**：`cargo 1.97.1`、`rustc 1.97.1`、Rust build/test/clippy 均成功，但 `test/rustTestSupport.js::cargoPath()` 因 `where.exe link.exe` 失败返回空字符串，导致 6 个真实 workspace Rust 测试以 `cargo is not available` 跳过。
- **风险**：Windows 环境使用 rust-lld、VS 工具未注入当前 PATH 或其他有效 linker 配置时，测试报告假装缺少 Cargo，真实 parity 覆盖被静默丢失。
- **建议修复**：Cargo 可用性只验证可执行文件与 `cargo metadata`/最小 `cargo check` 的实际结果；不要独立猜测 linker。探测失败时输出结构化原因，并让 CI 对非显式 opt-out 的 skip 失败。
- **验收**：当前环境 6 项不再 skip；真实缺少 Cargo 的 fixture 仍可得到明确 skip/error；新增 rust-lld/无 `link.exe` 回归测试。
- **主要文件**：`test/rustTestSupport.js`、`test/workspacesRustTree.test.js`。

### TBUG-003 Canary 会静默优先使用陈旧 release 二进制

- **级别**：P1 测试可信度。
- **证据**：`event-store:canary:all` 首次自动选择已有 `target/release/vibelink.exe`，因旧协议缺少 `compactEvents` 失败；当前 debug binary 协议完整，重新构建当前 release 后三层 canary 全部通过。脚本仅按“release 文件存在”选择，不验证其与源代码/commit 是否一致。
- **风险**：对当前源码产生假失败，或更危险地使用旧实现产生假通过。
- **建议修复**：正式 gate 必须显式传 `--command/--bin`；默认选择时复用 `rustBinaryIsCurrent` 并验证 build commit/protocol hash。性能 canary 遇到 debug binary 应明确拒绝，而不是把 debug 性能与 release 阈值比较。
- **验收**：陈旧 release fixture fail-fast 并给出 rebuild 命令；当前 release 三层 canary 通过；debug 模式只允许功能合同、不执行 release 性能判定。
- **主要文件**：`tools/event-store/*.mjs`、其他采用相同默认 binary 选择逻辑的 canary、`test/rustTestSupport.js`。

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

- **现状**：仓库最新 tag `v0.1.0` 指向 2026-07-12 的 `2608fdc`；2026-07-27 的 Rust-only ZIP/校验和证据对应后续 commit，而当前审计基线为 `e32aa41`。
- **方案**：先完成测试基础设施修复与 release candidate gate，再生成 manifest、SBOM/依赖审计、hybrid rollback ZIP 和 Rust-only ZIP；验证 hash 后创建不可变 tag 和 release notes。
- **验收**：tag、manifest commit、ZIP 内 commit、SHA-256 和 release notes 五者一致；升级/回滚 smoke 通过。
- **依赖**：TBUG-001/002/003、QG-001；是否阻断于 QG-003 由 release owner 明确决定。

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
| 1 | TBUG-001 并发稳定性；TBUG-002 Cargo 探测；TBUG-003 binary provenance | 无 | 三项可分支并行，但 TBUG-002/003 都改测试辅助层，合并前需协调接口。 |
| 2 | QG-001 execution-host gate；QG-002 Android 告警 | 阶段 1 的 TBUG-003 | Android 可完全并行；QG-001 等 provenance 规则。 |
| 3 | QG-003 运行证据与 release candidate package | 阶段 1/2 | Provider、MCP、Live Call、Android 设备证据可分四路并行。 |
| 4 | QG-004 tag/release | 阶段 3 或显式豁免 | 只能由一个 release owner 串行完成。 |
| 5 | QG-005 Node 兼容源码退役 | 稳定 release/rollback 基线 | 不同 ownership slice 可并行开发，按共享 gate 顺序合并。 |
| 设计轨 | FG-001/002/003 产品 discovery 与 ADR | 不阻塞阶段 1–4 | 三项可并行调研；没有产品决定前不进入实现。 |

## 并行协作边界

- 测试基础设施 owner 先冻结 binary provenance 与 skip policy，避免多个分支各自发明探测方式。
- Android 告警清理只改客户端，可独立交付。
- 运行证据任务只提交脱敏 manifest/文档，不同时修改核心协议。
- Node 兼容源码删除必须按 ownership slice 小步合并；同一共享 fixture/OpenAPI 变更由单一 integration owner 收口。
- release tag、校验和和发布说明必须在最终 commit 上串行生成，不能由多个并行分支分别发布。

## 明确排除的环境问题

- 当前 Codex Desktop 进程未继承新持久化 PATH，命令需临时补入 Cargo 路径；Cargo 本身已安装且可构建。
- Android SDK/JDK/Gradle cache 的本机配置已经修复，Android 测试通过。
- 可选 `codebase-memory-mcp` 或索引项目不可用，只影响自然 MCP 证据。
- 外部 Provider 凭据、物理 Android 设备、真实电话链路和公网弱网场景不可用时，只能标为未执行/待补证据。

这些条件不得转换成产品 Bug；若相同能力在满足前置条件后仍违反契约，再新增稳定 ID 和最小复现。
