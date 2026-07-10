package com.vibelink.app.ui.screens

data class WorkspaceDiffHunk(
    val path: String,
    val header: String,
    val patch: String,
)

fun parseWorkspaceDiffHunks(diff: String): List<WorkspaceDiffHunk> {
    if (diff.isBlank()) return emptyList()
    val hunks = mutableListOf<WorkspaceDiffHunk>()
    var fileHeader = mutableListOf<String>()
    var currentHunk = mutableListOf<String>()
    var path = ""

    fun flushHunk() {
        if (path.isBlank() || currentHunk.isEmpty()) return
        hunks += WorkspaceDiffHunk(
            path = path,
            header = currentHunk.first(),
            patch = (fileHeader + currentHunk).joinToString("\n", postfix = "\n"),
        )
        currentHunk = mutableListOf()
    }

    diff.lineSequence().forEach { line ->
        when {
            line.startsWith("diff --git ") -> {
                flushHunk()
                fileHeader = mutableListOf(line)
                currentHunk = mutableListOf()
                path = pathFromDiffHeader(line)
            }
            line.startsWith("@@") -> {
                flushHunk()
                currentHunk = mutableListOf(line)
            }
            currentHunk.isNotEmpty() -> currentHunk += line
            fileHeader.isNotEmpty() -> {
                fileHeader += line
                if (line.startsWith("+++ ")) {
                    path = pathFromMarker(line.removePrefix("+++ ").trim()).ifBlank { path }
                }
            }
        }
    }
    flushHunk()
    return hunks
}

private fun pathFromDiffHeader(line: String): String {
    val marker = line.substringAfter(" b/", missingDelimiterValue = "")
    return marker.trim().trim('"')
}

private fun pathFromMarker(marker: String): String {
    if (marker == "/dev/null") return ""
    return marker.trim('"').removePrefix("b/")
}
