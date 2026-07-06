package com.vibelink.app.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.vibelink.app.data.SettingsStore
import com.vibelink.app.network.ApiClient
import com.vibelink.app.ui.screens.CallScreen
import com.vibelink.app.ui.screens.LoginScreen

/**
 * Root composable for VibeLink Android.
 * Handles navigation between Login → Call screen.
 */
@Composable
fun VibeLinkApp() {
    val navController = rememberNavController()
    val apiClient = remember { ApiClient() }

    NavHost(navController = navController, startDestination = "login") {
        composable("login") {
            LoginScreen(
                apiClient = apiClient,
                onLoginSuccess = {
                    navController.navigate("call") {
                        popUpTo("login") { inclusive = true }
                    }
                }
            )
        }
        composable("call") {
            CallScreen(
                apiClient = apiClient,
                onLogout = {
                    navController.navigate("login") {
                        popUpTo("call") { inclusive = true }
                    }
                }
            )
        }
    }
}
