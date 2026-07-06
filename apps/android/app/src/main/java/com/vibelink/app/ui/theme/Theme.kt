package com.vibelink.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColorScheme = lightColorScheme(
    primary = Teal,
    onPrimary = Surface,
    primaryContainer = Teal,
    secondary = Blue,
    onSecondary = Surface,
    background = Paper,
    onBackground = Ink,
    surface = Surface,
    onSurface = Ink,
    surfaceVariant = SurfaceSoft,
    onSurfaceVariant = InkSoft,
    outline = Line,
    outlineVariant = LineStrong,
    error = Coral,
    onError = Surface,
)

@Composable
fun VibeLinkTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightColorScheme,
        content = content
    )
}
