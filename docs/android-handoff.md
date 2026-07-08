# VibeLink Android 交接文档

最后更新：2026-07-08

Android 端不再按 “MVP” 定位推进。当前目标是全面对齐网页端核心设计与功能，并补齐 Live Call Assistant 的移动端能力。本文记录当前已经落地的 Android 能力、仍需打磨的边界和下一轮建议。

## 当前结论

- Android 已接入 VibeLink bridge 的核心 REST / SSE / WebSocket 能力。
- Android debug 构建已通过：`apps/android` 下执行 `.\gradlew.bat assembleDebug`。
- Android 主路径已经覆盖：登录/配对、会话管理、Codex Desktop Remote、VibeLink Agent composer、Workspace、Settings、Approvals、Tool events、Live Call Assistant。
- Codex Desktop Remote 仍遵循手动 + 半自动同步策略：刷新列表、进入 Remote 会话、发送、重试、清队列或聚焦时采样；不做常驻监听。
- Codex 已归档会话应被过滤在 VibeLink 会话管理区之外；Android 会通过 `/api/tasks`、`/api/histories`、`/api/thread-state` 和 Desktop Remote 状态组合出会话列表。

## 代码位置

| 区域 | 路径 |
| --- | --- |
| Android App | `apps/android/` |
| 网络层 | `apps/android/app/src/main/java/com/vibelink/app/network/ApiClient.kt` |
| 数据模型 | `apps/android/app/src/main/java/com/vibelink/app/network/ApiModels.kt` |
| 根导航 | `apps/android/app/src/main/java/com/vibelink/app/ui/VibeLinkApp.kt` |
| 会话列表 | `apps/android/app/src/main/java/com/vibelink/app/ui/screens/SessionListScreen.kt` |
| 会话列表状态 | `apps/android/app/src/main/java/com/vibelink/app/ui/screens/SessionListViewModel.kt` |
| 聊天详情 / Composer | `apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListScreen.kt` |
| 聊天状态 | `apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListViewModel.kt` |
| Workspace | `apps/android/app/src/main/java/com/vibelink/app/ui/screens/WorkspaceScreen.kt` |
| Settings / Approvals | `apps/android/app/src/main/java/com/vibelink/app/ui/screens/SettingsScreen.kt` |
| Live Call Assistant | `apps/android/app/src/main/java/com/vibelink/app/ui/screens/LiveCallScreen.kt` |
| Live Call 状态 | `apps/android/app/src/main/java/com/vibelink/app/ui/screens/CallViewModel.kt` |
| 麦克风推流 | `apps/android/app/src/main/java/com/vibelink/app/audio/LiveCallAudioStreamer.kt` |

## 已对齐能力

### 1. 会话管理

- 合并 histories、tasks、thread-state forks 和 Codex Desktop Remote 可见状态。
- 支持搜索、归档视图切换、置顶、重命名、归档/恢复、fork。
- 会话排序遵循置顶优先、分组、更新时间倒序。
- 支持 Desktop Remote 入口，并显示 Codex Desktop 当前 ready / found / not connected 状态。
- Android 与网页端一致：Codex Remote 只在主动动作时按需同步。

### 2. VibeLink Agent Composer

- 支持新建任务和继续历史会话。
- 支持 provider 选择：Codex、Claude、Doubao、GLM。
- 支持 model override、reasoning effort、working directory 输入。
- 支持运行中任务停止。
- 支持运行中任务补充输入；如果 provider 不接受 stdin，会明确显示失败提示。
- 任务创建遇到 428 approval 时，引导到 Settings / Approvals 处理。

### 3. Codex Desktop Remote

- Android 可进入 Remote 会话并读取可见 transcript。
- 支持发送到 Codex Desktop Remote 队列。
- 支持 retry queue、clear queue。
- 支持有 `desktopIndex` 的会话先 focus 再发送。
- Remote 文案明确使用 Codex Desktop 当前设置，不和 VibeLink Agent 的 provider/model 选择混淆。

### 4. Tool Events

- Android 已接入 `/api/tool-events` SSE。
- Tool event 会转成轻量 tool card 消息。
- 当前实现是可用型摘要卡，不是网页端完整 tool lifecycle 合并器；后续可继续增强输入/输出聚合、审批状态和大 payload 折叠。

### 5. Workspace

- 支持 workspace 列表与切换。
- 支持目录浏览、上级目录、文本文件预览。
- 支持 Git status/diff、stage/unstage/restore、stage-all/unstage-all。
- 支持 workspace command 执行和输出展示。
- 仍缺文件搜索、编辑、per-hunk 操作、branch/stash/worktree 完整管理。

### 6. Settings / Approvals

- 支持读取 `/api/status` 公共设置。
- 支持保存 default cwd、Codex/Claude/Doubao command、Doubao CDP endpoint、Doubao URL。
- 支持配置 sandbox、approval policy、network access、trusted workspace、dangerous command approval。
- 支持增量写入 OpenAI / Anthropic / Zhipu API key。
- 支持 pending approvals 列表、approve、deny。

### 7. Live Call Assistant

- 支持 Live Call 会话列表、选择、恢复。
- 支持事件 catch-up 和 SSE 继续接收。
- 支持创建/停止通话。
- 支持选择 Live Call 下游助手 provider：Claude、Codex、Doubao、GLM。
- 支持 model override 和 ASR provider 字段。
- 支持手动 transcript 输入，选择 remote/local speaker 和 final/partial。
- 支持 Android 麦克风 WebSocket 推流到 `/api/live-calls/:id/audio`。
- 支持音频电平、实时 transcript feed、问题检测、assistant thinking/delta/done/error 的 Q&A 卡片。

## 已调整的后端问题

- `/api/settings` 的 `approvalPolicy` validation 已修正为当前实际策略枚举：`never`、`on-request`、`on-failure`、`untrusted`、`strict`。
- Android `SettingsPatchRequest` 已补齐 `codexCommand`、`claudeCommand`、`doubaoCommand`、`doubaoCdpEndpoint`、`doubaoUrl`。
- Android Live Call API client 已补齐 `/api/live-calls/:id/events/catch-up`。

## 尚未完成

| 优先级 | 项目 | 说明 |
| --- | --- | --- |
| P0 | Android 原生通知 | 还没有 FCM/本地通知、通知偏好、审批/任务完成推送。 |
| P0 | 后台任务 | App 退到后台后，长时间 SSE / WebSocket / audio capture 的生命周期还没有产品化。 |
| P1 | Live Call 真实 ASR | 当前链路支持 Mock ASR 和手动 transcript；真实 provider、端到端 10 分钟 QA、暂停/恢复/录制管理仍待补。 |
| P1 | Tool event 聚合 | 目前是摘要卡；还没有完全复刻网页端 tool lifecycle 合并、审批嵌入和输出折叠。 |
| P1 | Workspace 深水区 | 文件搜索/编辑、per-hunk stage、branch/stash/worktree/PR review、冲突向导仍未做。 |
| P1 | 多设备一致性 | 会话操作、消息删除/编辑、归档/置顶等跨设备同步策略仍需打磨。 |
| P1 | 系统分享入口 | 还不能从 Android 分享菜单把文本/文件直接发给 VibeLink。 |
| P2 | iOS | 尚未开始原生 iOS App。 |

## 验证命令

```powershell
cd apps/android
.\gradlew.bat assembleDebug
```

本轮已通过 debug 构建。根目录建议同时运行：

```powershell
npm run build
node --test test\history.test.js test\remoteTranscript.test.js test\sidebarModel.test.js test\liveCall.test.js
```

## 下一轮建议

1. 为 Android 增加 provider registry / model catalog 接口，而不是在 UI 里硬编码 provider 与模型字段。
2. 为 Android Tool events 做和网页端一致的 lifecycle reducer。
3. 为 Live Call 增加真实 ASR provider 配置、暂停/恢复、录制文件列表和长通话压测。
4. 补 Android 原生通知与后台生命周期策略。
5. 补系统分享入口，把文本、图片、文件直接送入新建 VibeLink Agent 任务。
