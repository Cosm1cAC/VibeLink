package com.vibelink.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.foundation.isSystemInDarkTheme
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
    val DarkBackground = Color(0xFF111413)
    val DarkSurface = Color(0xFF181C1B)
    val DarkSurfaceSoft = Color(0xFF222826)
    val DarkOnSurface = Color(0xFFE6ECE9)
    val DarkOnSurfaceVariant = Color(0xFFB6C1BD)
    val DarkLine = Color(0xFF39423F)
    val DarkPrimary = Color(0xFF9AD8D2)
    val DarkPrimaryContainer = Color(0xFF173C3A)
    val DarkSecondaryContainer = Color(0xFF163B2E)
    val DarkErrorContainer = Color(0xFF55231F)
}

private val DarkColorScheme = darkColorScheme(
    primary = ColorSchemeTokens.DarkPrimary,
    onPrimary = Command,
    primaryContainer = ColorSchemeTokens.DarkPrimaryContainer,
    onPrimaryContainer = ColorSchemeTokens.DarkOnSurface,
    secondary = Teal,
    onSecondary = Surface,
    secondaryContainer = ColorSchemeTokens.DarkSecondaryContainer,
    onSecondaryContainer = ColorSchemeTokens.DarkOnSurface,
    tertiary = Blue,
    onTertiary = Surface,
    tertiaryContainer = Color(0xFF1E314D),
    onTertiaryContainer = ColorSchemeTokens.DarkOnSurface,
    background = ColorSchemeTokens.DarkBackground,
    onBackground = ColorSchemeTokens.DarkOnSurface,
    surface = ColorSchemeTokens.DarkSurface,
    onSurface = ColorSchemeTokens.DarkOnSurface,
    surfaceVariant = ColorSchemeTokens.DarkSurfaceSoft,
    onSurfaceVariant = ColorSchemeTokens.DarkOnSurfaceVariant,
    outline = ColorSchemeTokens.DarkLine,
    outlineVariant = Color(0xFF4C5754),
    error = Color(0xFFFFB4A8),
    onError = Command,
    errorContainer = ColorSchemeTokens.DarkErrorContainer,
    onErrorContainer = Color(0xFFFFDAD5),
)

@Composable
fun VibeLinkTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme,
        content = content
    )
}
