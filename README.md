# VibeLink

VibeLink 是一个本机优先的 Agent 远程控制台。电脑运行本地 bridge，网页端或手机端通过局域网、Cloudflare Tunnel 等入口连接，用来查看和接续 Codex / Claude Code 的历史、任务和上下文，并尽量把 Codex Desktop 的遥控体验带到移动端。

## 当前定位

- 本机 bridge 负责扫描 `.codex` / `.claude` 历史、管理 workspace、启动 CLI 任务、采样 Codex Desktop UI、提供 SSE 实时事件。
- Web 端使用 React + Vite，面向桌面浏览器、手机浏览器和后续原生 App 复用的交互模型。
- 不做账号系统。首次配对使用 pairing token，后续使用设备 token；公网模式需要明确的 Host allowlist 和设备授权。
- Codex Desktop 遥控走 UI 自动化路线；CLI 接续走 `codex exec/resume` 和 Claude Code 的 continue/resume 能力。

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

- 会话列表：按 workspace / 项目组织 Codex 历史和无项目会话。
- 历史恢复：解析 Codex / Claude JSONL，并把消息、附件和命令摘要尽量还原成聊天时间线。
- 实时任务：通过 SSE 同步任务日志、状态和桌面 UI 监听事件。
- Desktop 遥控：采样 Codex Desktop 可见状态，向 composer 输入并点击发送。
- 安全底座：allowed roots、workspace 绑定、设备 token、Host allowlist、公网模式提示。
- 变更卡片：读取 workspace Git 状态和 diff，为移动端展示文件变更摘要。

## 现实边界

普通终端里已经启动的任意 CLI 进程，通常无法在事后被另一个程序接管输入输出。VibeLink 当前采用两条路线：

- 对 CLI 任务：通过 bridge 新启动或 resume，并把输出同步到网页端。
- 对 Codex Desktop：通过 UI 监听和自动化遥控，减少复刻完整 agent 能力的工程量。

Codex Desktop 本身目前无法被第三方网页端强制回显完整消息状态，因此 VibeLink 会优先做到“可监听、可遥控、可同步近似上下文”，并把差异记录在 `docs/feature-gap-table.md`。

## 技术路线

- `src/`：本机 Node bridge、Agent 启动、历史扫描、desktop observer、安全与 workspace API。
- `apps/web/`：React + Vite 网页端。
- `docs/`：功能差异、SQLite 状态模型和后续计划。
- `.agent-mobile-terminal/`：本机运行时数据目录，不提交到 Git。

后续 Android / iOS 建议走 Expo React Native，并复用 Web 端已经沉淀的 API client、会话模型、附件模型和 workspace 模型。

通话实时转写/面试辅助的自用 MVP 路线见 `docs/windows-bluetooth-call-transcription-mvp.md`：一加手机通话音频经蓝牙/Phone Link 进入 Windows，本机通过 WASAPI 数字回环捕获下行音频，并用外接麦克风作为电话上行。
