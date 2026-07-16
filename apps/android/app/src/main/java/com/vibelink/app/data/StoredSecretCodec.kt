package com.vibelink.app.data

interface SecretCipher {
    fun encrypt(plaintext: String): String
    fun decrypt(ciphertext: String): String
}

data class SecretRead(
    val value: String,
    val needsMigration: Boolean,
)

object StoredSecretCodec {
    private const val VERSION_PREFIX = "v1:"

    fun encode(value: String, cipher: SecretCipher): String {
        if (value.isBlank()) return ""
        return VERSION_PREFIX + cipher.encrypt(value)
    }

    fun decode(stored: String, cipher: SecretCipher): SecretRead {
        if (stored.isBlank()) return SecretRead("", needsMigration = false)
        if (!stored.startsWith(VERSION_PREFIX)) return SecretRead(stored, needsMigration = true)
        return SecretRead(cipher.decrypt(stored.removePrefix(VERSION_PREFIX)), needsMigration = false)
    }
}
