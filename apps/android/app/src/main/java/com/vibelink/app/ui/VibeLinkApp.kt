package com.vibelink.app.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.navigation.navDeepLink
import com.vibelink.app.data.SettingsStore
import com.vibelink.app.network.ApiClient
import com.vibelink.app.network.ConversationItem
import com.vibelink.app.ui.screens.*

/**
 * Root composable for VibeLink Android.
 * Navigation: login 鈫?sessionList 鈫?messageList / call
 */
@Composable
fun VibeLinkApp(initialPairingUri: String? = null, initialSharedText: String = "") {
    val navController = rememberNavController()
    val apiClient = remember { ApiClient() }

    val context = LocalContext.current
    val settingsStore = remember { SettingsStore(context.applicationContext) }
    // Shared ViewModels (scoped to app-level, retained via remember)
    val sessionListViewModel = remember { SessionListViewModel() }
    val messageListViewModel = remember { MessageListViewModel() }
    val workspaceViewModel = remember { WorkspaceViewModel() }
    val callViewModel = remember { CallViewModel() }
    val settingsViewModel = remember { SettingsViewModel() }

    // Currently selected conversation (pass through navigation)
    var pendingConversation by remember { mutableStateOf<ConversationItem?>(null) }

    NavHost(navController = navController, startDestination = "login") {
        // 鈹€鈹€ Login 鈹€鈹€
        composable("login") {
            LoginScreen(
                apiClient = apiClient,
                settingsStore = settingsStore,
                initialPairingUri = initialPairingUri,
                onLoginSuccess = {
                    navController.navigate("sessionList") {
                        popUpTo("login") { inclusive = true }
                    }
                }
            )
        }

        // 鈹€鈹€ Session List 鈹€鈹€
        composable("sessionList") {
            SessionListScreen(
                apiClient = apiClient,
                viewModel = sessionListViewModel,
                onSelectConversation = { conversation ->
                    pendingConversation = conversation
                    navController.navigate("messageList/${conversation.key.replace("/", "~")}")
                },
                onNewConversation = {
                    val conversation = ConversationItem(
                        key = "new:${System.currentTimeMillis()}",
                        kind = "new",
                        provider = "codex",
                        title = "New VibeLink Agent task",
                        status = "new",
                    )
                    pendingConversation = conversation
                    navController.navigate("messageList/${conversation.key}")
                },
                onLogout = {
                    navController.navigate("login") {
                        popUpTo("sessionList") { inclusive = true }
                    }
                },
                onOpenLiveCall = {
                    navController.navigate("call")
                },
                onOpenWorkspace = {
                    navController.navigate("workspace")
                },
                onOpenSettings = {
                    navController.navigate("settings")
                },
            )
        }

        // 鈹€鈹€ Message List (detail) 鈹€鈹€
        composable(
            route = "messageList/{conversationKey}",
            arguments = listOf(navArgument("conversationKey") { type = NavType.StringType }),
        ) { backStackEntry ->
            val key = backStackEntry.arguments?.getString("conversationKey")?.replace("~", "/") ?: ""
            val conversation = pendingConversation

            MessageListScreen(
                apiClient = apiClient,
                viewModel = messageListViewModel,
                conversation = conversation,
                onBack = {
                    pendingConversation = null
                    navController.popBackStack()
                },
            )
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
                onBack = { navController.popBackStack() },
            )
        }

        composable("settings") {
            SettingsScreen(
                apiClient = apiClient,
                viewModel = settingsViewModel,
                onBack = { navController.popBackStack() },
            )
        }
    }

    LaunchedEffect(initialSharedText) {
        val text = initialSharedText.trim()
        if (text.isBlank()) return@LaunchedEffect
        val conversation = ConversationItem(
            key = "share:${System.currentTimeMillis()}",
            kind = "new",
            provider = "codex",
            title = "Shared to VibeLink",
            status = "new",
            preview = text.take(160),
        )
        pendingConversation = conversation
        navController.navigate("messageList/${conversation.key}")
    }
}
