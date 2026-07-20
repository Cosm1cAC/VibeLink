package com.vibelink.app.ui.screens

import kotlin.test.Test
import kotlin.test.assertEquals

class PairingRecoveryPolicyTest {
    @Test
    fun retriesClaimAfterTheServerCommittedButTheResponseWasLost() {
        assertEquals(true, PairingRecoveryPolicy.shouldClaim("approved"))
        assertEquals(true, PairingRecoveryPolicy.shouldClaim("claimed"))
        assertEquals(false, PairingRecoveryPolicy.shouldClaim("pending"))
        assertEquals(false, PairingRecoveryPolicy.shouldClaim("denied"))
        assertEquals(false, PairingRecoveryPolicy.shouldClaim("expired"))
    }
}
