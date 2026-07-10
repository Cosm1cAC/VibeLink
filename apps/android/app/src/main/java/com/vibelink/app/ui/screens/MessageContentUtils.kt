package com.vibelink.app.ui.screens

object MessageContentUtils {
    data class ContentLink(
        val label: String,
        val url: String,
        val kind: String,
    )

    private val fencedCodeRegex = Regex(
        pattern = "```[^\n`]*\n([\\s\\S]*?)```",
        option = RegexOption.MULTILINE,
    )
    private val attachmentPreviewRegex = Regex(
        pattern = "<attachment_preview\\b[^>]*>[\\s\\S]*?</attachment_preview>",
        options = setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE),
    )
    private val markdownImageRegex = Regex(
        pattern = "!\\[([^\\]]*)]\\(([^)]+)\\)",
        option = RegexOption.IGNORE_CASE,
    )
    private val markdownLinkRegex = Regex(
        pattern = "(?<!!)\\[([^\\]]+)]\\(([^)]+)\\)",
        option = RegexOption.IGNORE_CASE,
    )
    private val fileReferenceRegex = Regex(
        pattern = "(?<![\\w:/.-])((?:[A-Za-z]:)?(?:[\\w.@()+-]+[\\\\/])+[\\w .@()+-]+\\.(?:kt|java|js|jsx|ts|tsx|md|json|xml|rs|mjs|cjs|gradle|kts|toml|yml|yaml|css|html|sh|bat)(?::\\d+)?)",
        option = RegexOption.IGNORE_CASE,
    )

    fun extractCodeBlocks(markdown: String): List<String> {
        if (markdown.isBlank()) return emptyList()
        return fencedCodeRegex.findAll(markdown)
            .map { match -> match.groupValues.getOrNull(1).orEmpty().trim('\n', '\r') }
            .filter { it.isNotBlank() }
            .toList()
    }

    fun extractFileReferences(text: String): List<String> {
        if (text.isBlank()) return emptyList()
        return fileReferenceRegex.findAll(text)
            .map { it.groupValues[1].trimEnd('.', ',', ';', ')', ']') }
            .filterNot { it.startsWith("http://", ignoreCase = true) || it.startsWith("https://", ignoreCase = true) }
            .distinct()
            .toList()
    }

    fun attachmentPromptText(name: String, markdown: String, preview: String = ""): String {
        val safeName = name.replace("\"", "'").ifBlank { "attachment" }
        val base = markdown.trim().ifBlank { safeName }
        val cleanPreview = preview.trim().take(12000)
        if (cleanPreview.isBlank()) return base
        return "$base\n\n<attachment_preview name=\"$safeName\">\n$cleanPreview\n</attachment_preview>"
    }

    fun extractImageLinks(markdown: String): List<ContentLink> {
        val cleaned = removeAttachmentPreviews(markdown)
        return markdownImageRegex.findAll(cleaned)
            .map { match ->
                ContentLink(
                    label = match.groupValues[1].trim().ifBlank { fileNameFromUrl(match.groupValues[2]) },
                    url = match.groupValues[2].trim(),
                    kind = "Image",
                )
            }
            .distinctBy { it.url }
            .toList()
    }

    fun extractArtifactLinks(markdown: String): List<ContentLink> {
        val cleaned = removeAttachmentPreviews(markdown)
        val imageUrls = extractImageLinks(markdown).map { it.url }.toSet()
        return markdownLinkRegex.findAll(cleaned)
            .map { match ->
                val label = match.groupValues[1].trim()
                val url = match.groupValues[2].trim()
                ContentLink(label = label.ifBlank { fileNameFromUrl(url) }, url = url, kind = artifactKind(url))
            }
            .filter { it.url !in imageUrls && isArtifactUrl(it.url) }
            .distinctBy { it.url }
            .toList()
    }

    private fun removeAttachmentPreviews(text: String): String {
        return attachmentPreviewRegex.replace(text, "")
    }

    private fun isArtifactUrl(url: String): Boolean {
        val lower = url.lowercase()
        return lower.startsWith("/api/attachments/") ||
            lower.contains("/api/attachments/") ||
            lower.endsWith(".pdf") ||
            lower.endsWith(".txt") ||
            lower.endsWith(".md") ||
            lower.endsWith(".json") ||
            lower.endsWith(".csv") ||
            lower.endsWith(".html") ||
            lower.endsWith(".png") ||
            lower.endsWith(".jpg") ||
            lower.endsWith(".jpeg") ||
            lower.endsWith(".gif") ||
            lower.endsWith(".webp")
    }

    private fun artifactKind(url: String): String {
        val lower = url.substringBefore('?').lowercase()
        return when {
            lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp") -> "Image"
            lower.endsWith(".pdf") -> "PDF"
            lower.endsWith(".html") || lower.endsWith(".htm") -> "HTML"
            lower.endsWith(".json") -> "JSON"
            lower.endsWith(".csv") -> "CSV"
            else -> "Text"
        }
    }

    private fun fileNameFromUrl(url: String): String {
        return url.substringBefore('?').trimEnd('/').substringAfterLast('/').ifBlank { "artifact" }
    }
}
