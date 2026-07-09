package com.vibelink.app.ui.screens

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MessageContentUtilsTest {
    @Test
    fun extractsFencedCodeBlocksForCopyActions() {
        val markdown = """
            Here is the fix:

            ```kotlin
            fun answer() = 42
            ```

            And a command:

            ```bash
            ./gradlew test
            ```
        """.trimIndent()

        val blocks = MessageContentUtils.extractCodeBlocks(markdown)

        assertEquals(listOf("fun answer() = 42", "./gradlew test"), blocks)
    }

    @Test
    fun returnsEmptyListWhenMessageHasNoFencedCode() {
        val blocks = MessageContentUtils.extractCodeBlocks("No code here")

        assertTrue(blocks.isEmpty())
    }
}
