package com.vibelink.app.audio

object AudioStreamRecoveryPolicy {
    fun retryDelayMs(attempt: Int): Long {
        val normalized = attempt.coerceIn(0, 6)
        return (1_000L shl normalized).coerceAtMost(30_000L)
    }
}
