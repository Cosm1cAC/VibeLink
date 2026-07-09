package com.vibelink.app.ui.screens

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PromptCommandCatalogTest {
    @Test
    fun exposesMobileCommandsForCommonAgentActions() {
        val ids = PromptCommandCatalog.commands.map { it.id }

        assertTrue("review" in ids)
        assertTrue("test" in ids)
        assertTrue("workspace" in ids)
        assertTrue("approvals" in ids)
    }

    @Test
    fun insertsCommandPromptBelowExistingDraft() {
        val command = PromptCommandCatalog.commands.first { it.id == "review" }

        val next = PromptCommandCatalog.applyCommand("Check this", command)

        assertEquals("Check this\n\n${command.prompt}", next)
    }
}
