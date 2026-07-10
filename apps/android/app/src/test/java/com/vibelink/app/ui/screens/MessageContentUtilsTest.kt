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

    @Test
    fun extractsDeduplicatedFileReferences() {
        val text = """
            See apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListScreen.kt:247
            and docs/android-parity-closure-report.md. Ignore https://example.com/file.kt and repeat docs/android-parity-closure-report.md.
        """.trimIndent()

        val refs = MessageContentUtils.extractFileReferences(text)

        assertEquals(
            listOf(
                "apps/android/app/src/main/java/com/vibelink/app/ui/screens/MessageListScreen.kt:247",
                "docs/android-parity-closure-report.md",
            ),
            refs,
        )
    }

    @Test
    fun formatsAttachmentPromptWithPreview() {
        val prompt = MessageContentUtils.attachmentPromptText(
            name = "notes.md",
            markdown = "[notes.md](C:/tmp/notes.md)",
            preview = "# Notes\nShip it.",
        )

        assertEquals(
            "[notes.md](C:/tmp/notes.md)\n\n<attachment_preview name=\"notes.md\">\n# Notes\nShip it.\n</attachment_preview>",
            prompt,
        )
    }

    @Test
    fun extractsImageAndArtifactLinksWithoutAttachmentPreviewNoise() {
        val text = """
            Here is the screenshot ![chart](/api/attachments/chart.png)
            and report [summary.pdf](/api/attachments/summary.pdf).

            <attachment_preview name="summary.pdf">
            noisy preview [ignored.txt](/api/attachments/ignored.txt)
            </attachment_preview>
        """.trimIndent()

        val images = MessageContentUtils.extractImageLinks(text)
        val artifacts = MessageContentUtils.extractArtifactLinks(text)

        assertEquals(listOf(MessageContentUtils.ContentLink(label = "chart", url = "/api/attachments/chart.png", kind = "Image")), images)
        assertEquals(listOf(MessageContentUtils.ContentLink(label = "summary.pdf", url = "/api/attachments/summary.pdf", kind = "PDF")), artifacts)
    }
}
