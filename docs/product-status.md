# VibeLink 产品状态与剩余差距

最后更新：2026-07-12

本文只记录当前产品边界和仍值得追踪的差距。已经闭环的 Android 功能不再逐项保留“完成报告”。

## 当前能力

VibeLink 已形成三个清晰层次：

- **Codex Desktop Remote**：按需读取和遥控已安装的 Codex Desktop，复用 Desktop 当前模型、权限和登录状态。
- **VibeLink Agent**：通过 Codex、Claude、豆包、GLM 等 Provider 执行任务，统一工具、审批、事件、恢复和审计。
- **Live Call Assistant**：负责音频采集、转写和问题检测；问题进入 Agent 后统一走 VibeLink Agent。

Web 与 Android 已覆盖会话管理、任务创建/继续/停止、Codex Remote 同步与发送队列、Workspace 文件/Git/Test/PTY、Settings、Approvals、Devices、Tool events、附件/系统分享、通知策略和 Live Call 会话。Android debug 构建和服务端契约测试已形成自动化验证。

## 仍然存在的核心边界

### P0

- 无法接管电脑上已运行进程的 stdin/stdout/PTY。现有方式是读取历史后 resume、新开任务，或通过 Desktop UI 遥控输入。
- Codex Desktop 未公开完整内部 tool 输出、退出码和归属，因此 Remote 只能做到按需采样、实时近似和完成后校准。
- Desktop UI 遥控依赖 Windows UIA、前台窗口、控件文案和 Electron UI 结构，不能视为稳定的第一方协议。
- 服务重启后可以恢复历史和事件，但不能重新绑定重启前仍在运行的 OS 子进程。
- Agent tool call 级审批、权限升降级解释和审批后继续同一调用仍需完善。

### P1

- VibeLink Agent 缺少完整任务队列、并发上限、失败重试和后台调度面板。
- Provider registry 和动态模型 catalog 尚未完全统一。
- Workspace 仍缺大文件分页、富二进制预览、批量操作和成熟的冲突处理。
- Git 已支持常用状态、diff、stage、commit、push、pull、PR、branch、stash、worktree、per-hunk 和冲突动作，但缺少 PR review 与完整 worktree 管理。
- 测试视图仍是通用解析，缺少按 Jest/Pytest/Vitest 的结构化适配和单测重跑。
- Live Call 尚需真实 ASR Provider、长时间真实 PCM QA、暂停/恢复和录音文件管理。
- 公网入口已有配对、设备 token、撤销/轮换、Host allowlist、审计、限流和 Cloudflare 向导，但不是完整账号系统。
- 尚无 iOS 客户端。

### P2

- 缺少插件、Hooks、Automations、Subagents 和 AGENTS/config 可视化管理。
- 缺少内置浏览器视图、浏览器测试轨迹和手机端浏览器遥控。
- 缺少全局命令面板、完善快捷键、全文搜索、标签和收藏。
- Office、表格、Notebook 等 artifact 仍缺专门预览和编辑体验。

## Android 收口状态

Android 已不再是 MVP 壳层，主要闭环包括：

- Token/QR 配对、设备审批、撤销和过期处理。
- 会话搜索、归档、置顶、重命名、fork、新建和继续任务。
- Composer 附件、图片、文件夹和系统分享。
- Markdown、代码块、表格、引用、数学公式、图片和消息级动作。
- Workspace 文件编辑、Git、测试和 PTY terminal。
- Settings、Security、Approvals、Devices、Audit 和 Doctor。
- Tool event 生命周期、SSE catch-up、弱网 polling 和后台恢复策略。
- Live Call 会话恢复、事件回放、助手选择、转录、麦克风推流、电平和问答卡片。

后续 Android 工作应围绕真实设备长时间稳定性、弱网、多设备一致性和交互打磨，而不是继续维护一份逐条“已完成”清单。

## Codex Desktop 已验证结论

- Windows 上 `codex remote-control start --json` 的 daemon lifecycle 不可用，但手工启动 `codex app-server --listen ws://127.0.0.1:<port>` 可工作。
- 第二客户端必须在已有 rollout 后显式 `thread/resume`，才能收到后续 turn delta；被动连接不会得到完整 turn 流。
- UIA 可以定位 Desktop composer 和发送按钮；纯 `ValuePattern.SetValue` 不会触发前端输入事件，可靠路径是窗口校验、点击 composer、剪贴板粘贴、发送并做 postflight。

这些结论已落实到当前“app-server 可作为未来代理增强、UI 遥控保持 fail-closed”的产品边界，不再保留单独 spike 报告。

## 下一批优先级

1. 完善 VibeLink Agent 的 Provider registry、任务并发/重试和 tool-call 审批闭环。
2. 完成 Live Call 真实 ASR 与长时间音频 QA。
3. 补强事件 ack、保留/压缩策略和多设备冲突处理。
4. 对 Workspace/Git/Test 做结构化结果和批量操作打磨。
5. 只有在上游接口或真实需求变化时，再扩大 Codex Desktop/app-server 集成。
