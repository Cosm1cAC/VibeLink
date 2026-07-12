# VibeLink Agent 当前架构

最后更新：2026-07-12

本文只描述当前有效架构。产品差距见 `docs/product-status.md`，Rust 数据面见 `docs/rust-migration-report.md`，HTTP 契约见 `docs/openapi.json`。

## 执行模式

### Codex Desktop Remote

用于遥控用户已安装并登录的 Codex Desktop。VibeLink 按需读取可见 transcript、恢复历史、定位会话、写入 composer 并验证发送结果。模型、权限、推理强度和审批策略由 Desktop 当前设置决定。

它不是 Agent Provider：不能接管已有进程，也不能获得 Desktop 未公开的完整 tool 输出和内部状态。UI 自动化必须校验进程、窗口、目标会话、composer 和发送按钮，任一不匹配就 fail-closed。

### VibeLink Agent

VibeLink 自有的执行系统。Provider adapter 负责启动或恢复 Codex CLI、Claude、豆包、GLM 等后端；VibeLink 统一负责任务、工具、审批、事件、恢复、Workspace 和审计。

需要确定模型、权限、网络、沙箱、工具归属或可靠移动端恢复时，应使用 VibeLink Agent。

### Live Call Assistant

负责音频采集、ASR、问题检测和回答展示。音频输入链路属于 Live Call；问题形成后交给 VibeLink Agent，不依赖 Codex Desktop Remote 生成回答。

## 服务分层

- `src/server.js`：HTTP/SSE/WebSocket 入口、认证、限流和路由。
- `src/agents.js` 与 Provider runtime：任务启动、恢复和输出归一化。
- `src/db.js`：SQLite 产品状态、事件 cursor、查询和迁移。
- `src/workspaces.js`：受 allowed roots 约束的文件、上下文和 Git 能力。
- `src/mcpRuntime.js`：MCP server 发现、probe、调用和持久 session 路由。
- `apps/web` / `apps/android`：共享 API 契约的 Web 和 Android 客户端。
- `apps/windows`：Windows launcher 与 Rust data-plane sidecars。

Node 是 control plane，Rust 是可回退的数据面；二者通过稳定 JSON/JSONL 契约连接。

## Provider 边界

Provider adapter 只处理后端特有能力：命令、resume/session id、模型参数、流式输出和错误映射。以下能力必须留在 VibeLink：

- `tasks`、`tool_runs`、`tool_events` 和统一事件归属。
- sandbox、network、approval 和 trusted workspace 策略。
- Workspace/Git/Terminal/MCP 工具入口。
- Android/Web 的恢复、catch-up、通知和审计展示。

内部数据模型仍有 Codex 优先的历史包袱；后续 Provider registry 应统一 capability、model catalog、参数 schema 和健康状态，而不是继续在 UI 中增加 provider 条件分支。

## 持久状态与事件

`.agent-mobile-terminal/mobile-agent.sqlite` 是产品状态和事件 cursor 的权威来源；Codex/Claude 原生 JSONL 仍是原始 Agent 历史来源，不整库复制到 SQLite。

SQLite 保存 Workspace、设备、thread metadata、task、task/tool/live-call event、approval、audit、Desktop observation 等结构化状态。大附件、图片和完整 diff 不进入数据库。

任务和 Live Call 通过数值 cursor 支持 REST catch-up 与 SSE 续传。JSONL 兼容日志可以保留，但不能替代数据库事务和 cursor 语义。服务重启可恢复历史与事件，不能重新绑定已脱离控制的 OS 子进程。

## Codex 集成结论

Windows 手工启动 `codex app-server --listen ws://127.0.0.1:<port>` 可工作；第二客户端只有在已有 rollout 后显式 `thread/resume`，才能收到后续 turn 流。它可作为未来代理增强，但当前不替代稳定的 CLI resume 与 Desktop Remote 路径。

Desktop UIA 可用于发现控件，纯 `ValuePattern.SetValue` 不会触发 Electron 输入事件。实际发送使用窗口恢复、坐标点击、剪贴板粘贴、按钮调用和 postflight，并保存/恢复剪贴板。

## 安全模型

- 文件操作必须通过 allowed roots 和已登记 Workspace 校验。
- 公网入口使用配对 session、设备 token hash、过期/撤销、Host allowlist、限流和审计。
- 高风险命令返回 428 approval，审批决定持久化并进入 tool event 生命周期。
- 凭据使用系统凭据库；设置文件不保存明文 API key。
- Desktop Remote 和浏览器自动化必须验证目标，不能因“尽量发送”而注入错误窗口。

## 近期架构任务

1. 建立统一 Provider registry 和动态 model catalog。
2. 完成 Agent task 并发、重试、取消和后台调度策略。
3. 完善 tool-call 级审批后继续执行的闭环。
4. 增加事件 ack、retention/compaction 和多设备冲突策略。
5. 继续按 `docs/rust-migration-report.md` 的证据门槛推进数据面，不进行全量 Rust 重写。
