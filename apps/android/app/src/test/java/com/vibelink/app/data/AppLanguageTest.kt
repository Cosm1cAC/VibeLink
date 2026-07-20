package com.vibelink.app.data

import com.vibelink.app.ui.i18n.appStringsFor
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AppLanguageTest {
    @Test
    fun defaultsToChineseWhenCodeIsMissingOrUnknown() {
        assertEquals(AppLanguage.Chinese, AppLanguage.fromCode(null))
        assertEquals(AppLanguage.Chinese, AppLanguage.fromCode(""))
        assertEquals(AppLanguage.Chinese, AppLanguage.fromCode("system"))
    }

    @Test
    fun selectsChineseAndEnglishStrings() {
        assertEquals("设置", appStringsFor(AppLanguage.Chinese).settings)
        assertEquals("Settings", appStringsFor(AppLanguage.English).settings)
    }

    @Test
    fun localizesEventAcknowledgementSummaryWithOptionalSafeCursor() {
        assertEquals(
            "2 台设备已确认，可安全压缩至 42",
            appStringsFor(AppLanguage.Chinese).eventAcknowledgementSummary(2, 42),
        )
        assertEquals(
            "1 device ack",
            appStringsFor(AppLanguage.English).eventAcknowledgementSummary(1, 0),
        )
        assertEquals(
            "2 device acks; safe through 42",
            appStringsFor(AppLanguage.English).eventAcknowledgementSummary(2, 42),
        )
    }

    @Test
    fun runtimeSourceDoesNotHardcodeChineseOutsideLocalizationProvider() {
        val sourceRoot = Path.of("src/main/java/com/vibelink/app")
        val allowedFiles = setOf(sourceRoot.resolve("ui/i18n/AppStrings.kt"))
        val offenders = Files.walk(sourceRoot).use { paths ->
            paths
                .filter { Files.isRegularFile(it) && it.toString().endsWith(".kt") }
                .filter { it !in allowedFiles }
                .flatMap { path: Path ->
                    kotlinStringLiterals(path)
                        .filter { it.value.any(::isHanCharacter) }
                        .filterNot {
                            it.lineText.contains("strings.text(") ||
                                it.lineText.contains("ws(") ||
                                it.lineText.contains("Regex(")
                        }
                        .map { "${sourceRoot.relativize(path)}:${it.line}: ${it.value}" }
                        .stream()
                }
                .toList()
        }

        assertTrue(
            offenders.isEmpty(),
            "Move runtime-facing Chinese strings into AppStrings.kt:\n" + offenders.joinToString("\n"),
        )
    }

    private data class SourceStringLiteral(val line: Int, val lineText: String, val value: String)

    private fun kotlinStringLiterals(path: Path): List<SourceStringLiteral> {
        val source = String(Files.readAllBytes(path), StandardCharsets.UTF_8)
        val literals = mutableListOf<SourceStringLiteral>()
        var index = 0
        var line = 1
        while (index < source.length) {
            when {
                source[index] == '\n' -> {
                    line += 1
                    index += 1
                }
                source.startsWith("//", index) -> {
                    index = source.indexOf('\n', startIndex = index).takeIf { it >= 0 } ?: source.length
                }
                source.startsWith("/*", index) -> {
                    val end = source.indexOf("*/", startIndex = index + 2).takeIf { it >= 0 } ?: source.length
                    line += source.substring(index, end).count { it == '\n' }
                    index = (end + 2).coerceAtMost(source.length)
                }
                source.startsWith("\"\"\"", index) -> {
                    val startLine = line
                    val end = source.indexOf("\"\"\"", startIndex = index + 3).takeIf { it >= 0 } ?: source.length
                    val value = source.substring(index + 3, end)
                    literals += SourceStringLiteral(startLine, source.lineAt(startLine), value)
                    line += value.count { it == '\n' }
                    index = (end + 3).coerceAtMost(source.length)
                }
                source[index] == '"' -> {
                    val startLine = line
                    val value = StringBuilder()
                    index += 1
                    var escaped = false
                    while (index < source.length) {
                        val char = source[index]
                        if (char == '\n') line += 1
                        when {
                            escaped -> {
                                value.append(char)
                                escaped = false
                            }
                            char == '\\' -> {
                                value.append(char)
                                escaped = true
                            }
                            char == '"' -> break
                            else -> value.append(char)
                        }
                        index += 1
                    }
                    literals += SourceStringLiteral(startLine, source.lineAt(startLine), value.toString())
                    index = (index + 1).coerceAtMost(source.length)
                }
                else -> index += 1
            }
        }
        return literals
    }

    private fun String.lineAt(lineNumber: Int): String = lineSequence().drop(lineNumber - 1).firstOrNull().orEmpty()

    private fun isHanCharacter(char: Char): Boolean = char in '一'..'鿿'
}
