# VibeLink 产品状态与 Rust 化落地计划

最后更新：2026-07-21

审计基线：`a6714ac`（`main` / `origin/main`）。

本文只记录已经进入产品运行链路的能力、当前仍可复现的 P0-P2 缺陷，以及 Windows Bridge 完整 Rust 化的真实进度和退出 Node 的方案。设计、fixture、未接入的 sidecar 和陈旧任务清单不计为已交付能力。

## 结论摘要

- 当前没有确认未关闭的 P0 产品阻塞。
- 当前确认 4 个 P1：Rust Pairing 没有同步中断 claim 恢复语义、Codex permission approval 无法批准、Web Live Call SSE 缺设备鉴权、Rust-only 移除门禁不能证明产品职责完整。
- 当前确认 3 类 P2：Rust Workspace 文件 mutation 的所有权边界不完整、真实 Android 设备矩阵仍有缺口、全量回归基线和 canary 存在陈旧断言/固定环境假设。
- 旧 P1 中 event ack、retention/compaction 可见性和 approval delivery/attach/fidelity 可见性已经在 Web/Android 闭环，不再列为未完成。
- Windows 普通入口已经默认使用 Rust HTTP 前门和全部已迁移 route family，不再是“所有 Rust 路由均 opt-in”。但 Windows 包仍是 Rust + Node 混合包，`rust:node-removal:check` 当前按设计被 5 个 blocker 阻断。

## 当前产品形态

VibeLink 由三个产品层次组成：

- **Codex Desktop Remote**：按需读取和遥控已安装的 Codex Desktop，复用 Desktop 当前模型、权限和登录状态。
- **VibeLink Agent**：通过 Codex、Claude、豆包、GLM 等 Provider 执行任务，统一 Workspace、工具事件、审批、恢复和审计。
- **Live Call Assistant**：负责音频采集、转写和问题检测；问题形成后交给 VibeLink Agent。

Web 与 Android 已覆盖会话和任务、Codex Remote、Workspace 文件/Git/Test/PTY、Settings、Approvals、Devices、Tool events、受管浏览器、结构化 artifact、Capability Center、附件/系统分享、通知和 Live Call。

Windows portable 当前是混合运行时：普通 `vibelink.exe` 默认由 Rust 占用外部监听并处理已迁移路由，Node 仅绑定 loopback，继续承载未迁移 API 和产品状态机；`vibelink.exe bridge` 保留直接 Node 回滚。完整 Rust 化的范围是移除 Windows 包内的 Node 服务和 runtime，不包括把 Web 前端、Android 客户端、Git/gh、cloudflared、whisper.cpp 或第三方 Provider CLI 重写成 Rust。

## 最近已落地

- Web 与 Android 已在 task、tool-event 和 live-call 消费后持续调用 `/api/events/ack`，处理 CAS `409` 并展示多设备 ack、retention plan、阻塞设备和 compaction marker。
- Web 与 Android 审批界面已展示 `deliveryStatus`、execution `attachState` 和 Provider fidelity；当前剩余问题是 permission approval 的决定映射，而不是状态不可见。
- Capability Center 的 Web/Android 生命周期操作已经对齐插件安装/删除/启停、Hook 启停、Automation 创建/运行/启停/删除、Subagent 创建/停止以及 AGENTS/config 编辑。
- 真实 Bridge + Chromium 的发布证据已覆盖 trace 脱敏、分页、新客户端重连、session cleanup 和 Web 桌面/手机视口；CI 会归档 browser、Android connected test 和每周一小时 Live Call 弱网证据。
- Rust Workspace HTTP 已默认接管文件 mutation、Git status/diff、worktree list、单文件 Git action 和仓库级 Git action。
- Rust `execd`、per-execution worker、Job Object、ConPTY/stdio/app-server、spool/replay/ack 和 approval outbox 已进入默认 Windows 运行链路；Bridge/execd 重连和长时 canary 已通过。
- Android 已拆分 Codex Remote 与 Agent conversation 路由，并修复 drawer/返回导航和中断 Pairing claim 的客户端恢复策略。
- 搜索、thread metadata、task queue、Provider catalog/health、结构化测试结果、artifact workbench、浏览器控制和 PR review 已形成 Web/Android 产品链路。
- Rust-only Node 移除门禁已接入 `docs/route-ownership.json`，会把非 Rust route family、OpenAPI/运行时 route 差集、内部 Node 端点、后台职责和 rust-only 包内 Node 资产检查纳入 release gate。

## P0-P2 复核

本轮以默认产品入口为准，而不是只检查 Node fallback。证据包括代码图谱、默认 Rust route ownership、Node/Rust 合同、Web build、Android JVM/build 和迁移门禁。

### P0

当前没有确认未关闭的 P0。

执行 host 的当前用户 named-pipe ACL、manifest/execution identity、PID creation-time 校验、nonce、spool 和 fail-closed approval 路径均已有实现及测试；安全、状态、Codex app-server contract、Rust HTTP contract、Web build 和 Android 单测/build 均通过。`tasks/p0-execution-control-todo.md` 和旧 Android capability matrix 中未勾选的条目存在明显陈旧状态，不能直接当作当前 P0。

### P1

| 缺陷 | 当前证据与影响 | 关闭条件 |
| --- | --- | --- |
| Rust Pairing 丢失首次 claim 响应后无法恢复 | `3d3c594` 只在 Node 保存短期 retryable claim；普通 `vibelink.exe` 默认走 Rust Pairing，而 `apps/windows/src/pairing_http.rs` 仍对 `claimed` 返回 `409`。Android 会按新策略重试，但默认产品路径仍失败，用户必须重新配对。 | 把同一 session/code/device 的有界幂等恢复语义移植到 Rust，并增加 Node/Rust 差分合同和默认前门 HTTP canary。 |
| Codex permission approval 的“批准”链路断裂 | permission approval 的可用决定是 `grant/decline`；`src/server.js` 却把 Web/Android 的 `approve` 固定映射为 `accept`，随后被 outbox 严格校验为 `APPROVAL_DECISION_INVALID`。现有测试也明确证明 permission + `accept` 必须失败。 | API 根据 `availableDecisions` 做显式映射，或客户端提交 Provider 原生决定；双端建模并展示 `requestedPermissions`、scope 和可用决定，覆盖 grant/decline/acceptForSession/cancel。 |
| Web Live Call 实时事件未鉴权 | Web 创建 Live Call 使用 Bearer fetch，但随后 `EventSource` 只带 `after`，没有 `token`；服务端所有 `/api/*` 在进入 live-call SSE 前要求 Bearer 或 query token，因此流返回 `401`，Web 无法收到 transcript、audio level 和 QA 事件。Android 路径已带 token。 | SSE URL 带设备 token 或改为可设置 Authorization 的流客户端，并增加真实登录 Bridge 的 Web Live Call SSE E2E。 |
| Rust-only 移除门禁可能误放行不完整产品 | 已建立唯一 route/responsibility ownership manifest，并接入 `nodeRuntimeReadiness()`；当前 gate 会因为非 Rust route family、OpenAPI/运行时 registry 差集、内部 Node 端点和后台职责继续 fail-closed。 | OpenAPI、运行时 registry 和 ownership 双向差集为 0；所有 route/responsibility 均 Rust-owned；rust-only ZIP 启动后遍历必需 HTTP/SSE/WS family，并验证包内和产品进程树没有自带 Node。 |

### P2

| 缺陷或质量缺口 | 当前证据与影响 | 关闭条件 |
| --- | --- | --- |
| Rust Workspace 文件 mutation 仍有 post-ownership 回放窗口 | 前门读取 POST body 后，`route_workspace_request` 的任意错误仍统一 fallback Node；write/rename 已发生后若结果读取失败，可能出现实际已修改但客户端看到失败，或 Node 再执行。其他 Rust mutation route 已区分认领前/后错误。 | 读取 mutation body 后固定 Rust ownership；故障注入覆盖 write/rename 后失败，保证不回放、不重复副作用，并返回可诊断的 Rust 错误。 |
| 真实 Android 设备发布矩阵仍不完整 | 已有 emulator/connected workflow 和真实 Bridge Web browser 证据，但 Android `androidTest` 主要覆盖认证、无障碍和 settings security；物理手机/平板上的浏览器遥控、artifact 损坏/旋转/大内容、approval decision、真实 ASR/麦克风和厂商通知权限仍缺归档证据。Capability Center 也仍有较多硬编码英文。 | 在物理 phone/tablet 归档上述流程、logcat 和截图；补齐 Capability Center 运行文案本地化，并把设备证据纳入 release gate。 |
| 全量回归和 canary 基线不干净 | 仓库没有统一 `npm test` 或全量 Node CI；`artifactHttp.test.js` 仍断言 CSV 只读，和已交付编辑能力冲突；`mcpSessionRealCanary.test.js` 固定查询不存在的 `VibeLink` graph project。两项均稳定失败，但对应产品能力本身可用。 | 修正陈旧断言，MCP canary 动态发现 project；增加统一 Node 全量测试、完整 `cargo test`、Android JVM/build 和 rust-only negative gate 的必跑 CI。 |

### 已关闭的旧问题

- Web/Android event ack、ack list、retention plan、compaction marker 和多设备阻塞可见性已关闭。
- approval delivered/applied/stale/outcome-unknown、attach state 和 Provider fidelity 的双端可见性已关闭；permission decision 语义单列为当前 P1。
- Capability Center 双端生命周期不对等已关闭；真实设备审批和本地化归入 P2。
- 受管浏览器真实 Bridge 的脱敏、分页、重连和 cleanup 证据已关闭；Android 物理设备 smoke 仍属 P2。
- Windows 已迁移 route family 未 default-on 的旧 P1 已关闭；Node runtime 移除仍是独立迁移目标。

### 本轮验证

| 验证项 | 结果 |
| --- | --- |
| `npm run rust:migration:check` | 通过；18 个 slice 的阶段与文档快照一致。 |
| `npm run rust:node-removal:check` | 按预期失败；除原有产品 blocker 外，明确列出 ownership manifest、OpenAPI/运行时 registry 差集、内部 Node 端点和后台职责 blocker。 |
| `npm run status:contract` | 通过，17/17。 |
| `npm run rust-http:contract` | 通过；Node 4/4、Rust frontdoor 10/10。 |
| `npm run rust:test` | 120 秒内未完成；不能作为全量 Rust 已通过的证据。聚焦 HTTP 合同已通过。 |
| `npm run build` | Web production build 通过。 |
| `apps/android/gradlew.bat testDebugUnitTest assembleDebug` | 通过。 |
| `node --test test/artifactHttp.test.js test/mcpSessionRealCanary.test.js` | 1/3 通过、2/3 失败；失败分别对应 CSV 陈旧只读断言和固定 `VibeLink` graph project。 |

## Rust 化真实现状

### 口径

“完整 Rust 化”定义为 Windows Bridge/控制面/执行面可以从不含 `runtime/node.exe`、`src/server.js` 和服务端 `node_modules` 的发行包启动，并保持当前 Web/Android HTTP、SSE、WebSocket 和 SQLite 数据合同。Web 静态资源仍由 React/Vite 构建，Android 仍是 Kotlin/Compose；外部 CLI 和 native helper 只要求有明确所有权、生命周期和安全边界。

### 量化快照

| 指标 | 当前值 | 解释 |
| --- | ---: | --- |
| Rust 源文件 | 30 | Windows launcher、HTTP route、sidecar 和 execution host。 |
| 迁移台账 slice | 18 | 12 `default-on`、4 `canary`、2 `contract`。 |
| `default-on` | 12 | Frontdoor、Status、Doctor、Devices 读写、Pairing、Audit、Settings、Tool Events REST/SSE、Event Sync、Workspace HTTP。 |
| `canary` | 4 | Status 组装、Workspace tree、MCP persistent session、Event Store sidecar。 |
| `contract` | 2 | Audio/Compression benchmark helper；测量不支持接入生产 sidecar。 |
| OpenAPI | 86 path / 101 operation | 严格 method + templated path 只能匹配 12 个 Rust-owned operation；另有 Rust route 未登记 OpenAPI，因此该比例只能证明 ownership/contract inventory 不完整，不能当作完成率。 |
| Node removal gate | 5 blocker | 4 个产品职责 blocker，加 `native-release-entry`；当前 `ready=false`。 |

Rust execution host 已生产接入，但没有作为独立 slice 登记：Agent/Terminal/Workspace command 的进程、PTY 和 Codex app-server 连接可由 `execd`/worker 持有，Node 仍负责 HTTP 编排、任务投影、Provider registry/adapter 和产品 SQLite 状态。迁移台账必须新增 `execution-host`，避免继续把已经落地的执行原语写成纯 `planned`。

### 当前所有权

| 领域 | Rust 已拥有 | 仍依赖 Node |
| --- | --- | --- |
| 外部入口 | TCP/HTTP frontdoor、loopback 隔离、透明 HTTP/SSE/WS proxy、进程监督。 | 未迁移请求的实际处理和静态服务。 |
| 控制面 | Status/Doctor 外层路由，Devices、Pairing、Audit、Settings、Tool Events、Event Sync。 | Status snapshot、Doctor executor/tool run、Pairing public settings、Settings runtime reload 等内部回调。 |
| Workspace | 文件 mutation、Git status/diff、worktree list、Git file/repository actions。 | list/create/tree/context/read/preview/batch、open-explorer、worktree create/action、command/terminal HTTP、tool/approval 编排。 |
| Execution | `execd`、worker、Job Object、ConPTY/stdio/app-server、spool/replay/ack、approval delivery。 | execution facade 调度、binding/event projection、task/tool HTTP 和非 Codex Provider 编排。 |
| 数据与 Agent | Event Store core/sidecar 及部分 Rust SQLite route。 | schema/migration 主入口、task/history/thread/search/scheduler、Provider catalog/cache、MCP HTTP、reviews、browser、artifact、capability/automation、push 等。 |
| Live Call | 音频算法 contract helper；whisper.cpp 是外部 native executable。 | session、ASR/VAD 编排、PCM 生命周期、audio WebSocket、event SSE 和 Agent dispatch。 |
| 发布入口 | Rust launcher 和 hybrid/rust-only 打包分支。 | `main.rs` 仍要求项目根和 `src/server.js`，默认包仍捆绑 Node LTS 与生产 npm 依赖。 |

当前 OpenAPI 严格匹配的 12 个 Rust operation 是：Status、Doctor、Devices、Audit、Tool Events、Unified Events、Settings GET/POST、Workspace file POST、Git action、Git file-action 和 worktree list。Pairing、device mutations、Settings import/export、event ack/compact、Workspace Git status/diff 等已实现 Rust route 却没有完整出现在 OpenAPI；这进一步说明必须先修 ownership inventory，再讨论百分比或删除 Node。

### 当前 Node blocker

1. **Workspace/Tool/Approval**：Git 主路径已迁 Rust；剩余 Workspace 读/预览/批量/worktree mutation/command HTTP，以及 tool run、audit、approval continuation 的原生所有权。
2. **Task/History/Terminal**：执行进程和 PTY 已可由 Rust host 持有；任务、history、search/thread projection、scheduler、terminal/tool HTTP 仍由 Node 组织。
3. **Provider Runtime**：Codex app-server worker 和 continuation 已落地；Provider registry/catalog/health/cache，以及 Claude/GLM/豆包 adapter 仍在 Node。
4. **Live Call Runtime**：session、ASR、PCM、WebSocket/SSE 和问题分发仍在 Node。
5. **Native Release Entry**：Rust 默认入口仍启动 `src/server.js`，rust-only 包没有可独立服务全部产品职责的 native entry。

此外，现有 blocker 清单没有显式覆盖 Search、Browser、Review、Capability、Artifact、Automation、Agent Reach、Doubao/MCP HTTP、thread-state、tool registry/command registry、push/attachments/files、Desktop Remote 和 static assets。它们必须进入 ownership manifest，不能被隐含在一个可人工删除的笼统 blocker 中。

## 完整 Rust 化落地方案

1. **Phase 0：先修回归与治理门禁**
   - 修复本轮 3 个运行时 P1：Rust Pairing parity、permission decision、Web Live Call SSE auth。
   - 建立 method + path + query/stream + WebSocket + internal endpoint 的唯一 ownership manifest，并登记所有非 HTTP 后台职责。
   - 新增 `execution-host` slice；修正 artifact/MCP 陈旧测试；CI 必跑完整 Node、完整 Cargo、Android JVM/build 和 rust-only negative gate。
   - 验收：unowned route/responsibility 为 0；新 route 未登记 owner 时 CI 失败；当前 rust-only 仍必须被 gate 拒绝。

2. **Phase 1：消除已 default-on route 的 Node 内部回调**
   - 把 Status snapshot、Doctor executor/tool run、Pairing public settings、Settings reload、schema/settings 初始化和共享 audit repository 迁入 Rust。
   - 修复 Workspace mutation 的认领边界。
   - 验收：停掉 loopback Node 时，当前 default-on route 全部可用；内部 Node endpoint 数为 0；写故障不回放、不重复副作用。

3. **Phase 2：完成 Workspace、Tool 和 Approval**
   - 迁 Workspace list/create/tree/context/read/preview/batch、worktree create/action、command、terminal 和 open-explorer。
   - Rust repository 直接持久化 tool run/event/audit/approval；command 复用现有 `execd`，不再由 Node facade 拥有产品状态。
   - 验收：Web/Android Workspace、Test、PTY、Git/worktree、428 approval 和断线恢复在无 Node backend 下通过差分合同与 E2E。

4. **Phase 3：迁 Task、History、Search 和 Provider**
   - 迁 task queue/scheduler、history、thread metadata、FTS index/watch、task/tool projection、Provider registry/cache/adapters 和 MCP HTTP/runtime。
   - 保留 Rust worker 的进程所有权，统一 task create/resume/input/stop/events 和 app-server approval continuation。
   - 验收：Bridge/execd/worker restart 后任务 identity 不变，event replay 无缺口/重复，ack/pending 可排空，所有 Provider fidelity 声明与真实路径一致。

5. **Phase 4：迁其余产品 family**
   - 按垂直 slice 迁 Artifact/Attachment、Review、Browser、Capability/Automation/Subagent、Push/notification、Desktop Remote、Agent Reach/Doubao、tool/command registry、static assets 和 OpenAPI 服务。
   - 浏览器可以继续控制外部 Chromium，但 session/trace/cleanup 的产品 owner 必须是 Rust；Artifact 使用 Rust parser 或受控 native helper，不能保留隐式 Node 服务。
   - 验收：每个 family 有 Web/Android rust-only E2E，ownership manifest 和 OpenAPI/runtime registry 双向差集为 0。

6. **Phase 5：迁 Live Call 与原生桌面入口**
   - Rust 管理 whisper native process、VAD/ASR、PCM retention、audio WebSocket、event SSE、question dispatch 和恢复状态。
   - 实现既定原生 Win32 tray/admin surface；不嵌 WebView，也不以 console QR 作为最终桌面产品壳。
   - 验收：一小时真实/弱网运行无 crash、event gap、未排空 pending 或录音泄漏；物理 Android 设备完成麦克风、通知和断线恢复。

7. **Phase 6：删除 Node 并发布**
   - `nodeRuntime.packaging` 只有在 route/responsibility 100% Rust-owned 后改为 `removable`。
   - rust-only ZIP 不包含 `runtime/node.exe`、`src/`、服务端 `node_modules` 或 npm production runtime；启动进程树没有产品自带 `node.exe`。
   - 运行认证全路由 smoke、SSE/WS 重连、approval/写操作故障注入、execution/live-call soak、升级与回滚演练；保留上一版 hybrid ZIP 作为进程级回滚。

### 最终发布门禁

- Route/responsibility inventory 覆盖率 `100%`，unowned `0`，OpenAPI/runtime/ownership 双向差集 `0`。
- Node/Rust 差分 contract `0` mismatch；所有 mutation 在认领后 `0` replay、`0` duplicate side effect。
- 一小时 mixed execution/live-call soak：`0` crash、`0` fallback、`0` event gap、`0` pending leak。
- SSE/WS cursor 单调，重连后无消息缺口；approval delivered/applied/stale/outcome-unknown 均有真实 canary。
- 控制面 p95 不比当前同网络基线恶化超过 20%，并记录 cold-ready、Working Set 和 Private Memory。
- `cargo fmt`、`clippy -D warnings`、完整 Cargo/Node/Web/Android 测试、Playwright/connected test 和 rust-only package smoke 全绿。

## 已知边界与当前非目标

- VibeLink 无法事后接管电脑上任意已运行进程的 stdin/stdout/PTY。只有从启动时即由 VibeLink execution worker 持有、且 binding owner 为 `execution-host` 的 execution 才承诺重连；外部进程永久属于 `external`。
- Codex Desktop 未公开稳定的完整 tool 输出、退出码、所有权和审批 continuation。Desktop Remote 只能按需采样、实时近似并在完成后校准，不能获得 VibeLink Agent 等级的权威执行状态。
- Desktop UI 遥控依赖 Windows UIA、前台窗口、控件文案和 Electron UI 结构，必须 fail-closed，不能视为稳定第一方协议。
- 公网入口采用配对、设备 token、撤销/轮换、Host allowlist、审计、限流和 Cloudflare 向导；当前产品范围不建设完整云账号系统。
- iOS 客户端是当前非目标，暂不开发，也不计入 P0/P1/P2 产品缺口。
- Audio/Compression sidecar 的 benchmark 没有证明接入收益，保持 `contract` 是当前正确决策；这不豁免 Live Call 产品职责的 Rust 所有权迁移。

## Android 收口状态

Android 已不再是 MVP 壳层，主要闭环包括：

- Token/QR/Deep Link 配对、设备审批、撤销、过期处理和 Keystore 凭据保护。
- 独立的 Codex Remote / VibeLink Agent conversation 路由，以及会话搜索、归档、置顶、重命名、fork、标签、收藏和批量编辑。
- Composer 附件、系统分享、消息编辑/删除/重新生成、Markdown/代码/表格/数学公式和工具卡片。
- Workspace 文件编辑、Git/worktree、结构化测试、PTY terminal 和本地 PR review。
- Settings、Approvals、Devices、Audit、Doctor、Provider/command registry，以及 event ack/retention/compaction 可见性。
- 受管浏览器、artifact workbench、Capability Center 完整生命周期和 Live Call 会话/事件/音频入口。
- 原生 push capability 注册、中英文选择和主要运行时状态本地化。

后续 Android 工作集中在本轮 P2 的物理设备证据、Capability Center 本地化、真实 ASR/通知厂商差异、弱网长时稳定性、可访问性和大内容/旋转，不再维护与代码不一致的逐条旧缺口清单。

## Codex 集成结论

- Windows 上 `codex remote-control start --json` 的 daemon lifecycle 不可用，但手工启动 `codex app-server --listen ws://127.0.0.1:<port>` 可工作。
- 第二客户端必须在已有 rollout 后显式 `thread/resume`，才能收到后续 turn delta；被动连接不会得到完整 turn 流。
- 当前 contract gate 接受已审查的 Codex CLI 0.117/0.144 schema；0.144.5 fixture 固定真实 bundle hash，并校验 thread/turn/item/tool 生命周期、command/file/permission approval、dynamic tool call 和 output/progress。未知版本 fail-closed。
- UIA 可以定位 Desktop composer 和发送按钮；可靠输入路径仍是窗口校验、点击 composer、剪贴板粘贴、发送和 postflight。

## 下一批优先级

1. 修复 Rust Pairing 中断 claim parity、Codex permission decision 映射和 Web Live Call SSE 鉴权，并为三条默认产品路径补真实 HTTP/E2E 回归。
2. 建立完整 route/responsibility ownership manifest，扩充 `rust:node-removal:check`，登记 execution-host slice，并修复 Workspace mutation 所有权边界。
3. 清理 artifact/MCP 陈旧测试，建立统一全量 CI；随后按 Phase 1-2 消除 default-on route 的 Node 回调并完成 Workspace/Tool/Approval 原生所有权。
4. 按 Task/Provider、其余产品 family、Live Call/native entry 的顺序推进 Rust 迁移；门禁清零前继续发布 hybrid 包，不宣称 Node 已可删除。
