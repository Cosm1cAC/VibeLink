package com.vibelink.app.network

import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertFalse

class ApiExceptionTest {
    @Test
    fun exposesHumanReadableServerErrorWithoutRawJson() {
        val error = ApiException(
            428,
            "{\"error\":\"Terminal session requires explicit approval\",\"approvalId\":\"ap-123\"}",
        )

        assertContains(error.message.orEmpty(), "Terminal session requires explicit approval")
        assertFalse(error.message.orEmpty().contains("{\"error\""))
    }
}
