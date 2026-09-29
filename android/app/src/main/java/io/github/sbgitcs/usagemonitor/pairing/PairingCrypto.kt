package io.github.sbgitcs.usagemonitor.pairing

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The phone side of the pairing crypto in the desktop's src/phone.js (docs/phone-protocol.md).
 * Everything is derived from the 20-character pairing code; the code never crosses the network.
 */
object PairingCrypto {
    private val url = Base64.getUrlEncoder().withoutPadding()
    private val urlDecoder = Base64.getUrlDecoder()

    fun normalizeCode(code: String): String = code.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }

    fun isValidCode(code: String): Boolean = normalizeCode(code).length == 20

    fun deviceId(code: String): String =
        sha256("um-id:${normalizeCode(code)}".toByteArray()).joinToString("") { "%02x".format(it) }.take(16)

    fun masterKey(code: String): ByteArray =
        hkdf(normalizeCode(code).toByteArray(), "usage-monitor".toByteArray(), "um-key-v1".toByteArray())

    fun subKey(master: ByteArray, label: String): ByteArray = hkdf(master, ByteArray(0), label.toByteArray())

    fun sign(master: ByteArray, method: String, path: String, time: Long): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(subKey(master, "um-mac-v1"), "HmacSHA256"))
        return url.encodeToString(mac.doFinal("$method\n$path\n$time".toByteArray()))
    }

    /** Opens a reply; fails if it was tampered with or answers a different request [time]. */
    fun decrypt(master: ByteArray, time: Long, iv: String, data: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(subKey(master, "um-enc-v1"), "AES"), GCMParameterSpec(128, urlDecoder.decode(iv)))
        cipher.updateAAD(time.toString().toByteArray())
        return String(cipher.doFinal(urlDecoder.decode(data)), Charsets.UTF_8)
    }

    fun encodeKey(key: ByteArray): String = url.encodeToString(key)

    fun decodeKey(key: String): ByteArray = urlDecoder.decode(key)

    private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // HMAC accepts an empty key; SecretKeySpec does not, and a zero-filled key is equivalent.
        mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(32) else key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /** RFC 5869 HKDF-SHA256 with a 32-byte output. */
    private fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray): ByteArray {
        val prk = hmac(salt, ikm)
        return hmac(prk, info + byteArrayOf(1))
    }
}
