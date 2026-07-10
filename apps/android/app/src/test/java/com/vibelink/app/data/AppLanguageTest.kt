package com.vibelink.app.data

import com.vibelink.app.ui.i18n.appStringsFor
import kotlin.test.Test
import kotlin.test.assertEquals

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
}
