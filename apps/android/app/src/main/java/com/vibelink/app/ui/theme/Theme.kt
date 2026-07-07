package com.vibelink.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.graphics.Color

private val LightColorScheme = lightColorScheme(
    primary = Teal,
    onPrimary = Surface,
    primaryContainer = TealDark,
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

private val DarkColorScheme = darkColorScheme(
    primary = Color(0xFF818CF8),
    onPrimary = Color(0xFF0F172A),
    primaryContainer = Color(0xFF4F46E5),
    secondary = Color(0xFF67E8F9),
    onSecondary = Color(0xFF0F172A),
    background = Color(0xFF0F172A),
    onBackground = Color(0xFFE0E7FF),
    surface = Color(0xFF1E293B),
    onSurface = Color(0xFFE0E7FF),
    surfaceVariant = Color(0xFF334155),
    onSurfaceVariant = Color(0xFFA5B4FC),
    outline = Color(0xFF1E3A5F),
    outlineVariant = Color(0xFF334155),
    error = Color(0xFFF87171),
    onError = Color(0xFF0F172A),
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
