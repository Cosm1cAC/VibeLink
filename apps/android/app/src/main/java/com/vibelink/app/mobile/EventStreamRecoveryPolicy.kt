package com.vibelink.app.mobile

import kotlin.math.max

object EventStreamRecoveryPolicy {
    fun retryDelayMs(attempt: Int): Long {
        val exponent = attempt.coerceIn(0, 4)
        return (1_000L shl exponent).coerceAtMost(15_000L)
    }

    fun nextCursor(current: Int, incoming: Int): Int = max(current, incoming)
}
