package com.vibelink.app.data

enum class AppLanguage(val code: String) {
    Chinese("zh"),
    English("en");

    companion object {
        val Default = Chinese

        fun fromCode(code: String?): AppLanguage {
            return values().firstOrNull { it.code == code } ?: Default
        }
    }
}
