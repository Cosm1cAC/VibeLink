package com.vibelink.app.mobile

data class IncomingSharedContent(
    val text: String = "",
    val streamUris: List<String> = emptyList(),
    val mimeType: String = "",
) {
    val composerText: String
        get() = text.trim()

    val hasAttachments: Boolean
        get() = streamUris.isNotEmpty()

    val isEmpty: Boolean
        get() = composerText.isBlank() && !hasAttachments
}
