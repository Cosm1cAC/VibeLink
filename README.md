# VibeLink

VibeLink 是一个本机优先的 Agent 远程控制台，目标是**一个产品、两个执行模式、多个输入场景、多端覆盖**。电脑运行本地 bridge，网页端/手机端通过局域网、Cloudflare Tunnel 等入口连接，同一套前端可以选择不同的执行模式。

- **Codex Desktop Remote**：遥控用户已经安装和登录的 Codex Desktop。模型、权限、推理强度和审批策略都使用 Codex Desktop 当前设置。
- **VibeLink Agent**：VibeLink 自己的原生 Agent 执行模式。可接入 GPT / Claude / 豆包 / GLM 等 provider，由 VibeLink 统一承载工具、权限、审批、事件、恢复和审计。
- **Live Call Assistant**：实时通话转写、问题检测和回答辅助场景。它不是第三套 runtime；问题进入 Agent 后，下游走 VibeLink Agent。

两个执行模式共享同一套后端 bridge 与会话模型。Web 端继续作为最快迭代入口，Android 原生端已经从 MVP 升级为对齐网页端核心能力的移动客户端；iOS 仍是后续平台。

当前重点是保持 Web / Android 在会话管理、Codex Desktop Remote、VibeLink Agent、Workspace、Settings、Approvals、Tool events 和 Live Call Assistant 上的产品口径一致。

## 当前定位

- 本机 bridge 负责扫描 `.codex` / `.claude` 历史、管理 workspace、启动 VibeLink Agent 任务，并在用户刷新、进入会话、发送/聚焦等主动动作时按需采样 Codex Desktop UI。
- Web 端使用 React + Vite，面向桌面浏览器、手机浏览器和后续原生 App 复用的交互模型。
- Android 端使用 Jetpack Compose + OkHttp/Gson，已经接入会话管理、VibeLink Agent composer、Codex Desktop Remote、Workspace、Settings/Approvals、Tool events 和 Live Call Assistant。
- 不做账号系统。首次配对使用 pairing token，后续使用设备 token；公网模式需要明确的 Host allowlist 和设备授权。
- Codex Desktop Remote 走 UI 自动化路线；VibeLink Agent 走本项目自己的 provider adapter 和 tool runtime。

## 执行模式与输入场景

VibeLink 的执行模式决定谁拥有模型选择、工具生命周期、权限审批和事件归属；输入场景只决定问题从哪里来。

```text
Codex Desktop Remote
  遥控已有 Codex Desktop，强调可见状态同步和人机接管。

VibeLink Agent
  原生 Agent 执行模式，可选择 GPT / Claude / 豆包 / GLM 等 provider，
  由 VibeLink 统一管理工具、权限、审批、沙箱、事件、恢复和审计。

Live Call Assistant
  上层实时输入场景，用于采集通话、转写问题并辅助回答；
  问题进入 Agent 后交给 VibeLink Agent，不依赖 Codex Desktop Remote。
```

### Codex Desktop Remote

目标是遥控用户已经安装和登录的 Codex Desktop，把移动端变成 Codex Desktop 的可见状态观察器和远程输入器。

适合场景：

- 用户希望从手机端接管桌面上正在看的 Codex Desktop。
- 任务更偏“人机协同遥控”，例如查看当前可见 transcript、向 composer 输入、点击发送、观察大致进度。
- 用户接受 Codex Desktop 当前模型、权限、推理强度和审批策略。

边界：

- 依赖 Windows UIA、前台窗口、控件结构和 Codex Desktop UI 稳定性。
- 只能读取可见 transcript 和可恢复历史，不能获得 Codex Desktop 未暴露的完整内部 tool 输出、退出码和归属。
- 不负责选择 GPT/Claude/GLM/豆包等模型；模型只能来自 Codex Desktop 当前已支持、已登录、已选择的设置。
- 不做常驻自动监听；只在刷新 VibeLink 浏览器端/Android 端、点进已绑定会话、发送/重试/聚焦等明确动作时半自动同步一次，避免 Codex Desktop 正在工作时被频繁采样打断。
- 尊重 Codex Desktop 的归档状态；`.codex/archived_sessions` 中的 Codex 会话不会进入 VibeLink 浏览器端或 Android 端的会话管理区。
- 会话区默认使用 Codex Remote transcript 视图：连续正文 + 轻量“已运行”工具行；完整 tool 审计卡片保留给 VibeLink Agent 视图。
- 不作为 VibeLink Agent 的替代品。

### VibeLink Agent

目标是建设 VibeLink 自己可控、可审计、可恢复的原生 Agent 执行模式。

适合场景：

- 需要明确选择模型或 provider，例如 GPT、Claude、豆包、GLM。
- 需要确定性模型参数、权限模式、网络策略、沙箱策略和审批流。
- 需要所有 shell、file、git、browser、MCP、approval 等工具进入统一 `tool_runs` / `tool_events` 生命周期。
- 需要移动端可靠展示任务进度、工具卡片、审计记录、失败恢复和断线 catch-up。

边界：

- VibeLink Agent 是本项目自己的执行系统，不等于把第三方 CLI 源码并入项目。
- Codex CLI、Claude Code、豆包 Web CLI、GLM API adapter 都只是 provider adapter；权限、事件归属、审批和 UI 展示沉淀在 VibeLink runtime。
- 当能力需要“可选模型、可控、可审计、可恢复”时，优先使用 VibeLink Agent。

### Live Call Assistant

目标是采集通话音频，实时转写问题，并在移动端/网页端给出可读的回答草稿或辅助提示。

适合场景：

- Windows 通过蓝牙/Phone Link 接收手机通话下行音频。
- 本机通过 WASAPI loopback 捕获对方声音，通过外接麦克风承载电话上行。
- ASR 把对方问题转成 transcript，VibeLink 检测问题并触发 Agent 回答。

依赖关系：

- 音频采集、ASR、问题检测属于 Live Call Assistant 自己的实时输入链路。
- 问题进入 Agent 后，必须交给 VibeLink Agent。
- 不应依赖 Codex Desktop Remote 来生成实时通话回答，因为 Desktop 遥控无法保证确定性参数、权限、审批、工具事件归属和低延迟恢复。

### 模式选择

| 需求 | 应选择 |
| --- | --- |
| 遥控已有 Codex Desktop、尽量复用桌面 UI | Codex Desktop Remote |
| 使用 GPT / Claude / 豆包 / GLM 等可选 provider | VibeLink Agent |
| 自建可控 Agent 执行层、统一工具事件和审批 | VibeLink Agent |
| 实时通话转写、问题检测、面试辅助回答 | Live Call Assistant + VibeLink Agent |
| 需要确定性模型/权限/沙箱/审批 | VibeLink Agent |
| 只需要观察和接管当前 Desktop 可见状态 | Codex Desktop Remote |


## Rust 化性能架构

VibeLink 当前运行在 Rust HTTP 前门 + Node loopback backend 的混合架构上，并持续向 Rust 桌面服务迁移。默认 Windows 启动会开启 Rust 前门和当前已迁移的路由；Node 仍负责尚未迁移的产品职责，并作为失败、超时和无效响应时的回退。Workspace、MCP 和 Event Store 已进入 `canary`；Status、Doctor、Devices、设备令牌写操作、完整配对生命周期和 Audit Log 已有 Rust HTTP 路由。只有全部产品职责完成 Rust 所有权并通过观察窗口后才移除捆绑 Node。Audio/Compression 的旧性能 sidecar 因没有测得收益保持 `contract`，但实时通话等产品职责仍在全量迁移范围内。

Windows portable 包可用 `vibelink.exe --rust-canary`（或 `start-vibelink-canary.cmd`）显式复现当前 Rust canary profile；普通 `vibelink.exe` 也会应用默认 Rust 前门 profile。需要紧急回退时运行 `vibelink.exe bridge`，直接启动 Node bridge。

服务端 HTTP 前门使用独立的 `--rust-http-canary` 逐步迁入 Rust；设备写操作另由 `--rust-device-mutations-http` 控制，写事务一旦由 Rust 接管就不会回放到 Node。管理界面规划为原生 Win32 `windows-rs` 托盘/窗口，不新增 Web 管理后台，也不嵌入 WebView。

完整状态、证据、阈值、回滚和命令统一见 `docs/rust-migration-report.md`；机器清单为 `docs/rust-migration-status.json`。推进前运行：

```bash
npm run rust:migration:check
```

## 启动

```bash
npm install
npm run build
npm start
```

启动后终端会打印：

- 本机地址：`http://127.0.0.1:8787`
- 局域网地址：形如 `http://192.168.x.x:8787`
- 配对码：首次登录网页端或手机端时使用

## 常用脚本

```bash
npm run build
npm start
npm run dev
```

`npm run build` 会把 React 前端构建到 `public/`，本机 bridge 使用该目录提供网页端资源。

## 核心能力

- 会话列表：按 workspace / 项目组织 Codex、Claude 和 VibeLink Agent 任务历史，并可在 Codex Desktop、VibeLink CLI 和全部来源之间切换。
- VibeLink Agent：通过 provider adapter 接入 Codex CLI、Claude、豆包 Web CLI、GLM，并统一工具事件、审批和审计。
- 历史恢复：解析 Codex / Claude JSONL，并把消息、附件和命令摘要尽量还原成聊天时间线。
- 实时任务：通过 SSE 同步 VibeLink Agent 任务日志、状态和 tool events。
- Desktop 遥控：按需采样 Codex Desktop 可见状态，向 composer 输入并点击发送。
- Android 原生端：支持 QR/Token 配对、会话搜索/归档/置顶/重命名/fork、新建/继续 Agent 任务、Codex Remote 发送/重试/清队列、Workspace 浏览与 Git 操作、Settings/Approvals、Live Call 会话恢复与实时问答。
- 安全底座：allowed roots、workspace 绑定、设备 token、Host allowlist、公网模式提示。
- 变更卡片：读取 workspace Git 状态和 diff，为移动端展示文件变更摘要；短时缓存会用 changed-file 内容签名失效，避免稳定 mtime/size 下复用旧 diff。

## Workspace（工作区）

Workspace 是 VibeLink 把本机项目目录暴露给网页/手机端的中枢。它不是云盘、不是 IDE，也不是远端文件系统协议客户端，而是一个 **绑在本机 bridge 进程上的本地浏览器 + Git + 命令面板**。

### 定位

- **只读语义 + Git 写入**。Workspace 负责浏览本机目录、读取文本文件、把选中的文件作为 LLM 上下文附加到 prompt；同时承担 Git 状态、diff 和 stage / commit / push / PR 操作。
- **绑定在本机 bridge 进程**。所有文件操作都通过 `node:fs` 直接发生在 bridge 所在的操作系统上。能看到的目录就是 bridge 进程所在机器上已挂载的目录。
- **不连接云盘 / 远端协议**。没有 S3、Google Drive、OneDrive、Dropbox、SSHFS、SFTP、NFS 客户端等任何集成。但只要操作系统本身已经把某个 SMB / NFS / WSL / 映射网络驱动器挂载到本地路径（例如 `Z:\`、`\\wsl$\Ubuntu\home`、`\\nas\share`），Workspace 就能像普通目录一样浏览它。
- **绑定到会话/任务**。Workspace 可以独立浏览，也会被会话或任务的 `cwd` 自动选中；任务运行产生的 tool run / tool event / approval 都共享同一个 `workspace_id`，所以同一个工作的所有产物（命令、文件变更、审批）能聚在一起。

### 前端表现

Workspace 在网页端是一个可折叠的面板（默认收起），挂在聊天区上方：

- 头部：workspace 选择下拉、刷新、折叠/展开按钮
- 四个标签：
  - **文件树**：单层目录浏览 + 文本文件查看（限制 512KB、文本类型，行号渲染，点击外部 `data-file-line` 跳转高亮）
  - **Git**：状态、`git diff HEAD` 全文、untracked 文件预览、per-file stage/unstage/accept/restore、commit、push、pull --ff-only、`gh pr create --fill`
  - **终端**：默认 `git status --short --branch`，可改命令并通过 SSE 流式输出，支持停止
  - **测试**：默认 `npm test`，粗解析 passed/failed 行，点击失败行跳到对应文件

`/workspace` slash 命令和 Composer 旁的文件选择器也走同一套 Workspace API，可在任意会话里勾选文件作为上下文。

### 后端 API

主要端点（完整列表见 `src/server.js`）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/workspaces` | 列出所有 workspace |
| `POST` | `/api/workspaces` | 新建/upsert workspace（body `{ path, title? }`） |
| `GET` | `/api/workspaces/:id/tree?dir=` | 单层目录列表（最多 240 项） |
| `POST` | `/api/workspaces/:id/context` | 把选中文件拼成 LLM 上下文（最多 20 个路径，单文件 12KB） |
| `GET` | `/api/workspaces/:id/file?path=` | 读取文本文件（≤512KB） |
| `GET` | `/api/workspaces/:id/git/status` | porcelain v1 状态 |
| `GET` | `/api/workspaces/:id/git/diff` | diff + untracked 文件预览 |
| `POST` | `/api/workspaces/:id/git/file-action` | 单文件 stage/accept/restore/reject/unstage |
| `POST` | `/api/workspaces/:id/git/action` | stage-all/unstage-all/commit/push/pull/pr |
| `POST` | `/api/workspaces/:id/command` | 在 workspace cwd 跑 shell 命令（流式输出、可中止、风险评估） |
| `POST` | `/api/workspaces/:id/terminal-session` | 起 PTY 终端会话 |

所有写操作都会落进统一的 `tool_runs` / `tool_events` 生命周期，绑定 `workspace_id`、`task_id`，并接受同样的审批与审计。

### 安全约束

- `resolveAllowedPath` 严格校验：所有路径必须落在 `settings.allowedRoots`、已登记 workspace 的 `allowedRoot`、bridge 安装目录或 `defaultCwd` 之一内；越界访问返回 403。
- 启动时 `ensureDefaultWorkspaces` 会**主动剔除** `$HOME` / `$USERPROFILE`，避免默认暴露用户家目录。
- 危险命令（递归删除、Git 历史重写、网络下载执行、SSH/SCP/SFTP/RSYNC 等）通过 `commandSafety` 拦截并要求 428 显式审批；所有 workspace 操作都写 `audit_log`。
- Workspace 路径不暴露给前端明文，只返回 id + title + 相对路径；外链使用 `/api/files?path=...&token=...` 临时 token。

### 与执行模式和场景的关系

- **Codex Desktop Remote**：Desktop 自身的工作目录不在 Workspace 范围；如需在 Desktop 侧栏会话和 Workspace 之间联动，使用 `WorkspaceWorkbench` 的 `defaultWorkspace` 自动按 `cwd` 匹配。
- **VibeLink Agent**：Agent 任务 `cwd` 落到哪个 workspace，task / tool run / approval 就会自动挂到那个 workspace 上，变更卡（ChangeCard）会显示对应的 git 摘要。
- **Live Call Assistant**：当 Live Call 推送的 transcript 触发 Agent 时，Agent 的 cwd 即绑定到当时活跃 workspace；执行交给 VibeLink Agent，产物（tool run、文件变更、审批）都在 workspace 内可见。

### 边界与下一步

- 没有远端路径协议支持（SSH/SFTP/NFS 客户端都不在当前范围里）。需要时由 OS 层挂载。
- 没有“工作区同步”或离线缓存，所有读写都是实时的 bridge-host fs 调用。
- 文件写入、编辑、重命名和删除已经提供 bridge API，并在 Android Workspace 中有移动端入口。
- Workspace 已支持大文件 UTF-8 byte cursor 分页、PDF/Office/表格/Notebook 结构化预览，以及 atomic/best-effort 批量文件操作；客户端专用 renderer 和跨设备合并体验继续在 `docs/product-status.md` 跟踪。

## 现实边界

普通终端里已经启动的任意 CLI 进程，通常无法在事后被另一个程序接管输入输出。VibeLink 当前采用两个执行模式：

- 对 VibeLink Agent 任务：由 bridge 新启动或 resume provider adapter，并把输出、工具事件和审批状态同步到网页端。
- 对 Codex Desktop：通过按需 UI 采样和自动化遥控，减少复刻 Desktop 可见交互的工程量，但不接管其内部 runtime。

Codex Desktop 本身目前无法被第三方网页端强制回显完整消息状态，因此 VibeLink 会优先做到“可手动/半自动同步、可遥控、可近似还原上下文”。当前边界见 `docs/product-status.md`。

## 技术结构

- `src/`：本机 Node bridge、VibeLink Agent 启动、provider adapter、历史扫描、desktop observer、安全与 workspace API。
- `apps/web/`：React + Vite 网页端。
- `apps/android/`：Jetpack Compose Android 原生端，复用 bridge API、SSE、Live Call WebSocket 和会话模型。
- `packages/doubao-cli/`：豆包 Web CLI / extension bridge 原型，作为 VibeLink Agent 的 provider adapter 之一。
- `docs/`：产品状态、Agent 架构、Rust 迁移、豆包 CLI、OpenAPI 和架构决策。
- `.agent-mobile-terminal/`：本机运行时数据目录，不提交到 Git。

Android 已经完成旧缺口报告中的主要 parity 拉平，当前可作为 VibeLink 的主要移动客户端；后续 iOS 建议复用同一套 API client、会话模型、附件模型和 workspace 模型。

通话实时转写通过 Windows WASAPI/Phone Link 输入、ASR 和问题检测进入 VibeLink Agent；Android 已提供会话恢复、事件回放、助手选择、手动转录、麦克风推流和问答卡片。当前剩余项见 `docs/product-status.md`。
