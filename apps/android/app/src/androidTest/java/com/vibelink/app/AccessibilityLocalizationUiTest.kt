package com.vibelink.app

import android.content.Context
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.vibelink.app.data.AppLanguage
import com.vibelink.app.data.SettingsStore
import com.vibelink.app.network.ApiClient
import com.vibelink.app.ui.i18n.LocalAppStrings
import com.vibelink.app.ui.i18n.appStringsFor
import com.vibelink.app.ui.screens.LoginScreen
import com.vibelink.app.ui.theme.VibeLinkTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AccessibilityLocalizationUiTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val settingsStore = SettingsStore(context)

    @Before
    fun clearLogin() {
        runBlocking { settingsStore.clearSession() }
    }

    @Test
    fun talkBackTreeAndKeyboardExposeTheConnectionWorkflow() {
        renderLogin(width = 360.dp, height = 720.dp)

        composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)).assertExists()
        composeRule.onNode(
            SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, "Connection form"),
        ).assertExists()
        composeRule.onNode(
            SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion),
        ).assertExists()
        composeRule.onNode(hasText("Pairing token") and hasSetTextAction())
            .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Password))

        composeRule.onNode(hasText("Bridge URL") and hasSetTextAction()).performImeAction()
        composeRule.onNode(hasText("Pairing token") and hasSetTextAction()).assertIsFocused()
    }

    @Test
    fun phoneLargeFontKeepsTheFormWithinTheViewport() {
        val density = renderLogin(width = 360.dp, height = 640.dp, fontScale = 2f)
        val formWidth = composeRule.onNode(
            SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, "Connection form"),
        ).fetchSemanticsNode().boundsInRoot.width

        assertTrue(formWidth <= 360 * density + 1f)
        composeRule.onNodeWithText("Bridge connection").assertExists()
        composeRule.onNodeWithText("Create pairing request").assertExists()
    }

    @Test
    fun tabletKeepsTheFormReadableInsteadOfStretchingEdgeToEdge() {
        val density = renderLogin(width = 960.dp, height = 720.dp)
        val formWidth = composeRule.onNode(
            SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, "Connection form"),
        ).fetchSemanticsNode().boundsInRoot.width

        assertTrue(formWidth <= 560 * density + 1f)
        assertTrue(formWidth < 960 * density)
    }

    private fun renderLogin(width: Dp, height: Dp, fontScale: Float = 1f): Float {
        var densityValue = 1f
        composeRule.setContent {
            val platformDensity = LocalDensity.current
            densityValue = platformDensity.density
            ForcedSize(width, height) {
                CompositionLocalProvider(
                    LocalDensity provides Density(platformDensity.density, fontScale),
                    LocalAppStrings provides appStringsFor(AppLanguage.English),
                ) {
                    VibeLinkTheme {
                        LoginScreen(
                            apiClient = ApiClient(),
                            settingsStore = settingsStore,
                            onLoginSuccess = {},
                        )
                    }
                }
            }
        }
        composeRule.waitForIdle()
        return densityValue
    }
}

@androidx.compose.runtime.Composable
private fun ForcedSize(width: Dp, height: Dp, content: @androidx.compose.runtime.Composable () -> Unit) {
    val density = LocalDensity.current
    Layout(content = content, modifier = Modifier) { measurables, constraints ->
        val childWidth = with(density) { width.roundToPx() }
        val childHeight = with(density) { height.roundToPx() }
        val placeable = measurables.single().measure(
            androidx.compose.ui.unit.Constraints.fixed(childWidth, childHeight),
        )
        layout(
            childWidth.coerceIn(constraints.minWidth, constraints.maxWidth),
            childHeight.coerceIn(constraints.minHeight, constraints.maxHeight),
        ) {
            placeable.place(0, 0)
        }
    }
}
