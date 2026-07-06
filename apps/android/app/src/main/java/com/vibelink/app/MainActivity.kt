package com.vibelink.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import com.vibelink.app.ui.VibeLinkApp
import com.vibelink.app.ui.theme.VibeLinkTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            VibeLinkTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    VibeLinkApp()
                }
            }
        }
    }
}
