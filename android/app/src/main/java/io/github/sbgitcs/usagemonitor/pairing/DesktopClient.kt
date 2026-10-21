package io.github.sbgitcs.usagemonitor.pairing

import android.os.Build
import io.github.sbgitcs.usagemonitor.data.PairedComputer
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.net.BoundedHttp
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class NotPairedException : IOException("The computer no longer accepts this phone. Pair it again.")

class DirectReadingOffException : IOException("The computer has not allowed this phone to read usage directly.")

/** The computer accepted the signature but not its time; pairing again would not help. */
class ClockException : IOException("This phone's clock differs from the computer's by more than 5 minutes. Check the date and time on both.")

/** Any other answer, such as 404 from a computer too old for the request. */
class StatusException(val status: Int, message: String = "The computer answered HTTP $status.") : IOException(message)

/** Reads the paired computer's meters over the local network. Blocking; call it off the main thread. */
class DesktopClient(private val settings: Settings) {

    /** Completes a pairing: the first signed request makes the computer remember this phone. */
    fun pair(info: PairingInfo): PairedComputer {
        val master = PairingCrypto.masterKey(info.code)
        val id = PairingCrypto.deviceId(info.code)
        val (reply, address) = request(info.addresses, info.port, id, master, "/v1/ping", sendName = true)
        val name = JSONObject(reply).optString("name").ifBlank { info.name }
        val computer = PairedComputer(name, info.addresses, info.port, id, PairingCrypto.encodeKey(master))
        settings.computer = computer
        settings.lastAddress = address
        settings.rekeyCheckedAt = 0
        // The key so far derives from the code that was on the computer's screen.
        rekeyIfDue()
        return settings.computer ?: computer
    }

    /** Fetches /v1/snapshot and caches it for the widgets. Returns the JSON. */
    fun refresh(): String {
        val computer = settings.computer ?: throw NotPairedException()
        val master = PairingCrypto.decodeKey(computer.masterKey)
        val (json, address) = try {
            request(computer.addresses, computer.port, computer.deviceId, master, "/v1/snapshot", sendName = false)
        } catch (e: IOException) {
            settings.lastError = e.message
            throw e
        }
        settings.lastAddress = address
        settings.snapshotJson = json
        settings.snapshotAt = System.currentTimeMillis()
        settings.lastError = null
        rekeyIfDue()
        return json
    }

    /**
     * Swaps the key derived from the pairing code for a random one from the computer. Returns false
     * when the computer is too old to offer one; the current key then keeps working. One swap at a
     * time, so two answers cannot leave the phone and the computer with different keys.
     */
    fun rekey(): Boolean {
        synchronized(REKEYING) {
            val computer = settings.computer ?: throw NotPairedException()
            if (computer.rekeyed) return true
            // The address that just answered: a 404 from it means an older Usage Monitor, not another device.
            val addresses = computer.addresses.filter { it == settings.lastAddress }.ifEmpty { computer.addresses }
            val (json, _) = try {
                request(addresses, computer.port, computer.deviceId, PairingCrypto.decodeKey(computer.masterKey), "/v1/rekey", method = "POST")
            } catch (e: StatusException) {
                if (e.status == 404) return false
                throw e
            }
            val key = runCatching { PairingCrypto.decodeKey(JSONObject(json).getString("key")) }.getOrNull()?.takeIf { it.size == 32 }
                ?: throw IOException("The computer's new key could not be read.")
            // Unless the phone was unpaired or paired again meanwhile.
            if (settings.computer == computer) settings.computer = computer.copy(masterKey = PairingCrypto.encodeKey(key), rekeyed = true)
            return true
        }
    }

    /** At most one try per call; a computer too old to rekey is asked again a day later. Never throws. */
    private fun rekeyIfDue() {
        val computer = settings.computer ?: return
        val now = System.currentTimeMillis()
        if (computer.rekeyed || now - settings.rekeyCheckedAt in 0 until REKEY_RETRY_MS) return
        runCatching { if (!rekey()) settings.rekeyCheckedAt = now }
    }

    /** Asks the computer to use a saved sign-in, or to open that tool's sign-in. The computer confirms it. */
    fun switchAccount(provider: String, accountId: String?) {
        if (provider !in setOf("claude", "codex", "gemini", "grok", "cursor")) throw IOException("Unknown tool.")
        if (!accountId.isNullOrEmpty() && !accountId.matches(Regex("^[A-Za-z0-9_.:@-]{1,200}$"))) throw IOException("Unknown account.")
        val computer = settings.computer ?: throw NotPairedException()
        val path = if (accountId.isNullOrEmpty()) "/v1/account/$provider" else "/v1/account/$provider/$accountId"
        val master = PairingCrypto.decodeKey(computer.masterKey)
        val (json, address) = try {
            request(computer.addresses, computer.port, computer.deviceId, master, path, method = "POST")
        } catch (e: IOException) {
            settings.lastError = e.message
            throw e
        }
        settings.lastAddress = address
        if (!JSONObject(json).optBoolean("ok")) throw IOException("The computer did not accept the switch.")
    }

    /** Asks the computer to let this phone read usage directly; it confirms there. Returns whether it already has. */
    fun link(): Boolean = JSONObject(signed("/v1/link", "POST")).optBoolean("direct")

    /** Tells the computer to stop sending this phone its sign-in tokens. */
    fun unlink() {
        signed("/v1/unlink", "POST")
    }

    /**
     * Before this phone forgets [computer]: asks it to stop sending tokens, so a pairing the phone no
     * longer keeps does not stay linked there. Runs in the background; unreachable is fine.
     */
    fun unlinkInBackground(computer: PairedComputer?) {
        computer ?: return
        Thread {
            runCatching {
                request(computer.addresses, computer.port, computer.deviceId, PairingCrypto.decodeKey(computer.masterKey),
                    "/v1/unlink", method = "POST", deadlineMs = 5_000)
            }
        }.start()
    }

    /** The computer's current access tokens by tool; throws [DirectReadingOffException] until it allows it. */
    fun tokens(): JSONObject = JSONObject(signed("/v1/tokens", "GET")).optJSONObject("tokens") ?: JSONObject()

    private fun signed(path: String, method: String): String {
        val computer = settings.computer ?: throw NotPairedException()
        val (json, address) = request(computer.addresses, computer.port, computer.deviceId,
            PairingCrypto.decodeKey(computer.masterKey), path, method = method)
        settings.lastAddress = address
        return json
    }

    private fun request(addresses: List<String>, port: Int, id: String, master: ByteArray, path: String, method: String = "GET",
                        sendName: Boolean = false, deadlineMs: Long = DEADLINE_MS): Pair<String, String> {
        // The address that worked last time goes first.
        val ordered = addresses.sortedByDescending { it == settings.lastAddress }
        var last: IOException = IOException("The computer could not be reached.")
        for (address in ordered) {
            try {
                return attempt(address, port, id, master, path, method, sendName, deadlineMs) to address
            } catch (e: NotPairedException) {
                throw e
            } catch (e: DirectReadingOffException) {
                throw e
            } catch (e: ClockException) {
                throw e
            } catch (e: StatusException) {
                last = e
            } catch (e: IOException) {
                last = IOException("Could not reach ${settings.computer?.name ?: "the computer"} at $address:$port. Is Usage Monitor running there, with phone sharing on?", e)
            } catch (e: Exception) {
                last = IOException("The computer's answer could not be read: ${e.message}", e)
            }
        }
        throw last
    }

    /** One signed request to one address; anything but an answer to it is thrown. */
    private fun attempt(address: String, port: Int, id: String, master: ByteArray, path: String, method: String,
                        sendName: Boolean, deadlineMs: Long): String {
        val time = System.currentTimeMillis()
        val conn = URL("http://$address:$port$path").openConnection() as HttpURLConnection
        try {
            return BoundedHttp.withDeadline(conn, deadlineMs) {
                conn.connectTimeout = 2500
                conn.readTimeout = 6000
                conn.requestMethod = method
                if (method == "POST") {
                    conn.doOutput = true
                    conn.setFixedLengthStreamingMode(0)
                }
                conn.setRequestProperty("X-UM-Id", id)
                conn.setRequestProperty("X-UM-Time", time.toString())
                conn.setRequestProperty("X-UM-Sig", PairingCrypto.sign(master, method, path, time))
                if (sendName) conn.setRequestProperty("X-UM-Name", URLEncoder.encode(phoneName(), "UTF-8"))
                when (val status = conn.responseCode) {
                    200 -> {
                        val body = JSONObject(String(conn.inputStream.use { BoundedHttp.read(it, MAX_REPLY) }, Charsets.UTF_8))
                        PairingCrypto.decrypt(master, time, body.getString("iv"), body.getString("data"))
                    }
                    401 -> throw NotPairedException()
                    403 -> throw DirectReadingOffException()
                    429 -> throw StatusException(status, "The computer is refusing requests for a minute.")
                    else -> throw failure(status, runCatching { conn.errorStream?.use { String(BoundedHttp.read(it, 64 * 1024), Charsets.UTF_8) } }.getOrNull())
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun phoneName(): String = listOf(Build.MANUFACTURER, Build.MODEL)
        .filter { !it.isNullOrBlank() }
        .joinToString(" ") { it.replaceFirstChar(Char::uppercase) }
        .ifBlank { "Phone" }

    companion object {
        private const val MAX_REPLY = 2L * 1024 * 1024
        private const val DEADLINE_MS = 15_000L
        private const val REKEY_RETRY_MS = 24 * 3_600_000L
        private val REKEYING = Any()

        /** What an answer other than 200, 401, 403 or 429 means; [body] is its unencrypted text. */
        internal fun failure(status: Int, body: String?): IOException =
            if (status == 400 && runCatching { JSONObject(body.orEmpty()).optString("error") }.getOrNull() == "clock") ClockException()
            else StatusException(status)
    }
}
