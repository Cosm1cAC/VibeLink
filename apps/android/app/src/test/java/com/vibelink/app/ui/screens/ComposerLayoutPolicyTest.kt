package com.vibelink.app.ui.screens

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ComposerLayoutPolicyTest {
    @Test
    fun hidesSupplementalControlsWhileImeIsVisible() {
        assertTrue(ComposerLayoutPolicy.showSupplementalContent(imeVisible = false))
        assertFalse(ComposerLayoutPolicy.showSupplementalContent(imeVisible = true))
    }
}
