package com.vibelink.app.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.navigation.navDeepLink
import com.vibelink.app.data.AppLanguage
import com.vibelink.app.data.SettingsStore
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ApiClientConnectionBootstrapper
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.network.SavedApiConnection
import com.vibelink.app.mobile.IncomingSharedContent
import com.vibelink.app.mobile.MobileResilienceRuntime
import com.vibelink.app.mobile.NetworkQuality
import com.vibelink.app.ui.i18n.LocalAppStrings
import com.vibelink.app.ui.i18n.appStringsFor
import com.vibelink.app.ui.screens.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Root composable for VibeLink Android.
 * Navigation: login -> conversation-first agent shell -> supporting tools.
 */
@Composable
fun VibeLinkApp(
    resilienceRuntime: MobileResilienceRuntime? = null,
    initialPairingUri: String? = null,
    initialSharedContent: IncomingSharedContent = IncomingSharedContent(),
    onSharedContentConsumed: () -> Unit = {},
) {
    val navController = rememberNavController()
    val apiClient = remember { ApiClient() }

    val context = LocalContext.current
    val settingsStore = remember { SettingsStore(context.applicationContext) }
    val connectionBootstrapper = remember(settingsStore) {
        ApiClientConnectionBootstrapper {
            SavedApiConnection(
                bridgeUrl = settingsStore.bridgeUrl.first(),
                token = settingsStore.getTokenSync(),
            )
        }
    }
    var connectionInitialized by remember { mutableStateOf(false) }
    var authenticated by remember { mutableStateOf(false) }
    LaunchedEffect(apiClient, connectionBootstrapper) {
        try {
            connectionBootstrapper.initialize(
                apiClient = apiClient,
                restoreToken = initialPairingUri == null,
            )
        } finally {
            connectionInitialized = true
        }
    }
    if (!connectionInitialized) return

    // Activity-scoped ViewModels survive configuration changes and clear with their owner.
    val sessionListViewModel: SessionListViewModel = viewModel()
    val messageListViewModel: MessageListViewModel = viewModel()
    val workspaceViewModel: WorkspaceViewModel = viewModel()
    val callViewModel: CallViewModel = viewModel()
    val settingsViewModel: SettingsViewModel = viewModel()

    // Currently selected conversation (pass through navigation)
    var pendingConversation by remember { mutableStateOf<ConversationItem?>(null) }
    var pendingSharedAttachments by remember { mutableStateOf<List<String>>(emptyList()) }
    val conversations by sessionListViewModel.conversations.collectAsState()
    val promptHistory by settingsStore.promptHistory.collectAsState(initial = emptyList())
    val appLanguage by settingsStore.appLanguage.collectAsState(initial = AppLanguage.Default)
    val appStrings = remember(appLanguage) { appStringsFor(appLanguage) }
    val appScope = rememberCoroutineScope()
    fun newConversation(): ConversationItem = ConversationItem(
        key = "new:${System.currentTimeMillis()}",
        kind = "new",
        provider = "codex",
        title = appStrings.newChat,
        status = "new",
    )

    LaunchedEffect(resilienceRuntime) {
        resilienceRuntime?.policy?.collect { policy ->
            val paused = policy.suspendRealtimeStreams
            messageListViewModel.setResiliencePaused(paused)
            workspaceViewModel.setResiliencePaused(paused)
            callViewModel.setResiliencePaused(paused)
        }
    }

    CompositionLocalProvider(LocalAppStrings provides appStrings) {
    NavHost(navController = navController, startDestination = "login") {
        // 鈹€鈹€ Login 鈹€鈹€
        composable("login") {
            LoginScreen(
                apiClient = apiClient,
                settingsStore = settingsStore,
                initialPairingUri = initialPairingUri,
                onLoginSuccess = {
                    authenticated = true
                    pendingConversation = newConversation()
                    navController.navigate("agent") {
                        popUpTo("login") { inclusive = true }
                    }
                }
            )
        }

        composable("agent") {
            AgentShell(
                apiClient = apiClient,
                viewModel = sessionListViewModel,
                activeConversation = pendingConversation,
                onSelectConversation = { pendingConversation = it },
                onNewConversation = {
                    pendingConversation = newConversation()
                },
                onLogout = {
                    appScope.launch {
                        settingsStore.clearSession()
                        withContext(Dispatchers.Main.immediate) {
                            apiClient.token = ""
                            authenticated = false
                            pendingConversation = null
                            navController.navigate("login") {
                                popUpTo("agent") { inclusive = true }
                            }
                        }
                    }
                },
                onOpenLiveCall = { navController.navigate("call") },
                onOpenWorkspace = { navController.navigate("workspace") },
                onOpenReview = { navController.navigate("review") },
                onOpenSettings = { section ->
                    navController.navigate(if (section.isBlank()) "settings" else "settings?section=$section")
                },
            ) { openDrawer ->
                MessageListScreen(
                    apiClient = apiClient,
                    viewModel = messageListViewModel,
                    conversation = pendingConversation,
                    onOpenDrawer = openDrawer,
                    onNewConversation = { pendingConversation = newConversation() },
                    onOpenApprovals = { navController.navigate("settings?section=approvals") },
                    onOpenLiveCall = { navController.navigate("call") },
                    onOpenFileReference = { reference ->
                        workspaceViewModel.openFileReference(apiClient, reference)
                        navController.navigate("workspace")
                    },
                    promptHistory = promptHistory,
                    onRememberPrompt = { prompt -> appScope.launch { settingsStore.addPromptHistory(prompt) } },
                    onClearPromptHistory = { appScope.launch { settingsStore.clearPromptHistory() } },
                    initialAttachmentUris = if (pendingConversation?.key?.startsWith("share:") == true) pendingSharedAttachments else emptyList(),
                    onInitialAttachmentsConsumed = { pendingSharedAttachments = emptyList() },
                    workspaceId = workspaceViewModel.selectedWorkspaceId.collectAsState().value,
                )
            }
        }

        // 鈹€鈹€ Live Call 鈹€鈹€
        composable("call") {
            CallScreen(
                apiClient = apiClient,
                viewModel = callViewModel,
                workspaceId = workspaceViewModel.selectedWorkspaceId.collectAsState().value,
                onBack = { navController.popBackStack() },
            )
        }

        composable("workspace") {
            WorkspaceScreen(
                apiClient = apiClient,
                viewModel = workspaceViewModel,
                onOpenApprovals = { navController.navigate("settings?section=approvals") },
                onBack = { navController.popBackStack() },
            )
        }

        composable("review") {
            val reviewViewModel: ReviewViewModel = viewModel()
            ReviewScreen(
                apiClient = apiClient,
                viewModel = reviewViewModel,
                onBack = { navController.popBackStack() },
            )
        }

        composable(
            route = "settings?section={section}",
            arguments = listOf(navArgument("section") {
                type = NavType.StringType
                defaultValue = ""
            }),
        ) { backStackEntry ->
            SettingsScreen(
                apiClient = apiClient,
                viewModel = settingsViewModel,
                language = appLanguage,
                initialSection = backStackEntry.arguments?.getString("section").orEmpty(),
                onApprovalDecision = { response ->
                    val messageHandled = messageListViewModel.applyApprovalDecision(apiClient, response)
                    val workspaceHandled = workspaceViewModel.applyApprovalDecision(apiClient, response)
                    val handled = messageHandled || workspaceHandled
                    if (handled && (response.approval?.status == "approved" || response.approval?.status == "denied")) {
                        navController.popBackStack()
                    }
                },
                onLanguageChange = { language ->
                    appScope.launch { settingsStore.setAppLanguage(language) }
                },
                onBack = { navController.popBackStack() },
            )
        }
    }

    LaunchedEffect(initialSharedContent, authenticated) {
        if (initialSharedContent.isEmpty || !authenticated) return@LaunchedEffect
        val text = initialSharedContent.composerText
        val conversation = ConversationItem(
            key = "share:${System.currentTimeMillis()}",
            kind = "new",
            provider = "codex",
            title = appStrings.brandName,
            status = "new",
            preview = text.take(160),
        )
        pendingConversation = conversation
        pendingSharedAttachments = initialSharedContent.streamUris
        navController.navigate("agent") { launchSingleTop = true }
        onSharedContentConsumed()
    }
    }
}
