package com.vibelink.app.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class StoredSecretCodecTest {
    private val cipher = object : SecretCipher {
        override fun encrypt(plaintext: String): String = plaintext.reversed()
        override fun decrypt(ciphertext: String): String = ciphertext.reversed()
    }

    @Test
    fun encryptsNewSecretsAndMarksLegacyPlaintextForMigration() {
        val encoded = StoredSecretCodec.encode("device-token", cipher)

        assertTrue(encoded.startsWith("v1:"))
        assertFalse(encoded.contains("device-token"))
        assertEquals(SecretRead("device-token", needsMigration = false), StoredSecretCodec.decode(encoded, cipher))
        assertEquals(SecretRead("legacy-token", needsMigration = true), StoredSecretCodec.decode("legacy-token", cipher))
    }
}
