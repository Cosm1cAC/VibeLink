# VibeLink 产品状态

最后更新：2026-07-27

审计基线：`e4b307b`（`main` / `origin/main`，不含本次文档提交）。

本文记录当前可运行产品、Windows Rust 化的完成度、发布阻塞和本轮实测结果。迁移状态以 `docs/rust-migration-status.json`、`docs/route-ownership.json`、Rust-only 打包产物和实际启动行为为准；旧 TODO、已删除阶段计划和仅存在于 fixture 的实现不作为产品状态证据。

## 结论

Windows Bridge 的服务端职责迁移已经完成，但 Rust-only 发行入口尚未完全收口。

- 36 个公开 route family 全部标记为 Rust-owned；13 个后台产品职责也全部由 Rust 拥有。
- `nodeRuntime.packaging` 已是 `removable`，迁移检查和 Node removal gate 均通过。
- 显式 `vibelink.exe rust-only` 可从不含 Node runtime 的 ZIP 启动，提供 `/api/status`，且进程树没有 `node.exe`。
- Rust-only ZIP 的普通 `vibelink.exe` 默认入口仍会启动 `bridge` 子进程；由于包内没有 `src/server.js`，本轮探针等待 30 秒后超时并以退出码 `1` 结束。

因此当前状态应表述为：**Rust 产品后端和可脱 Node 打包能力已完成；默认用户入口切换仍有 1 个 P1 发布阻塞。** 在默认入口 canary 通过前，不应宣称 Rust-only Windows 发行版已经完全可交付。

本轮没有确认未关闭的 P0。

## Rust 化口径

“Rust 化完成”的目标范围是 Windows Bridge、HTTP/SSE/WebSocket 产品路由、SQLite 产品状态、执行宿主、后台生命周期和 Windows 原生管理入口能够在不携带 Node runtime 的发行包中运行。

以下不属于重写目标：

- Web 前端继续使用 React/Vite 构建；产物由 Rust 静态服务提供，不要求浏览器代码改写成 Rust。
- Android 客户端继续使用 Kotlin/Compose。
- Git、gh、cloudflared、whisper.cpp 和第三方 Provider CLI 可以继续作为外部程序存在，但必须由 Rust 明确管理生命周期、安全边界和状态投影。
- 仓库中的 `src/*.js`、Node 测试和 hybrid 打包路径可以保留用于兼容回归与进程级回滚；Rust-only ZIP 不得携带这些服务端资产。

## 当前产品形态

VibeLink 由三个面向用户的产品层组成：

- **Codex Desktop Remote**：按需读取和遥控已安装的 Codex Desktop，复用其登录、模型和权限状态。
- **VibeLink Agent**：通过 Codex、Claude、豆包、GLM 等 Provider 执行任务，统一 Workspace、工具事件、审批、恢复和审计。
- **Live Call Assistant**：负责音频采集、VAD/ASR、问题检测、事件同步和向 Agent 分发问题。

Windows 端现在具备 Rust HTTP 前门、原生产品路由、Rust execution host、任务调度、持久事件/审批链路、Live Call runtime、静态资源服务和 Win32 管理界面。Web 与 Android 是同一套 Rust API 的客户端。

## 所有权快照

| 指标 | 当前值 | 结论 |
| --- | ---: | --- |
| Rust 源文件 | 46 | Windows launcher、产品 HTTP、sidecar、Live Call 和 execution host。 |
| 迁移 slice | 23 | 17 `default-on`、4 `canary`、2 `contract`。 |
| 公开 route family | 36 | 36/36 Rust-owned；34 `default-on`，2 `phase-2-persisted`。 |
| 后台产品职责 | 13 | 13/13 Rust-owned；11 `default-on`，2 `required-for-rust-only`。 |
| Node runtime packaging | `removable` | `npm run rust:node-removal:check` 通过。 |
| Rust-only 必需传输 | HTTP、SSE、WebSocket | 均进入 ownership 与 package acceptance 清单。 |

36 个公开 family 覆盖 discovery/OpenAPI、Provider、status/doctor、task/history/search/thread、Workspace/Git/terminal、tool run/event/approval、device/pairing/event sync、Live Call、review、artifact/file/attachment、browser、capability/automation/subagent、push/cloudflare、Desktop Remote 和 Codex Desktop。

13 个后台职责覆盖 Workspace command、approval continuation、task/history/terminal、Provider runtime、Live Call/ASR/audio、search index、browser session、artifact storage、automation scheduler、push、desktop observation/control 和 static asset serving。

4 个 `canary` 与 2 个 `contract` slice 是保留的实现/观测策略，不代表 Node runtime 仍拥有产品职责：

- `canary`：状态响应组装、Workspace tree 扫描器、MCP 持久 stdio 会话、Event Store sidecar。
- `contract`：低延迟音频辅助器、压缩/上下文预算辅助器。

## 本轮验证

| 验证项 | 结果 |
| --- | --- |
| `npm run rust:migration:check` | 通过；23 个 slice 与迁移清单一致。 |
| `npm run rust:node-removal:check` | 通过；Node runtime removal gate 放行。 |
| `npm run rust-http:contract` | 通过；Node 兼容层 4/4、Rust frontdoor 12/12。 |
| `npm run status:contract` | 通过，17/17。 |
| `npm run rust:test` | 通过；184 passed、1 ignored、0 failed。 |
| `node --test test/rustOnlyPackageSmoke.test.js test/rustOnlyDiscoveryE2e.test.js` | 通过，2/2；Web/Android discovery 无 Node backend 路径通过。 |
| `npm run build` | Web production build 通过。 |
| `npm run android:test` | Android JVM tests 与 `assembleDebug` 通过。 |
| `npm run package:windows:rust-only` | 通过；生成 Rust-only ZIP，并由显式 `rust-only` 子命令完成启动 smoke。 |
| Rust-only ZIP 内容复核 | 128 个 entry；禁止项 0；包含 `VibeLink/vibelink.exe` 与 `VibeLink/public/index.html`。 |
| Rust-only 默认入口探针 | 失败；普通 `vibelink.exe` 自动启动服务后 30 秒超时，退出码 `1`。 |

本轮产物：`artifacts/windows/VibeLink-0.1.0-windows-x64-rust-only.zip`，大小 164,975,931 bytes，SHA-256 `8a317454e3756aab23258be007e4b8f46a45c35c89ce37a29386de7a10ea0a72`。

## 当前阻塞

### P1：Rust-only 默认用户入口仍走 hybrid bridge

**证据**

- Windows 普通入口进入 `run_windows_user_entry()`，随后由 `ManagedBridge::spawn()` 构造 bridge 子进程。
- `bridge_role_command()` 固定追加 `bridge` 子命令；`run_bridge_role()` 仍要求 `src/server.js` 存在。
- Rust-only ZIP 正确排除了 `src/`，因此默认入口无法启动服务。
- 当前 `tools/rust-only-package-smoke.mjs` 显式传入 `rust-only` 子命令，所以 package smoke 没有覆盖普通用户入口。
- `tools/windows/package-portable.ps1` 定义了 `Test-RustOnlyStartupCanary()`，但没有调用；该函数本身也没有设置原生 UI 的自动启动 smoke 开关。

**影响**

后端迁移和 Rust-only 服务能力是真实的，但用户直接运行 Rust-only 包的主程序仍可能得到无法启动的产品。当前 gate 对“可显式启动 Rust-only server”给出了正确结论，却不足以证明“默认发行入口可用”。

**关闭条件**

1. Rust-only 包的普通入口根据 package flavor 或 Node 资产缺失自动进入 Rust-only server，而不是 `bridge`。
2. 打包流程从最终 ZIP 解压后运行普通 `vibelink.exe`，通过原生 UI smoke 自动启动服务并验证 `/api/status`。
3. 默认入口进程树不包含 `node.exe`，且显式 `rust-only`、hybrid 兼容回滚两条路径分别保留回归测试。
4. `npm run package:windows:rust-only` 在上述默认入口验证失败时 fail-closed。

## 发布判断

| 发行形态 | 当前判断 |
| --- | --- |
| Hybrid Windows 包 | 可继续作为兼容/回滚包；默认 Rust frontdoor，Node 仅承载兼容 fallback。 |
| 显式 Rust-only server | 已通过迁移门禁、合同、全量 Cargo 测试和真实 ZIP smoke。 |
| Rust-only Windows 用户发行版 | 暂不发布；等待默认入口 P1 关闭。 |
| Web 静态产物 | 构建通过，由 Rust static HTTP 服务承载。 |
| Android 客户端 | JVM tests 与 debug build 通过；真实设备发布证据仍按 release workflow 单独归档。 |

## 后续重点

1. 关闭 Rust-only 默认入口 P1，并把默认入口 ZIP canary 接入打包门禁。
2. 保持 ownership/OpenAPI/runtime registry 双向差集为 0，新 route 或后台职责未登记 owner 时 CI 必须失败。
3. 继续收集 `canary` slice、真实 Provider 任务、Live Call 长时弱网和 Android 物理设备证据；这些是发布质量证据，不再是 Node removal blocker。
4. 在 Rust-only 默认发行稳定后再评估删除 hybrid Node 兼容代码；删除源码不是证明迁移完成的前置条件。

## 状态源

- `docs/route-ownership.json`：公开 route family、后台职责和 Rust-only acceptance 的唯一 ownership 清单。
- `docs/rust-migration-status.json`：迁移 slice 与 Node packaging 状态。
- `tools/check-node-removal-readiness.mjs`：Node removal fail-closed gate。
- `tools/windows/package-portable.ps1`：hybrid/Rust-only 打包规则。
- `tools/rust-only-package-smoke.mjs`：最终 ZIP 的显式 Rust-only 启动 smoke。
