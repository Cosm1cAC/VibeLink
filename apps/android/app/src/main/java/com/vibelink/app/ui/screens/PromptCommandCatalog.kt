package com.vibelink.app.ui.screens

data class PromptCommand(
    val id: String,
    val label: String,
    val prompt: String,
)

object PromptCommandCatalog {
    val commands: List<PromptCommand> = listOf(
        PromptCommand(
            id = "review",
            label = "Review changes",
            prompt = "Review the current workspace changes for correctness, risks, and missing tests.",
        ),
        PromptCommand(
            id = "test",
            label = "Run tests",
            prompt = "Run the relevant tests, summarize failures, and propose the smallest safe fix.",
        ),
        PromptCommand(
            id = "workspace",
            label = "Summarize workspace",
            prompt = "Summarize the current workspace status, changed files, and next safe implementation step.",
        ),
        PromptCommand(
            id = "approvals",
            label = "Check approvals",
            prompt = "Check pending approvals and explain what each requested action would do before proceeding.",
        ),
    )

    fun applyCommand(currentPrompt: String, command: PromptCommand): String {
        val trimmed = currentPrompt.trim()
        return if (trimmed.isBlank()) command.prompt else "$trimmed\n\n${command.prompt}"
    }
}
