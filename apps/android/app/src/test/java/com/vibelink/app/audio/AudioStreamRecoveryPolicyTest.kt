package com.vibelink.app.audio

import kotlin.test.Test
import kotlin.test.assertEquals

class AudioStreamRecoveryPolicyTest {
    @Test
    fun retryDelayUsesBoundedExponentialBackoff() {
        assertEquals(500L, AudioStreamRecoveryPolicy.retryDelayMs(0))
        assertEquals(1_000L, AudioStreamRecoveryPolicy.retryDelayMs(1))
        assertEquals(8_000L, AudioStreamRecoveryPolicy.retryDelayMs(4))
        assertEquals(30_000L, AudioStreamRecoveryPolicy.retryDelayMs(10))
    }
}
