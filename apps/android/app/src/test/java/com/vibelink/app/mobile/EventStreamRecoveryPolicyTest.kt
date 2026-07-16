package com.vibelink.app.mobile

import kotlin.test.Test
import kotlin.test.assertEquals

class EventStreamRecoveryPolicyTest {
    @Test
    fun boundsReconnectDelayAndNeverMovesCursorBackward() {
        assertEquals(1_000L, EventStreamRecoveryPolicy.retryDelayMs(attempt = 0))
        assertEquals(2_000L, EventStreamRecoveryPolicy.retryDelayMs(attempt = 1))
        assertEquals(15_000L, EventStreamRecoveryPolicy.retryDelayMs(attempt = 10))
        assertEquals(12, EventStreamRecoveryPolicy.nextCursor(current = 12, incoming = 7))
        assertEquals(18, EventStreamRecoveryPolicy.nextCursor(current = 12, incoming = 18))
    }
}
