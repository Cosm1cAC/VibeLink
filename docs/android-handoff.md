 我已自动使用并遵循了对应技能：

  - code-review-and-quality：按 correctness / readability / architecture / security /
  performance 做审查
  - frontend-ui-engineering：按移动端聊天产品 UI/UX、可访问性、交互密度、状态设计做审查
  - 同时用 codebase-memory MCP 做了代码图谱检索，再直接阅读了关键文档和 Android/Web 代码。
  注：有一次 Web graph 结果被保存成大文件，我没有把那个大输出逐块完整读完；后续结论主要基于
  targeted MCP 结果、直接 Read 的关键文件、以及两个只读子代理的代码探索结果。

  总结结论

  Android 端的方向是合理的：它不是简单 WebView，而是用 Jetpack Compose 原生实现了 VibeLink
  的核心产品面，包括登录/配对、会话列表、VibeLink Agent composer、Codex Desktop
  Remote、Workspace、Settings/Approvals、Tool events、Live Call
  Assistant。这个定位与文档一致：README.md:3-11、README.md:15-19、docs/android-handoff.md:7-13。

  但如果问题是“是否完整继承网页端 vibelink
  的完整能力”，答案是：没有，当前是核心能力对齐，不是完整 parity。缺口集中在：

  1. 消息级交互与渲染能力明显弱于 Web
  2. Workspace/Git/Terminal/Test 只是基础子集
  3. Settings/安全/设备/审计/Cloudflare/MCP 等管理面不完整
  4. Android 原生通知、后台生命周期、系统分享入口还没产品化
  5. UI 与 Grok/OpenAI Android App 相比，还偏“工程控制台”，不是成熟聊天 App

  ---
  1. Android 设计是否合理？

  合理的部分

  整体产品分层是清晰的：

  - Codex Desktop Remote：遥控已有 Codex Desktop，使用 Desktop 当前设置
  - VibeLink Agent：VibeLink 自己的可控 agent runtime
  - Live Call Assistant：输入场景，问题最终进入 VibeLink Agent

  这个边界在文档里写得很清楚：docs/vibelink-agent-architecture.md:28-39、docs/vibelink-agent-arc
  hitecture.md:40-49。Android 也确实围绕这些模块落了原生页面：docs/android-handoff.md:15-31。

  Android 架构上也没有另起一套后端，而是复用 bridge 的 REST/SSE/WebSocket：

  - task/history/thread-state/desktop remote/tool events/workspace/live-call 都走同一后端能力
  - 这让 Android 与 Web 在数据源上保持一致，是正确方向

  主要设计问题：导航状态不够持久

  VibeLinkApp 的 message detail route 带了
  conversationKey，但实际没有用它恢复会话，只依赖内存里的 pendingConversation：

  - apps/android/app/src/main/java/com/vibelink/app/ui/VibeLinkApp.kt:93-104

  val key = backStackEntry.arguments?.getString("conversationKey")?.replace("~", "/") ?: ""
  val conversation = pendingConversation

  这里 key 被解析但没有使用。结果是：

  - 进程被系统杀掉后恢复
  - deep link 进入会话
  - back stack 重建
  - shared text / route restore 边界

  都可能出现 route 存在但 conversation == null，无法加载实际聊天。

  建议：P0/P1 修。
  让 conversationKey 成为真正 stable id：从 SessionListViewModel / repository / API 反查
  ConversationItem，或者 route 参数带足 provider/sessionId/kind/id。

  ---
  2. UI 如果参考 Grok / OpenAI Android App，需要对齐哪些？

  P0/P1：缺暗色模式

  当前 theme 只有 light scheme：

  - apps/android/app/src/main/java/com/vibelink/app/ui/theme/Theme.kt:8-49

  VibeLinkTheme 固定使用 LightColorScheme，没有 darkColorScheme()，也没有
  isSystemInDarkTheme()。

  这和 Grok/OpenAI 类聊天 App 的基本体验不一致。聊天类产品暗色模式几乎是默认要求，尤其 VibeLink
  还有长时间看 transcript、代码块、tool output 的场景。

  建议：

  - 增加 darkColorScheme
  - 跟随系统主题
  - 检查 message bubble、tool card、code block、error banner、status/nav bar 的对比度

  ---
  P0/P1：Live/Voice 没有进入主聊天 composer

  主聊天 composer 只有文本、provider/model/cwd/effort、send/stop：

  - apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListScreen.kt:157-191
  - apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListScreen.kt:254-374

  Live Call 是单独页面，能力强但像控制面板，而不是聊天 App 里的 voice/live mode。

  对比 Grok/OpenAI Android App，语音/实时模式通常应该在：

  - composer 右侧或左侧有 mic/voice 入口
  - 当前 thread header 可一键进入 voice/live
  - live transcript 和 assistant answer 更轻量地贴合聊天流

  建议：

  - 在主 composer 加一个 mic/live 按钮
  - Live Call 页面保留高级诊断，但主路径只暴露：开始/停止、当前音频状态、实时
  transcript、回答卡片
  - 把 ASR diagnostics、recording list、provider debug 折到 Advanced

  ---
  P1：Streaming 反馈不像聊天 App

  Android 当前 running 状态是全局 “Working” 行和 progress indicator：

  - apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListScreen.kt:230-249

  消息 bubble 是静态渲染：

  - apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListScreen.kt:377-428

  这更像 task runner，而不是现代聊天 App。用户期望看到 assistant bubble
  原地流式增长，或者至少一个 typing/streaming placeholder。

  建议：

  - running 时创建 assistant placeholder bubble
  - SSE delta 进入同一个 bubble
  - tool card 可以内嵌在该 assistant turn 下方
  - 顶部 progress 只作为网络/任务级辅助，不作为主要反馈

  ---
  P1：触控密度和移动端 ergonomics 仍偏工程界面

  Workspace 文件行、Git 操作、会话菜单等地方动作密集。子代理也指出有 36dp icon / 低 padding
  行的问题。这里不一定是 bug，但和 Grok/OpenAI Android 的轻量聊天体验不一致。

  Workspace 里有明显 truncation 和密集控制：

  - 文件只显示前 40
  项：apps/android/app/src/main/java/com/vibelink/app/ui/screens/WorkspaceScreen.kt:211-213
  - changed files 只显示前 32
  项：apps/android/app/src/main/java/com/vibelink/app/ui/screens/WorkspaceScreen.kt:270-272
  - diff 只显示前 8000
  字符：apps/android/app/src/main/java/com/vibelink/app/ui/screens/WorkspaceScreen.kt:286-292

  如果没有“show more / search / pagination”，用户会误以为这是完整列表。

  建议：

  - 所有可点击行保证 48dp touch target
  - 文件/Git 列表加 show more / search
  - 次要操作进 overflow menu，不要横向堆多个小按钮
  - diff 明确显示 “truncated, show full diff”

  ---
  P1/P2：空状态和错误状态不够 chat-native

  当前空状态只是：

  - “No chat selected”
  - “No messages yet”

  见 apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListScreen.kt:197-214。

  Grok/OpenAI 类 App 通常会有：

  - welcome prompt
  - suggested prompts
  - recent tasks
  - retry action
  - 示例 chip
  - onboarding hint

  建议：

  - 新会话展示 prompt suggestions
  - 根据 provider / cwd / workspace 给上下文建议
  - 错误 banner 加 retry / open settings / approval shortcut

  ---
  3. Android 是否继承了 Web 端完整能力？

  结论：继承核心能力，但不是完整能力

  文档其实也承认这点。Android handoff 写的是“核心能力对齐”，并列出未完成项：

  - 原生通知：docs/android-handoff.md:101-104
  - 后台任务：docs/android-handoff.md:103-105
  - Tool event 聚合：docs/android-handoff.md:105-107
  - Workspace 深水区：docs/android-handoff.md:107-108
  - 多设备一致性：docs/android-handoff.md:108-109
  - 系统分享入口：docs/android-handoff.md:109-110

  feature gap 也把 Android 移动端标为 partial：

  - docs/feature-gap-table.md:125-133
  - UI/体验差异：docs/feature-gap-table.md:143-153

  ---
  4. 主要 parity 缺口

  4.1 Chat / Composer：Android 是基础 composer，Web 是完整 agent composer

  Android 有：

  - provider chips
  - model override
  - reasoning effort
  - cwd
  - send / stop

  证据：apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListScreen.kt:282-343
  。

  但 Android 缺少 Web 端完整 composer 能力：

  - 附件 pipeline
  - 图片/文件/文件夹选择
  - slash command 菜单
  - prompt history
  - workspace context picker 的完整体验
  - permission/model/target 更完整控制
  - drag/drop 当然移动端不需要，但 share/files 入口需要原生替代

  文档也指出系统分享入口未完成：docs/android-handoff.md:109-110。

  ---
  4.2 Message rendering/actions：Android 明显弱于 Web

  Android message bubble 只显示：

  - role label
  - plain text
  - tool cards

  见 apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListScreen.kt:377-428。

  Web 侧有更完整的消息动作和渲染，包括
  copy/edit/regenerate/delete/locate/collapse、图片、artifact、Markdown/code 等。子代理在 Web
  main.jsx 中定位到 Message/MessageContent/MessageImage/ToolCallCards 等实现。

  Android 缺口：

  - 消息复制
  - 编辑
  - regenerate
  - 删除
  - collapse / expand
  - locate file
  - code block copy
  - image gallery
  - artifact preview/link
  - Markdown/GFM/code highlighting 级别体验

  这是“完整继承网页端能力”的最大缺口之一。

  ---
  4.3 Tool events：Android 是摘要卡，不是完整 lifecycle reducer

  文档明确写 Android 目前只是轻量摘要卡：

  - docs/android-handoff.md:60-65

  代码也符合：tool events 被合并成一个空文本 assistant message，之前的 tool message 会被过滤掉：

  - apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListViewModel.kt:418-443

  这不是 Web 的完整 tool lifecycle：

  - 输入/输出 payload 聚合
  - approval 状态嵌入
  - running auto-open
  - output folding
  - 大 payload 折叠
  - tool run 与 assistant turn 的准确归属

  建议：P1。
  把 Web 的 lifecycle reducer 思路移植到 Android：以 toolRunId 为核心状态机，而不是简单追加一条
  synthetic message。

  ---
  4.4 Workspace/Git/Terminal/Test：Android 只是基础子集

  Android 已有：

  - workspace list/tree
  - file preview
  - git status/diff
  - stage/unstage/restore
  - stage all / unstage all
  - command runner

  证据：apps/android/app/src/main/java/com/vibelink/app/ui/screens/WorkspaceScreen.kt:188-319。

  但 Web/README 中 Workspace 定义更强：

  - 文件树
  - Git diff/status
  - per-file accept/reject
  - commit/push/pull/PR
  - terminal
  - test tab

  见 README.md:184-193、README.md:199-211。

  Android 缺口：

  - test tab / test result view
  - commit / push / pull / PR
  - file search
  - file edit
  - branch / stash / worktree
  - per-hunk stage
  - conflict guide
  - richer terminal / PTY
  - show full diff / pagination

  所以 Workspace 是 partial parity。

  ---
  4.5 Settings / Approvals：核心有，管理面不完整

  Android 有：

  - status
  - default cwd / commands / endpoint / URL
  - sandbox
  - approval policy
  - network access
  - trusted workspace
  - dangerous command approval
  - API key 增量写入
  - pending approvals approve/deny

  文档：docs/android-handoff.md:74-80。

  但 Web 还有更完整的管理面：

  - devices / pairing sessions
  - audit log
  - host allowlist
  - Cloudflare guidance
  - Web Push
  - MCP / browser fetch / tool retention 等 admin surface

  Android 现在更像“运行时设置 + approvals”，不是完整控制台。

  ---
  4.6 Live Call：Android 反而比较强，但 reducer 有风险

  Android Live Call 覆盖较好：

  - 会话列表/选择/恢复
  - event catch-up + SSE
  - create/stop
  - provider/model/ASR 字段
  - 手动 transcript
  - mic WebSocket 推流
  - audio level
  - Q&A cards

  文档：docs/android-handoff.md:82-91。

  但 reducer 当前把 agent delta/done 追加到最后一个 QA pair，而不是稳定按 question/task/event id
  归属：

  - apps/android/app/src/main/java/com/vibelink/app/ui/screens/CallViewModel.kt:430-467

  如果出现 overlapping question、延迟事件、重放顺序边界，可能把 answer 贴到错误问题上。

  建议：P1。
  用 event 的 question id / task id / cursor / parent correlation 做 QA 状态归属，不要
  last-item-wins。

  ---
  5. Correctness / 产品安全发现

  Required：Desktop Remote focus 失败后仍然发送

  Android 发送 Desktop Remote 时，如果 conversation 有 desktopIndex，会尝试 focus：

  - apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListViewModel.kt:347-358

  但它用 runCatching 吞掉结果，然后继续 send：

  if (target != null) {
      runCatching { apiClient.focusDesktopConversation(target.desktopIndex ?: 0) }
  }
  val result = apiClient.sendDesktopRemoteMessage(prompt, target)

  这与文档里 Desktop Remote 应 fail-closed 的安全边界不一致。Desktop Remote 的目标是遥控可见
  Desktop UI，target 错了可能把 prompt 发到错误会话。

  建议：P0/P1。

  - focusDesktopConversation 返回失败时停止发送
  - UI 显示“无法确认目标会话，已阻止发送”
  - 提供“重新绑定/刷新 Desktop 状态”按钮

  ---
  Required：approval handoff 不够稳

  createOrResumeTask 如果 response 没有 id，直接显示 generic error：

  - apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListViewModel.kt:293-322

  但 approval 场景可能需要更明确地跳转/引导到 Settings > Approvals。文档说 Android 遇到 428
  approval 会引导处理：docs/android-handoff.md:50-51。

  建议：

  - 明确识别 approvalId / approval response
  - append system message：需要审批
  - CTA：Open Approvals
  - 审批后可 retry 原 prompt 或继续 task

  ---
  6. 与 Grok / OpenAI Android App 的对齐清单

  如果目标是“像 Grok/OpenAI Android App 一样自然”，建议按这个顺序补：

  P0 / P1

  1. 暗色模式
    - 系统跟随 + 手动切换
  2. 流式 assistant bubble
    - 不要只显示 “Working”
  3. 主 composer 集成 voice/live
    - mic/live 一键入口
  4. 消息动作
    - copy、regenerate、edit、delete、code copy
  5. 会话切换体验
    - full-screen list 可以保留，但建议增加 drawer/bottom sheet 快速切换
  6. 触控目标与信息密度
    - 48dp minimum
    - 次要动作收进 overflow

  P1

  7. Markdown/code/image/artifact 渲染补齐
  8. tool card lifecycle 对齐 Web
  9. Workspace show more/search/full diff
  10. Settings 分层
    - Chat
    - Voice
    - Security
    - Integrations
    - Advanced

  P2

  11. suggested prompts / onboarding
  12. 通知偏好
  13. 跨设备消息操作同步
  14. 分享文件/图片到 VibeLink

  ---
  7. 优先级建议

  P0：影响正确性/安全边界

  - Desktop Remote focus fail-closed，不要 focus 失败仍发送
  - 会话 route 用 conversationKey 恢复真实 conversation
  - Android 后台任务/通知策略，至少明确哪些流在后台继续、哪些停止

  P1：影响“完整继承 Web 能力”

  - Tool lifecycle reducer 对齐 Web
  - 消息操作和 Markdown/code/image/artifact 渲染补齐
  - Workspace/Git 增强：show more/search/full diff/test/commit/push/pull
  - Approval handoff 做成明确流程
  - Live Call QA reducer 用稳定 id 归属

  P1：影响“像 Grok/OpenAI”

  - dark mode
  - streaming bubble
  - voice/live composer 入口
  - drawer/bottom sheet conversation switcher
  - 触控密度和空状态优化

  P2：增强项

  - 插件/MCP/hooks/admin surfaces
  - notification preferences
  - system share files/images
  - richer settings import/export/audit dashboard

  ---
  最终判断

  - 设计方向：合理。 Android 原生端的模块划分和后端复用路线是对的。
  - UI 产品感：还不够像 Grok/OpenAI。 目前更像移动端 agent ops
  console，需要补暗色模式、streaming bubble、voice 入口、消息动作、触控密度和 chat-native
  空状态。
  - Web 完整能力继承：没有完整继承。 当前是核心能力对齐，很多 Web 深水区能力在 Android 仍是
  partial 或 missing，尤其 message actions、workspace/test/git
  深度、settings/admin、安全审计、通知/后台/分享。