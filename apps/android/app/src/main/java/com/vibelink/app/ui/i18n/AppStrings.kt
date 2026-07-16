package com.vibelink.app.ui.i18n

import androidx.compose.runtime.staticCompositionLocalOf
import com.vibelink.app.data.AppLanguage

class AppStrings(private val appLanguage: AppLanguage) {
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

    fun text(chinese: String, english: String): String = select(chinese, english)
}

fun appStringsFor(language: AppLanguage): AppStrings = AppStrings(language)

val LocalAppStrings = staticCompositionLocalOf { appStringsFor(AppLanguage.Default) }
