package com.vibelink.app.audio

internal object AudioStreamRecoveryPolicy {
    private const val INITIAL_DELAY_MS = 500L
    private const val MAX_DELAY_MS = 30_000L

    fun retryDelayMs(attempt: Int): Long {
        val boundedAttempt = attempt.coerceAtLeast(0).coerceAtMost(6)
        return (INITIAL_DELAY_MS shl boundedAttempt).coerceAtMost(MAX_DELAY_MS)
    }
}
