package com.vibelink.app.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ComposerActionRowTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun longModeLabelKeepsActionInsideNarrowComposer() {
        composeRule.setContent {
            Row(Modifier.size(width = 320.dp, height = 48.dp).testTag("composer")) {
                ComposerModeSlot {
                    Text("Codex remote uses the current Codex Desktop settings without truncating the action")
                }
                Box(Modifier.size(44.dp).testTag("send"))
            }
        }

        composeRule.onNodeWithTag("send").assertIsDisplayed()
        val composerRight = composeRule.onNodeWithTag("composer").getUnclippedBoundsInRoot().right
        val sendRight = composeRule.onNodeWithTag("send").getUnclippedBoundsInRoot().right
        assertTrue(sendRight <= composerRight)
    }
}
