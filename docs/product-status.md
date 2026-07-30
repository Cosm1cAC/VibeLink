# VibeLink 产品状态

最后更新：2026-07-29

审计基线：`main` 提交 `f785213`。本文只描述当前状态与可复现验证结果；已关闭问题不作为产品状态的一部分。

## 结论

Windows Rust 化迁移已完成。Windows Bridge、HTTP/SSE/WebSocket 产品路由、SQLite 产品状态、执行宿主、后台生命周期、原生管理入口及 Rust-only 默认发行入口均可在不携带 Node runtime 的包中运行。

2026-07-29 以由当前 `f785213` 源码本地重建的 release binary（非 2026-07-27 ZIP）实际启动 Rust-only 并打开 Web 产品后，确认了两个 P1 产品缺陷：空数据目录无法完成首次配对，以及启动 search watcher 的 SQLite 写锁会在约 15–20 秒内阻塞控制面；另确认 legacy `/api/login` 在 Rust-only 中缺失（P2）和配对卡片排版问题（P3）。完整证据、排除的环境前置条件、修复方案和并行策略见 `docs/bug-and-feature-gaps.md`。

因此 Rust-only Windows 用户发行版当前不能按“可常规发布”判断；至少 PBUG-001 和 PBUG-002 关闭并通过真实启动回归后才能解除发布阻塞。迁移所有权仍完成，但“迁移完成”不等于“运行健康和可发布”。外部账号、真实弱网和物理 Android 设备仍属于独立运行证据，不得与上述产品缺陷混淆。

## Rust 化范围

- 36 个公开 route family 全部为 Rust-owned；13 个后台产品职责也全部由 Rust 拥有。
- `nodeRuntime.packaging` 为 `removable`；迁移门禁与 Node removal gate 均通过。
- Rust-only 包的普通 `vibelink.exe` 根据包内 `release-manifest.json` 自动进入 Rust-only server role；hybrid 包保留兼容回滚路径。
- Web 前端继续使用 React/Vite 构建，Android 客户端继续使用 Kotlin/Compose；两者均作为 Rust API 的客户端。
- Git、gh、cloudflared、whisper.cpp 和第三方 Provider CLI 可作为外部程序存在，但由 Rust 管理生命周期、安全边界和状态投影。

## 当前产品形态

- **Codex Desktop Remote**：按需读取和遥控已安装的 Codex Desktop，复用其登录、模型和权限状态。
- **VibeLink Agent**：通过 Codex、Claude、豆包、GLM 等 Provider 执行任务，统一 Workspace、工具事件、审批、恢复和审计。
- **Live Call Assistant**：负责音频采集、VAD/ASR、问题检测、事件同步和向 Agent 分发问题。

Windows 端提供 Rust HTTP 前门、执行宿主、任务调度、持久事件/审批、Live Call runtime、静态资源服务和 Win32 管理界面。Web 与 Android 连接同一套 Rust API。

Win32 管理器在受管理服务就绪后一次性显示运行状态，并分别提供“网页端配对”和“安卓端配对”入口。配对会话、目标 URL 和矢量 SVG 二维码全部由 Rust Pairing 路由创建并批准；管理器只负责选择目标、展示、复制和调用系统查看器。Web 与 Android 客户端只能消费服务端生成的链接并领取会话，不能自行创建二维码或配对会话。

## 所有权快照

| 指标 | 当前值 | 结论 |
| --- | ---: | --- |
| Rust 源文件 | 46 | 覆盖 Windows launcher、产品 HTTP、sidecar、Live Call 与 execution host。 |
| 迁移 slice | 23 | 17 `default-on`、4 `canary`、2 `contract`。 |
| 公开 route family | 36 | 36/36 Rust-owned；34 `default-on`，2 `phase-2-persisted`。 |
| 后台产品职责 | 13 | 13/13 Rust-owned；11 `default-on`，2 `required-for-rust-only`。 |
| Node runtime packaging | `removable` | Rust-only 包不包含 Node runtime。 |
| Rust-only 必需传输 | HTTP、SSE、WebSocket | 均纳入 ownership 与最终包验收。 |

`canary` 与 `contract` slice 表示保留的实现/观测策略，不代表 Node runtime 仍拥有产品职责。

## 本轮验证

| 验证项 | 结果 |
| --- | --- |
| `npm ci` | 2026-07-27 使用 lockfile 复现安装通过；本轮未重复安装。 |
| `npm audit --omit=dev --registry=https://registry.npmjs.org` | 通过，0 个漏洞；`postcss` 已锁定为 8.5.23。 |
| `npm test` | 全套 Node 测试通过。 |
| `npm run build` | Vite production build 通过，2,072 个模块转换完成。 |
| `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` | 均通过。 |
| `npm run rust:test` | 187 passed、1 ignored、0 failed；ignored 项要求显式的新构建 execution-host 二进制。 |
| `npm run android:test` | Android JVM tests 与 `assembleDebug` 通过；41 tasks，存在弃用 API 与 unchecked cast 编译告警。 |
| `npm run rust:migration:check` / `npm run rust:node-removal:check` | 均通过。 |
| Rust/HTTP/status 合同 | `http_frontdoor` 隔离运行 15/15 通过；Rust HTTP 前门与 status sidecar 并发循环 20/20 通过、0 timeout；默认并发 `cargo test` 为 199 passed、0 failed、1 ignored（既有 execution-host 专项）。TBUG-001 已关闭。 |
| Rust sidecar 集合 | 已修复 Cargo 探测误判：workspace Rust 合同 29/29 通过、0 skip；event-store Rust sidecar 合同 5/5 通过。完整 sidecar 集合中的可选 `codebase-memory-mcp`/索引项目缺失仍按设计 skip。 |
| Event Store 三层 canary | 当前 release 二进制下本地、运行时、服务路由均通过；批量 append 平均 7.2–8.3ms，0 回退、0 失败、0 背压拒绝。 |
| Workspace/MCP canary | workspace 本仓库真实数据、server route、MCP 持久会话与 HTTP server route 全部通过；0 回退，pending 均排空。 |
| Execution Host | 当前 release 二进制的启动、Bridge 重连、execd 崩溃恢复、spool 重放、持久 ack、30 秒 soak 与故障告警全部通过。 |
| 浏览器端到端证据 | 本轮实际打开由 `f785213` 本地重建的 Rust-only release binary：桌面 1280×720 在标准 schema fixture 下完成配对、审批/领取、主界面和 Settings；移动 390×844 检查主界面/导航抽屉，无横向溢出。首次空目录 404、启动锁竞争和 Settings 请求失败已复现并登记 PBUG-001/002。 |
| `npm run package:windows` | 2026-07-27 hybrid ZIP 生成并通过打包流程；本轮未重建。 |
| `npm run package:windows:rust-only` | 2026-07-27 Node removal gate、最终 ZIP smoke、默认 Rust-only 入口、鉴权 owner 与无 Node 进程树验收均通过；本轮门禁复测通过，未重建 ZIP。 |

## 发行产物

| 产物 | SHA-256 | 大小 |
| --- | --- | ---: |
| `VibeLink-0.1.0-windows-x64.zip` | `16b6b742337b14af50949a34193c21550a55905348f8eea76e7b90c6eaf8ebb1` | 212,111,767 bytes |
| `VibeLink-0.1.0-windows-x64-rust-only.zip` | `2b41c404f8317980df6b0bf012699dd9bbea2b6a025f3972cec879170b235a8f` | 164,960,592 bytes |

Rust-only ZIP 复核：128 个 entry，`runtimeFlavor=rust-only`，无 `node.exe`，manifest commit 为 `bfd2c0b9c7f4224bd03c54a99a58469dc07fe9e0`。

## 发布判断

| 发行形态 | 当前判断 |
| --- | --- |
| Hybrid Windows 包 | 可作为兼容与进程级回滚包继续发布。 |
| Rust-only Windows 用户发行版 | 发布阻塞：Node removal/默认入口验收完成，但 PBUG-001/PBUG-002 未关闭；PBUG-003/PBUG-004 需按兼容性和视觉质量优先级处理。 |
| Web 静态产物 | 构建通过，由 Rust static HTTP 服务承载。 |
| Android 客户端 | JVM tests 与 debug build 通过；物理设备证据按 release workflow 继续归档。 |

## 持续验证

1. 保持 ownership、OpenAPI 与 runtime registry 双向差集为 0；新 route 或后台职责未登记 owner 时 CI 必须失败。
2. 继续收集真实 Provider 任务、Live Call 长时弱网和 Android 物理设备证据。
3. 先按 `docs/bug-and-feature-gaps.md` 关闭 PBUG-001/PBUG-002，再重跑空目录、启动并发和真实浏览器回归。
4. Rust-only 首批发布保留上一版 hybrid ZIP，并定期验证升级与回滚演练；产品缺陷关闭前不得宣称可常规发布。
5. 在 Rust-only 默认发行稳定后再评估删除 hybrid Node 兼容源码；源码删除不是迁移完成的前置条件。
6. 继续区分测试修复、Android 告警、运行证据和候选功能；不要把外部账号、工具或设备缺失转为 Bug。

## 状态源

- `docs/route-ownership.json`：公开 route family、后台职责和 Rust-only acceptance 的 ownership 清单。
- `docs/rust-migration-status.json`：迁移 slice 与 Node packaging 状态。
- `tools/check-node-removal-readiness.mjs`：Node removal fail-closed gate。
- `tools/windows/package-portable.ps1`：hybrid/Rust-only 打包规则。
- `tools/rust-only-package-smoke.mjs`：最终 ZIP 的普通默认入口 Rust-only 启动 smoke。
- `docs/bug-and-feature-gaps.md`：当前确认缺陷、质量/证据缺口、候选功能与并行修复策略。
