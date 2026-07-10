# Android 端缺口拉平报告

日期：2026-07-10

这份报告替代此前的 Android 缺口报告。旧报告记录的是 Android 相对 Web/Desktop 的差距；这份报告记录当前已经拉平或已经用移动端形态补齐的能力面。

## 总结

Android 端现在已经可以作为 VibeLink 的主要移动客户端使用。此前报告中最影响日常使用的缺口已经被补齐：会话恢复、Desktop Remote 发送安全、审批交接、Live Call 归属、聊天体验、消息操作、Workspace 深度、Settings/admin 管理面，以及移动端通知、分享、后台策略等。

Android 仍然是原生 Jetpack Compose 客户端，不追求 WebView 式的一比一复制。对于 Web 上的拖放、复杂桌面布局等能力，Android 采用了更贴近移动端的替代形态：系统分享、文件/图片选择器、前台音频服务策略、原生 push token 注册和触控优先的 Workspace 操作。

## 已拉平的缺口

### 1. 会话恢复与路由稳定性

旧问题：消息页依赖内存里的 pending conversation。进程被系统回收、路由恢复或 back stack 重建后，可能出现 route 存在但 conversation 丢失。

当前状态：已拉平。Android 现在通过稳定的 `conversationKey` 和会话列表数据恢复目标会话，不再只依赖内存传递。

覆盖点：

- `ConversationRoute.restoreConversation`
- `ConversationRouteTest`

### 2. Desktop Remote 发送安全

旧问题：目标 Desktop 会话 focus 失败后仍可能继续发送 prompt，有误发到错误桌面会话的风险。

当前状态：已拉平。定向 Desktop Remote 发送现在是 fail-closed：无法确认或 focus 目标会话时阻止发送，并让用户重新确认目标。

覆盖点：

- `DesktopRemoteSendPolicy.validateFocus`
- `DesktopRemoteSendPolicyTest`

### 3. 审批交接流程

旧问题：遇到 approval-required 场景时，Android 容易表现成普通错误，用户不知道要去哪里审批，也缺少继续原任务的上下文。

当前状态：已拉平。Android 现在能识别 approval 响应、提取 approval id、展示审批所需状态、跳转 Settings > Approvals，并保留 retry/continue 上下文。

覆盖点：

- `TaskApprovalHandoff`
- `TaskApprovalHandoffTest`
- Settings 中的 approval 卡片和 approve/deny 动作

### 4. Live Call 问答归属

旧问题：Live Call reducer 可能把 agent delta/done 追加到最后一个 QA pair，而不是按稳定 question/task/event id 归属。

当前状态：已拉平。Live Call Q&A 现在按稳定标识关联问题、任务和回答，能处理重叠问题、延迟事件和乱序边界。

覆盖点：

- `LiveCallQaReducer`
- `LiveCallQaReducerTest`

### 5. 聊天体验和移动端基础 UX

旧问题：Android 聊天页更像工程控制台，缺少成熟移动聊天应用里的暗色模式、流式回答、主 composer 语音入口、prompt 历史和快捷命令。

当前状态：核心缺口已拉平。现在包括：

- 跟随系统的暗色模式。
- 主 composer 的 Live Call/mic 入口。
- Prompt 历史召回。
- 快捷命令 chip，作为移动端 slash-command discovery 的替代。
- Assistant 流式占位/流式消息气泡。
- Tool card 归属到当前 assistant turn。
- 更明确的空状态、错误状态和动作入口。

### 6. Composer 附件与 Android 系统分享

旧问题：Web 有附件/图片/文件输入能力，Android 缺少移动端等价入口。

当前状态：已拉平为移动端形态。现在支持：

- 文件选择器。
- 图片选择器。
- Android 系统分享文本、文件、图片到 VibeLink。
- 通过 bridge `/api/attachments` 上传附件。
- 将返回的 markdown 和 preview text 注入 prompt。

### 7. 消息渲染与消息级动作

旧问题：Android 之前主要显示 role/text/tool summary，缺少 Web 上常用的 copy/edit/regenerate/delete/code-copy/file-locate/image/artifact 等动作。

当前状态：主要缺口已拉平。现在支持：

- 复制整条消息。
- 复制代码块。
- 编辑消息。
- 删除消息。
- 重新生成回答。
- 从 assistant 输出中提取文件引用。
- 直接打开文件引用到 Workspace preview。
- 复制检测到的文件引用。
- 更丰富的 Markdown 渲染。
- 基于 Coil 的内联图片缩略图/gallery。
- Artifact 链接保留为明确动作。

覆盖点：

- `MessageContentUtils`
- `MessageContentUtilsTest`
- `MessageListReducerTest`
- `MessageListScreen`

### 8. Tool event 生命周期

旧问题：Android 只展示轻量摘要，不像 Web 那样把 tool lifecycle 归属到 assistant turn 并表达运行、审批、成功、失败、输出等状态。

当前状态：已补齐到移动端可用。Android 现在用结构化 tool card 表达工具活动，并挂到对应 assistant turn；运行、输出、审批、成功/失败、展开/复制等动作已经比旧摘要模式完整得多。

### 9. Workspace / Git / Terminal / Test 深度

旧问题：Android Workspace 只是浅层查看，缺少文件编辑、搜索、完整 diff、测试、commit/push/pull/branch/stash/worktree/per-hunk/conflict/terminal 等深水区能力。

当前状态：主要工作流已拉平。现在包括：

- Workspace list/tree。
- 文件搜索和 show-more。
- 文件 preview。
- Full diff reveal。
- Test command/result surface。
- 文件创建、编辑、重命名、删除。
- Git status/diff。
- Stage、unstage、restore、stage all、unstage all。
- Per-hunk staging。
- Branch create/switch。
- Stash push/pop。
- Worktree creation。
- Conflict-resolution actions。
- PTY terminal session，支持 input、resize、stop 和 output polling。

覆盖点：

- `WorkspaceScreen`
- `WorkspaceViewModel`
- `WorkspaceDiffUtils`
- `WorkspaceDiffUtilsTest`
- `workspacesFileMutation.test.js`
- `workspacesGitDepth.test.js`

### 10. Settings / Security / Devices / Admin 管理面

旧问题：Android Settings 只有基础 runtime settings 和 approvals，缺少 devices、pairing、audit、MCP、Doctor、Cloudflare、retention、push、import/export 等管理能力。

当前状态：管理面缺口已大幅拉平。现在包括：

- Runtime settings。
- Sandbox、approval policy、network、trusted workspace 控制。
- API key 增量更新。
- Devices summary 和 revoke。
- Pairing session list 以及 approve/deny。
- Audit log summary。
- MCP server status 和 probe controls。
- Doctor diagnostics。
- Cloudflare guidance。
- Tool-event retention 和 prune controls。
- Email/Web Push/native push 可见性。
- FCM native push credential 配置。
- Native push token registration。
- Settings export/import，并支持 dry-run preview。

覆盖点：

- `SettingsScreen`
- `ApiClient` settings/admin methods
- `settingsImportExport.test.js`
- `nativePushSubscription.test.js`

### 11. 移动端运行策略、通知和后台行为

旧问题：后台任务、通知权限、弱网、前台音频、多设备同步等策略没有被明确产品化。

当前状态：已拉平为可测试策略。Android 现在有移动端 resilience policy，覆盖：

- 弱网 polling 决策。
- 后台 catch-up 决策。
- 通知权限提示时机。
- 前台 microphone/audio service 决策。
- 多设备同步状态决策。
- Native push 注册和服务端 FCM delivery path。

覆盖点：

- `MobileResiliencePolicy`
- `MobileResiliencePolicyTest`
- Native push backend tests

### 12. Android 所需后端契约

部分 Android 缺口不是 UI 能单独解决的，需要 bridge 后端补契约。当前已补齐：

- Settings export/import 和 dry-run preview。
- Native push token registration。
- FCM credential 通过 credential store 存储。
- Workspace file mutation。
- Android 使用的 Git depth operations。
- Settings 使用的 tool retention/admin controls。

## 验证快照

合并后的 Android parity 工作已通过以下验证：

```powershell
node --test test/liveCall.test.js test/settingsImportExport.test.js test/nativePushSubscription.test.js test/workspacesFileMutation.test.js test/workspacesGitDepth.test.js test/eventStoreSidecarContract.test.js test/eventStoreRustRuntime.test.js
```

```powershell
cd apps/android
java -Dorg.gradle.appname=gradlew -classpath .\gradle\wrapper\gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain testDebugUnitTest
```

Event-store runtime canary 在重建当前 Rust sidecar 后也已通过：

```powershell
cargo build --manifest-path apps/windows/Cargo.toml
node tools/event-store/runtime-canary.mjs
```

## 仍需注意的边界

这些不再是旧报告里的阻塞型 Android 缺口，但仍属于后续产品打磨：

- UI 还可以继续向更消费级的聊天体验收敛。
- Web 如果继续新增深层控制，Android 仍需要按功能逐项评估是否要跟进。
- 部分运行时能力依赖本地环境，例如 Rust sidecar binary 需要按当前代码重建后 runtime canary 才会通过。
- Android Gradle wrapper 的 jar 布局已在合并时规范化，后续应使用标准 wrapper jar 路径跑验证。

## 结论

旧 Android 缺口报告可以关闭。Android 现在已经覆盖 VibeLink 的主要端到端工作流：聊天、Desktop Remote、审批、Live Call、附件、消息动作、Workspace/Git/Test/Terminal、Settings/admin，以及移动端通知、分享、后台策略。
