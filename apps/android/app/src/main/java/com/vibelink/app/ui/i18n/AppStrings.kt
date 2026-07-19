package com.vibelink.app.ui.i18n

import androidx.compose.runtime.staticCompositionLocalOf
import com.vibelink.app.data.AppLanguage

class AppStrings(private val appLanguage: AppLanguage) {
    val currentLanguage: AppLanguage get() = appLanguage
    val languageName: String = select("中文", "English")
    val brandName: String = "VibeLink"

    val back: String = select("返回", "Back")
    val cancel: String = select("取消", "Cancel")
    val close: String = select("关闭", "Close")
    val create: String = select("创建", "Create")
    val delete: String = select("删除", "Delete")
    val refresh: String = select("刷新", "Refresh")
    val retry: String = select("重试", "Retry")
    val save: String = select("保存", "Save")
    val stop: String = select("停止", "Stop")
    val more: String = select("更多", "More")
    val showFullPayload: String = select("显示完整载荷", "Show full payload")
    val cameraPermissionForQr: String = select("扫描 VibeLink 二维码需要相机权限。", "Camera permission is needed to scan the VibeLink QR.")
    val allowCamera: String = select("允许相机", "Allow camera")
    val taskChanges: String = select("任务变更", "Task changes")
    val pushDelivery: String = select("推送投递", "Push delivery")
    val provider: String = select("提供方", "Provider")
    val token: String = select("Token", "Token")
    fun model(value: String): String = select("模型：$value", "Model: $value")
    val loginForm: String = select("连接表单", "Connection form")
    val connectionStatus: String = select("连接状态", "Connection status")
    val loadingSavedConnection: String = select("正在加载已保存的连接", "Loading saved connection")

    val settings: String = select("设置", "Settings")
    val language: String = select("语言", "Language")
    val displayLanguage: String = select("显示语言", "Display language")
    val chinese: String = select("中文", "Chinese")
    val english: String = select("英文", "English")
    val languageNotice: String = select("界面语言已更新。", "Display language updated.")

    val newChat: String = select("新建会话", "New chat")
    val searchChats: String = select("搜索会话", "Search chats")
    val showActiveChats: String = select("显示活跃会话", "Show active chats")
    val showArchivedChats: String = select("显示归档会话", "Show archived")
    val logout: String = select("退出登录", "Log out")
    val liveCall: String = select("实时通话", "Live Call")
    val workspace: String = select("工作区", "Workspace")
    val review: String = select("PR 审查", "PR Review")
    val active: String = select("活跃", "Active")
    val archived: String = select("已归档", "Archived")
    val syncNow: String = select("立即同步", "Sync now")
    val couldNotLoadChats: String = select("无法加载会话", "Could not load chats")
    val noArchivedChats: String = select("暂无归档会话", "No archived chats")
    val noChatsYet: String = select("暂无会话", "No chats yet")
    val archivedChatsHint: String = select("归档后的会话会显示在这里。", "Archived conversations will appear here.")
    val emptyChatsHint: String = select(
        "新建一个 VibeLink Agent 任务，或同步 Codex 远程会话。",
        "Start a VibeLink Agent task or sync Codex Remote.",
    )
    val untitledChat: String = select("未命名会话", "Untitled chat")
    val pinned: String = select("已置顶", "Pinned")
    val chatActions: String = select("会话操作", "Chat actions")
    val rename: String = select("重命名", "Rename")
    val unpin: String = select("取消置顶", "Unpin")
    val pin: String = select("置顶", "Pin")
    val fork: String = select("分叉", "Fork")
    val restore: String = select("恢复", "Restore")
    val archive: String = select("归档", "Archive")
    val renameChat: String = select("重命名会话", "Rename chat")
    val forkChat: String = select("分叉会话", "Fork chat")
    val linkedDesktopConversation: String = select(
        "已连接到当前可见的 Codex Desktop 会话。",
        "Linked to visible Codex Desktop conversation.",
    )
    val runningNow: String = select("正在运行。", "Running now.")
    val sourceChat: String = select("源会话", "source chat")
    fun forkedFrom(source: String): String = select("分叉自 $source。", "Forked from $source.")
    fun codexRemoteLabel(): String = select("Codex 远程", "Codex Remote")
    fun agentLabel(): String = select("智能体", "Agent")

    val liveCallAssistant: String = select("实时通话助手", "Live Call Assistant")
    val manualTranscript: String = select("手动转录", "Manual transcript")
    val defaultTranscriptPrompt: String = select(
        "请介绍一下你自己，以及最近最有代表性的项目？",
        "Please introduce yourself and your strongest recent project?",
    )
    val microphonePermissionDenied: String = select("麦克风权限被拒绝。", "Microphone permission was denied.")
    val sendTranscript: String = select("发送转录", "Send transcript")
    val audioLevels: String = select("音频电平", "Audio levels")
    val remote: String = select("远端", "Remote")
    val local: String = select("本机", "Local")
    val finalTranscript: String = select("最终", "final")
    val partialTranscript: String = select("临时", "partial")
    val qa: String = select("问答", "Q&A")
    val sessions: String = select("会话", "Sessions")
    val noLiveCallSessions: String = select("暂无实时通话会话。", "No Live Call sessions yet.")
    fun selectedShortId(id: String): String = select("已选择 ${id.take(8)}", "Selected ${id.take(8)}")
    fun liveCallSessionStatus(status: String): String = when (status) {
        "ready" -> ready
        "active" -> select("活跃", "active")
        "paused" -> select("已暂停", "paused")
        "stopped" -> select("已停止", "stopped")
        else -> status
    }
    val assistant: String = select("助手", "Assistant")
    val modelOverride: String = select("模型覆盖", "Model override")
    val asrProvider: String = select("ASR 提供方", "ASR provider")
    val asrProviderPlaceholder: String = select("mock / whisper / 提供方 ID", "mock / whisper / provider id")
    val asrDiagnostics: String = select("ASR 诊断", "ASR diagnostics")
    val asrPipelineHint: String = select(
        "音频会先归一化为 16 kHz 单声道，并在进入提供方前做 VAD 分段。",
        "16 kHz mono normalization + VAD segmentation before provider.",
    )
    val noAsrDiagnostics: String = select("尚未加载 ASR 提供方诊断。", "No ASR provider diagnostics loaded.")
    val ready: String = select("就绪", "ready")
    val unavailable: String = select("不可用", "unavailable")
    val activeSuffix: String = select(" · 当前", " · active")
    val recover: String = select("恢复", "Recover")
    fun checkpoints(count: Int): String = select("$count 个检查点", "$count checkpoint(s)")
    val providerPending: String = select("等待提供方", "provider pending")
    fun segments(count: Int): String = select("$count 段", "$count segment(s)")
    val recordings: String = select("录音文件", "Recordings")
    fun localPcmFiles(count: Int): String = select("$count 个本地 PCM 文件", "$count local PCM files")
    val recordingListRefreshed: String = select("录音列表已刷新。", "Recording list refreshed.")
    val noRecordings: String = select("还没有保存录音。", "No recordings saved yet.")
    fun deleted(name: String): String = select("已删除 $name。", "Deleted $name.")
    fun couldNotDelete(name: String): String = select("无法删除 $name。", "Could not delete $name.")
    fun showingLatestRecordings(count: Int): String = select("显示最近 6 个，共 $count 个。", "Showing latest 6 of $count.")
    fun sessionId(id: String): String = select("会话 $id", "Session $id")
    val workspaceBound: String = select("已绑定工作区", "Workspace bound")
    val pause: String = select("暂停", "Pause")
    val resume: String = select("继续", "Resume")
    val startMic: String = select("启动麦克风", "Start mic")
    val stopMic: String = select("停止麦克风", "Stop mic")
    val foregroundMicHint: String = select(
        "前台麦克风采集可在后台继续运行；页面恢复后会自动补齐实时通话事件。",
        "Foreground microphone capture can keep running in the background; live-call events catch up when the page resumes.",
    )
    val loadingLiveCallSession: String = select("正在加载会话", "Loading session")
    val creatingLiveCall: String = select("正在创建实时通话", "Creating live call")
    val emptyLiveCallSession: String = select("Bridge 返回了空会话", "Bridge returned an empty session")
    val liveCallStarted: String = select("实时通话已开始", "Live call started")
    val audioStreamConnected: String = select("音频流已连接", "Audio stream connected")
    val audioStreamDisconnected: String = select("音频流已断开", "Audio stream disconnected")
    val asrProviderSelected: String = select("已选择 ASR 提供方", "ASR provider selected")
    val audioSegmentReady: String = select("语音片段已就绪", "Audio segment ready")
    val asrCheckpointRecovered: String = select("ASR 检查点已恢复", "ASR checkpoint recovered")
    val listening: String = select("正在聆听", "Listening")
    val transcriptReceived: String = select("已收到转录", "Transcript received")
    val questionDetected: String = select("检测到问题", "Question detected")
    val assistantThinking: String = select("助手正在思考", "Assistant is thinking")
    val assistantAnswering: String = select("助手正在回答", "Assistant is answering")
    val assistantAnswerReady: String = select("助手回答已就绪", "Assistant answer ready")
    val paused: String = select("已暂停", "Paused")
    val continued: String = select("已继续", "Resumed")
    val recording: String = select("录音中", "Recording")
    val connecting: String = select("正在连接", "Connecting")
    val pausing: String = select("正在暂停", "Pausing")
    val resuming: String = select("正在继续", "Resuming")
    val stopping: String = select("正在停止", "Stopping")
    val networkRequestFailed: String = select("网络请求失败", "Network request failed")
    val liveCallNotConnected: String = select("控制失败：实时通话尚未连接", "Control failed: live call is not connected")
    val liveCallNotificationChannel: String = select("实时通话助手", "Live Call Assistant")
    val pushNotificationChannel: String = select("VibeLink 通知", "VibeLink notifications")
    val liveTranscript: String = select("实时转录", "Live transcript")
    val thinking: String = select("思考中…", "Thinking…")
    fun liveCallReady(id: String): String = select("实时通话 ${id.take(8)} 已就绪", "Live call ${id.take(8)} is ready")
    fun loadingLiveCallSessionsFailed(message: String): String = select("加载实时通话会话失败", "Failed to load live-call sessions").withMessage(message)
    fun loadingLiveCallEventsFailed(message: String): String = select("加载实时通话事件失败", "Failed to load live-call events").withMessage(message)
    fun createLiveCallFailed(message: String): String = select("创建实时通话失败", "Failed to create live call").withMessage(message)
    fun stopLiveCallFailed(message: String): String = select("停止实时通话失败", "Failed to stop live call").withMessage(message)
    fun pauseLiveCallFailed(message: String): String = select("暂停实时通话失败", "Failed to pause live call").withMessage(message)
    fun resumeLiveCallFailed(message: String): String = select("继续实时通话失败", "Failed to resume live call").withMessage(message)
    fun asrDiagnosticsRefreshed(): String = select("ASR 诊断已刷新。", "ASR diagnostics refreshed.")
    fun asrRecoverySent(count: Int): String = select("已为 $count 个检查点发送恢复事件。", "Sent recovery events for $count checkpoint(s).")
    fun asrCheckpointRecoveryFailed(message: String): String = select("恢复 ASR 检查点失败", "Failed to recover ASR checkpoints").withMessage(message)
    fun transcriptSent(final: Boolean): String = if (final) select("转录已发送", "Transcript sent") else select("临时转录已发送", "Partial transcript sent")
    fun sendTranscriptFailed(message: String): String = select("发送转录失败", "Failed to send transcript").withMessage(message)
    val createOrSelectLiveCallFirst: String = select("请先创建或选择实时通话。", "Create or select a live call first.")
    val backgroundMicServiceStarted: String = select("后台麦克风服务已启动", "Background microphone service started")
    val startingMic: String = select("正在启动麦克风", "Starting microphone")
    fun parseLiveCallEventFailed(message: String): String = select("解析实时通话事件失败", "Failed to parse live-call event").withMessage(message)
    val liveCallEventStreamDisconnected: String = select("实时通话事件流已断开，正在重连", "Live-call event stream disconnected; reconnecting")
    fun liveCallReconnectFailed(message: String): String = select("实时通话重连失败", "Live-call reconnect failed").withMessage(message)
    val liveCallEventsRecovered: String = select("实时通话事件已恢复", "Live-call events recovered")
    fun runtimeError(message: String): String = select("错误：$message", "Error: $message")
    fun controlFailed(action: String, message: String): String = select("${action}失败：$message", "$action failed: $message")

    val bridgeConnection: String = select("Bridge 连接", "Bridge connection")
    val scanQrCode: String = select("扫描二维码", "Scan QR code")
    val closeScanner: String = select("关闭扫码", "Close scanner")
    val bridgeUrl: String = select("Bridge 地址", "Bridge URL")
    val pairingToken: String = select("配对 Token", "Pairing token")
    val legacyTokenPlaceholder: String = select("Bridge 设置里的旧配对 Token", "Legacy token from bridge settings")
    val legacyTokenNotice: String = select(
        "旧版 Token 登录已禁用，请扫描二维码并在已有会话中批准设备。",
        "Legacy token login is disabled. Scan the QR code and approve this device from an existing session.",
    )
    val connectWithToken: String = select("使用 Token 连接", "Connect with token")
    val createPairingRequest: String = select("创建配对请求", "Create pairing request")
    val invalidPairingQr: String = select("无效的 VibeLink 配对二维码。", "Invalid VibeLink pairing QR.")
    val scanPairingHint: String = select(
        "扫描 VibeLink 二维码，或输入配对 Token。",
        "Scan the VibeLink QR code or enter a pairing token.",
    )
    val pairingQrScanned: String = select(
        "已扫描配对二维码。请在 VibeLink 中确认此设备，并保持本页打开。",
        "Pairing QR scanned. Confirm this device in VibeLink and keep this page open.",
    )
    val savedConnectionUnavailable: String = select("已保存连接不可用。", "Saved connection is unavailable.")
    fun savedTokenConnectionFailed(message: String): String = select("已保存 Token 连接失败", "Saved token connection failed").withMessage(message)
    fun pairingStatus(status: String, code: String): String = select("配对状态：$status。验证码：$code", "Pairing status: $status. Verification code: $code")
    fun pairingCheckFailed(message: String): String = select("配对检查失败", "Pairing check failed").withMessage(message)
    val loginFailedEmptyDeviceToken: String = select("登录失败：设备 Token 为空。", "Login failed: device token is empty.")
    fun loginFailed(message: String): String = select("登录失败", "Login failed").withMessage(message)
    fun approveDevicePrompt(code: String): String = select(
        "请在 VibeLink 中批准此设备，并保持本页打开。验证码：$code",
        "Approve this device in VibeLink and keep this page open. Verification code: $code",
    )
    val pairingRequestEmpty: String = select("配对请求失败：会话为空。", "Pairing request failed: session is empty.")
    fun pairingRequestFailed(message: String): String = select("配对请求失败", "Pairing request failed").withMessage(message)
    fun pairingIdAndCode(id: String, code: String): String = select("配对 ID：${id.take(8)} / 验证码：$code", "Pairing ID: ${id.take(8)} / code: $code")
    fun isNegativeStatus(value: String): Boolean = value.contains(select("失败", "failed"), ignoreCase = true) ||
        value.contains(select("拒绝", "denied"), ignoreCase = true) ||
        value.contains("failed", ignoreCase = true) ||
        value.contains("denied", ignoreCase = true)

    val loadChatsFailed: String = select("加载会话失败", "Failed to load chats")
    val updateConversationFailed: String = select("更新会话失败", "Failed to update conversation")
    val conversationChangedElsewhere: String = select("会话已在其他设备修改，已刷新", "Conversation changed on another device; refreshed")
    val someConversationsChangedElsewhere: String = select("部分会话已在其他设备修改，已刷新", "Some conversations changed on another device; refreshed")
    val batchUpdateConversationFailed: String = select("批量更新会话失败", "Failed to update conversations")
    val forkConversationFailed: String = select("分叉会话失败", "Failed to fork conversation")
    val searchFailed: String = select("搜索失败", "Search failed")
    val codexRemoteUnchecked: String = select("Codex 远程：未检查", "Codex Remote: not checked")
    val codexRemoteReady: String = select("Codex 远程：已就绪", "Codex Remote: ready")
    val codexRemoteDisconnected: String = select("Codex 远程：未连接", "Codex Remote: disconnected")
    val codexDesktopDisconnected: String = select("Codex Desktop 未连接。", "Codex Desktop is not connected.")
    val codexDesktopFound: String = select("已找到窗口", "Window found")
    val codexDesktopWindowMissing: String = select("未找到 Codex Desktop 窗口。", "Codex Desktop window was not found.")
    val codexDesktopRemoteTitle: String = select("Codex Desktop 远程", "Codex Desktop Remote")
    fun forkTitle(title: String): String = select("$title 分叉", "$title fork")
    fun agentTask(provider: String): String = select("$provider 任务", "$provider task")
    fun codexRemoteWithReason(reason: String): String = select("Codex 远程：$reason", "Codex Remote: $reason")

    val loadSettingsFailed: String = select("加载设置失败", "Failed to load settings")
    val settingsSaved: String = select("设置已保存。", "Settings saved.")
    val settingsChangedElsewhere: String = select("设置已在其他设备修改；已刷新并保留本机更改，请检查后重试。", "Settings changed on another device; refreshed with local edits preserved. Review and retry.")
    val saveSettingsFailed: String = select("保存设置失败", "Failed to save settings")
    val androidApprovalApprovedReason: String = select("已在 Android 端批准。", "Approved on Android.")
    val androidApprovalDeniedReason: String = select("已在 Android 端拒绝。", "Denied on Android.")
    val approvalApproved: String = select("审批已批准。", "Approval approved.")
    val approvalDenied: String = select("审批已拒绝。", "Approval denied.")
    val approvalActionFailed: String = select("审批操作失败", "Approval action failed")
    val pairingApproved: String = select("配对已批准。", "Pairing approved.")
    val pairingDenied: String = select("配对已拒绝。", "Pairing denied.")
    val pairingActionFailed: String = select("配对操作失败", "Pairing action failed")
    val deviceRevoked: String = select("设备已撤销。", "Device revoked.")
    val revokeDeviceFailed: String = select("撤销设备失败", "Failed to revoke device")
    val mcpProbeCompleted: String = select("MCP 探测已完成。", "MCP probe completed.")
    val mcpProbeFoundIssues: String = select("MCP 探测发现问题。", "MCP probe found issues.")
    val mcpProbeFailed: String = select("MCP 探测失败", "MCP probe failed")
    val toolPrunePreviewReady: String = select("工具事件清理预览已就绪。", "Tool-event prune preview is ready.")
    val toolPruned: String = select("工具事件已清理。", "Tool events pruned.")
    val toolPruneFailed: String = select("工具事件清理失败", "Tool-event prune failed")
    val settingsExportReady: String = select("设置导出已就绪。", "Settings export is ready.")
    val settingsExportFailed: String = select("设置导出失败", "Settings export failed")
    val settingsImportPreviewReady: String = select("导入预览已就绪。", "Import preview is ready.")
    val settingsImportPreviewFailed: String = select("设置导入预览失败", "Settings import preview failed")
    val settingsImported: String = select("设置已导入。", "Settings imported.")
    val settingsImportFailed: String = select("设置导入失败", "Settings import failed")
    val nativePushTokenRegistered: String = select("原生推送 Token 已注册。", "Native push token registered.")
    val nativePushRegistrationFailed: String = select("原生推送注册失败", "Native push registration failed")
    val currentDeviceTokenRotated: String = select("当前设备 token 已轮换，请重新连接。", "Current device token rotated; reconnect.")
    val rotateDeviceTokenFailed: String = select("轮换设备 token 失败", "Failed to rotate device token")

    val legacyDisconnect: String = select("断开", "Disconnect")
    val legacyQuestionPlaceholder: String = select("请介绍一下你自己", "Please introduce yourself")
    fun legacyCallActive(id: String): String = select("通话中 ($id)", "In call ($id)")
    val legacyCreateCall: String = select("创建通话", "Create call")
    val legacyStopCall: String = select("停止通话", "Stop call")
    val legacyAudioLevel: String = select("音频电平", "Audio level")
    val legacyRemote: String = select("远程", "Remote")
    val legacyLocal: String = select("本地", "Local")
    val legacyMockQuestion: String = select("模拟问题", "Mock question")
    val legacySendQuestion: String = select("发送问题", "Send question")
    val legacyQuestionSent: String = select("问题已发送", "Question sent")
    fun legacyCreateFailed(message: String): String = select("创建失败", "Create failed").withMessage(message)
    fun legacyStopFailed(message: String): String = select("停止失败", "Stop failed").withMessage(message)
    fun legacySendFailed(message: String): String = select("发送失败", "Send failed").withMessage(message)
    val legacyStopped: String = select("已停止", "Stopped")
    val legacyLoginBridgeConnection: String = select("Bridge 连接", "Bridge connection")
    val legacyPairingToken: String = select("配对 Token", "Pairing token")
    val legacyPairingTokenHint: String = select("从 Settings 获取", "Get it from Settings")
    val legacyConnecting: String = select("连接中…", "Connecting…")
    val legacyServiceUnavailable: String = select("服务不可用", "Service unavailable")
    val legacyLoginSuccess: String = select("登录成功", "Login successful")
    val legacyInvalidToken: String = select("登录失败：token 无效", "Login failed: invalid token")
    val legacyConnectedPrompt: String = select("已连接到服务，输入配对 Token 登录", "Connected to service; enter a pairing token to log in")
    fun legacyConnectionFailed(message: String): String = select("连接失败", "Connection failed").withMessage(message)
    val legacyConnect: String = select("连接", "Connect")

    val loading: String = select("加载中", "Loading")
    val quickCommands: String = select("快捷指令", "Quick commands")
    val recentPrompts: String = select("最近提示词", "Recent prompts")
    val clear: String = select("清空", "Clear")
    val send: String = select("发送", "Send")
    val chat: String = select("会话", "Chat")
    val running: String = select("运行中", "running")
    val vibelinkAgent: String = select("VibeLink 智能体", "VibeLink Agent")
    val retryRemoteQueue: String = select("重试远程队列", "Retry remote queue")
    val clearRemoteQueue: String = select("清空远程队列", "Clear remote queue")
    val stopTask: String = select("停止任务", "Stop task")
    val codexRemoteCurrentSettings: String = select(
        "Codex 远程会使用当前 Codex Desktop 设置",
        "Codex Remote uses the current Codex Desktop settings",
    )
    val providerDefault: String = select("提供方默认", "provider default")
    val defaultOption: String = select("默认", "Default")
    val defaultEffort: String = select("默认推理强度", "Default effort")
    val workingDirectory: String = select("工作目录", "Working directory")
    val attachImage: String = select("添加图片", "Attach image")
    val attachFile: String = select("添加文件", "Attach file")
    val sendToCodexDesktop: String = select("发送到 Codex Desktop", "Send to Codex Desktop")
    val messageVibeLinkAgent: String = select("发送给 VibeLink 智能体", "Message VibeLink Agent")
    val composerOptions: String = select("输入选项", "Composer options")
    val openLiveCall: String = select("打开实时通话", "Open Live Call")
    val stopCurrentTask: String = select("停止当前任务", "Stop current task")
    val copyCodeBlocks: String = select("复制代码块", "Copy code blocks")
    val copyFileReferences: String = select("复制文件引用", "Copy file references")
    val copyMessage: String = select("复制消息", "Copy message")
    val collapseMessage: String = select("折叠消息", "Collapse message")
    val expandMessage: String = select("展开消息", "Expand message")
    val messageActions: String = select("消息操作", "Message actions")
    val edit: String = select("编辑", "Edit")
    val regenerate: String = select("重新生成", "Regenerate")
    val agentTyping: String = select("智能体正在输入", "Agent is typing")
    val image: String = select("图片", "Image")
    val copyFileReference: String = select("复制文件引用", "Copy file reference")
    val openApprovals: String = select("打开审批", "Open approvals")
    val uploadingAttachment: String = select("正在上传附件", "Uploading attachment")
    val attachmentUploadFailed: String = select("附件上传失败", "Attachment upload failed")
    val file: String = select("文件", "file")
    fun attached(name: String): String = select("已附加 $name", "Attached $name")
    val you: String = select("你", "You")
    val agent: String = select("智能体", "Agent")
    val error: String = select("错误", "Error")
    val system: String = select("系统", "System")
    val copied: String = select("已复制", "Copied")
    val codeCopied: String = select("代码已复制", "Code copied")
    val fileReferencesCopied: String = select("文件引用已复制", "File references copied")
    val fileReferenceCopied: String = select("文件引用已复制", "File reference copied")
    val restoringChat: String = select("正在恢复会话", "Restoring chat")
    val startWithContext: String = select("带着上下文开始", "Start with context")
    val suggestionSummarizeWorkspace: String = select(
        "总结当前工作区状态",
        "Summarize the current workspace status",
    )
    val suggestionReviewChanges: String = select(
        "审查最新变更和风险",
        "Review the latest changes and risks",
    )
    val suggestionPlanNextStep: String = select(
        "规划下一步稳妥实现",
        "Plan the next safe implementation step",
    )

    fun statusLabel(status: String, kind: String): String = when (status) {
        "running" -> select("运行中", "running")
        "failed", "error" -> select("错误", "error")
        "history" -> select("历史", "history")
        "fork" -> select("分叉", "fork")
        "desktop" -> select("远程", "remote")
        "completed" -> select("完成", "done")
        else -> status.ifBlank { kind }
    }

    fun timeAgo(minutes: Long, hours: Long, days: Long): String = when {
        minutes < 1 -> select("刚刚", "now")
        minutes < 60 -> select("${minutes}分", "${minutes}m")
        hours < 24 -> select("${hours}时", "${hours}h")
        days < 7 -> select("${days}天", "${days}d")
        else -> select("${days / 7}周", "${days / 7}w")
    }

    fun speakerLabel(value: String): String = when (value) {
        "local" -> local
        else -> remote
    }

    private fun select(chinese: String, english: String): String {
        return if (appLanguage == AppLanguage.Chinese) chinese else english
    }

    private fun String.withMessage(message: String): String = if (message.isBlank()) this else "$this: $message"

    fun text(chinese: String, english: String): String = select(chinese, english)
}

fun appStringsFor(language: AppLanguage): AppStrings = AppStrings(language)

val LocalAppStrings = staticCompositionLocalOf { appStringsFor(AppLanguage.Default) }
