# VibeLink 产品状态

最后更新：2026-07-27

审计基线：`main` 本地工作树（提交基线 `bfd2c0b`）。本文只描述当前状态与可复现验证结果；已关闭问题不作为产品状态的一部分。

## 结论

Windows Rust 化迁移已完成。Windows Bridge、HTTP/SSE/WebSocket 产品路由、SQLite 产品状态、执行宿主、后台生命周期、原生管理入口及 Rust-only 默认发行入口均可在不携带 Node runtime 的包中运行。

本轮全量自动化验证未发现确认的 P0/P1 产品缺陷：所有本地测试、质量门禁、服务端到端 canary、浏览器证据和 Windows 两种发行包均通过；依赖审计为 0 个已知漏洞。

这不等同于对未接入本机环境的第三方账号、真实弱网和物理 Android 设备作绝对保证。它们属于上线前继续收集的运行证据，不改变当前迁移完成和可发布的判断。

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
| `npm ci` | 使用 lockfile 复现安装通过。 |
| `npm audit --omit=dev --registry=https://registry.npmjs.org` | 通过，0 个漏洞；`postcss` 已锁定为 8.5.23。 |
| `npm test` | 全套 Node 测试通过。 |
| `npm run build` | Vite production build 通过，2,072 个模块转换完成。 |
| `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` | 均通过。 |
| `npm run rust:test` | 187 passed、1 ignored、0 failed。 |
| `npm run android:test` | Android JVM tests 与 `assembleDebug` 通过。 |
| `npm run rust:migration:check` / `npm run rust:node-removal:check` | 均通过。 |
| Rust/HTTP/status 合同 | `rust-http:contract`、`status:contract`、`test:rust-sidecars`、音频、压缩和 Codex app-server 合同均通过。 |
| Event Store 三层 canary | 本地、运行时、服务路由均通过；服务路径增量工具事件 72.1ms、Live Call 58.5ms，0 回退、0 失败、0 新增同步停顿。 |
| Status/Workspace/MCP canary | HTTP、Public Status、Workspace tree、MCP 持久会话与 soak 全部通过；Public Status 10 次采样 p95 927.99ms，0 回退/失败/超时/背压。 |
| Execution Host | 启动、Bridge 重连、execd 崩溃恢复、spool 重放、持久 ack、30 秒 soak 与故障告警全部通过。 |
| 浏览器端到端证据 | 桌面 `en-US` 与手机 `zh-CN` 均通过；23 个 trace event、12 页 trace，redaction、重连和资源清理均已验证。 |
| `npm run package:windows` | hybrid ZIP 生成并通过打包流程。 |
| `npm run package:windows:rust-only` | Node removal gate、最终 ZIP smoke、普通入口 Rust-only 启动、鉴权 Rust status owner 与无 Node 进程树验收均通过。 |

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
| Rust-only Windows 用户发行版 | 已完成 Node removal、默认入口和最终 ZIP 验收，可进入常规发布流程。 |
| Web 静态产物 | 构建通过，由 Rust static HTTP 服务承载。 |
| Android 客户端 | JVM tests 与 debug build 通过；物理设备证据按 release workflow 继续归档。 |

## 持续验证

1. 保持 ownership、OpenAPI 与 runtime registry 双向差集为 0；新 route 或后台职责未登记 owner 时 CI 必须失败。
2. 继续收集真实 Provider 任务、Live Call 长时弱网和 Android 物理设备证据。
3. Rust-only 首批发布保留上一版 hybrid ZIP，并定期验证升级与回滚演练。
4. 在 Rust-only 默认发行稳定后再评估删除 hybrid Node 兼容源码；源码删除不是迁移完成的前置条件。

## 状态源

- `docs/route-ownership.json`：公开 route family、后台职责和 Rust-only acceptance 的 ownership 清单。
- `docs/rust-migration-status.json`：迁移 slice 与 Node packaging 状态。
- `tools/check-node-removal-readiness.mjs`：Node removal fail-closed gate。
- `tools/windows/package-portable.ps1`：hybrid/Rust-only 打包规则。
- `tools/rust-only-package-smoke.mjs`：最终 ZIP 的普通默认入口 Rust-only 启动 smoke。
