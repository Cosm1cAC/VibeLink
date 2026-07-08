package com.vibelink.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColorScheme = lightColorScheme(
    primary = Command,
    onPrimary = Surface,
    primaryContainer = Side,
    onPrimaryContainer = Ink,
    secondary = Teal,
    onSecondary = Surface,
    secondaryContainer = ColorSchemeTokens.SuccessContainer,
    onSecondaryContainer = TealDark,
    tertiary = Blue,
    onTertiary = Surface,
    tertiaryContainer = ColorSchemeTokens.InfoContainer,
    onTertiaryContainer = Blue,
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
    errorContainer = ColorSchemeTokens.ErrorContainer,
    onErrorContainer = Coral,
)

private object ColorSchemeTokens {
    val SuccessContainer = Color(0xFFDFF3EB)
    val InfoContainer = Color(0xFFE8EEF7)
    val ErrorContainer = Color(0xFFFAE5E1)
}

@Composable
fun VibeLinkTheme(
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = LightColorScheme,
        content = content
    )
}
