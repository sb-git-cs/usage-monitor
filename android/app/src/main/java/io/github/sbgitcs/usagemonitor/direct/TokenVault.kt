package io.github.sbgitcs.usagemonitor.direct

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The sign-ins this phone holds: tokens linked from the computer and its own sign-ins. Encrypted
 * with a key that never leaves the Android Keystore, in a file that is not backed up.
 */
class TokenVault(context: Context) {
    private val file = AtomicFile(context.applicationContext.noBackupFilesDir.resolve("sign-ins"))

    fun all(): List<Credential> = synchronized(lock) { load() }

    fun get(provider: String, origin: String): Credential? = all().firstOrNull { it.provider == provider && it.origin == origin }

    fun put(c: Credential) = update { list -> list.filterNot { it.provider == c.provider && it.origin == c.origin } + c }

    fun remove(provider: String, origin: String) = update { list -> list.filterNot { it.provider == provider && it.origin == origin } }

    /** Replaces every token linked from the computer. */
    fun replaceLinked(linked: List<Credential>) = update { list -> list.filter { it.origin != LINKED } + linked }

    private fun update(change: (List<Credential>) -> List<Credential>) = synchronized(lock) {
        val next = change(load())
        val out = file.startWrite()
        try {
            out.write(seal(encode(next).toByteArray()))
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }

    private fun load(): List<Credential> {
        if (!file.baseFile.exists()) return emptyList()
        // An unreadable vault (for example after the Keystore key was reset) means signing in again.
        return runCatching { decode(String(open(file.readFully()))) }.getOrDefault(emptyList())
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build())
        return generator.generateKey()
    }

    private fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return cipher.iv + cipher.doFinal(plain)
    }

    private fun open(sealed: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12))
        return cipher.doFinal(sealed, 12, sealed.size - 12)
    }

    companion object {
        const val LINKED = "computer"
        const val PHONE = "phone"
        private const val ALIAS = "sign-ins"
        private val lock = Any()

        internal fun encode(list: List<Credential>): String = JSONArray(list.map { c ->
            JSONObject().put("provider", c.provider).put("origin", c.origin).put("access", c.accessToken)
                .putOpt("refresh", c.refreshToken).putOpt("expires", c.expiresAt).putOpt("account_id", c.accountId)
                .putOpt("user_id", c.userId).putOpt("plan", c.plan).putOpt("account", c.account)
                .put("extra", JSONObject(c.extra))
        }).toString()

        internal fun decode(json: String): List<Credential> {
            val a = JSONArray(json)
            return (0 until a.length()).mapNotNull { i ->
                val o = a.optJSONObject(i) ?: return@mapNotNull null
                val access = o.optString("access").ifEmpty { return@mapNotNull null }
                val extra = o.optJSONObject("extra")
                Credential(
                    provider = o.optString("provider"),
                    origin = o.optString("origin"),
                    accessToken = access,
                    refreshToken = o.text("refresh"),
                    expiresAt = if (o.has("expires")) o.optLong("expires") else null,
                    accountId = o.text("account_id"),
                    userId = o.text("user_id"),
                    plan = o.text("plan"),
                    account = o.text("account"),
                    extra = extra?.keys()?.asSequence()?.associateWith { extra.optString(it) }.orEmpty(),
                )
            }
        }

        private fun JSONObject.text(key: String): String? = if (isNull(key)) null else optString(key).ifEmpty { null }
    }
}
