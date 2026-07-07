package com.vibelink.app.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
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
 * Navigation: login → sessionList → messageList / call
 */
@Composable
fun VibeLinkApp() {
    val navController = rememberNavController()
    val apiClient = remember { ApiClient() }

    // Shared ViewModels (scoped to app-level, retained via remember)
    val sessionListViewModel = remember { SessionListViewModel() }
    val messageListViewModel = remember { MessageListViewModel() }
    val workspaceViewModel = remember { WorkspaceViewModel() }
    val callViewModel = remember { CallViewModel() }

    // Currently selected conversation (pass through navigation)
    var pendingConversation by remember { mutableStateOf<ConversationItem?>(null) }

    NavHost(navController = navController, startDestination = "login") {
        // ── Login ──
        composable("login") {
            LoginScreen(
                apiClient = apiClient,
                onLoginSuccess = {
                    navController.navigate("sessionList") {
                        popUpTo("login") { inclusive = true }
                    }
                }
            )
        }

        // ── Session List ──
        composable("sessionList") {
            SessionListScreen(
                apiClient = apiClient,
                viewModel = sessionListViewModel,
                onSelectConversation = { conversation ->
                    pendingConversation = conversation
                    navController.navigate("messageList/${conversation.key.replace("/", "~")}")
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
                }
            )
        }

        // ── Message List (detail) ──
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

        // ── Live Call ──
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
    }
}
