package com.vibelink.app.ui.screens

object PairingRecoveryPolicy {
    fun shouldClaim(status: String): Boolean = status == "approved" || status == "claimed"
}
