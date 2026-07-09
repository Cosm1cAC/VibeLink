package com.vibelink.app.ui.screens

object MessageContentUtils {
    private val fencedCodeRegex = Regex(
        pattern = "```[^\n`]*\n([\\s\\S]*?)```",
        option = RegexOption.MULTILINE,
    )

    fun extractCodeBlocks(markdown: String): List<String> {
        if (markdown.isBlank()) return emptyList()
        return fencedCodeRegex.findAll(markdown)
            .map { match -> match.groupValues.getOrNull(1).orEmpty().trim('\n', '\r') }
            .filter { it.isNotBlank() }
            .toList()
    }
}
