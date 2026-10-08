package io.github.sbgitcs.usagemonitor.pairing

import android.os.Build
import io.github.sbgitcs.usagemonitor.data.PairedComputer
import io.github.sbgitcs.usagemonitor.data.Settings
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class NotPairedException : IOException("The computer no longer accepts this phone. Pair it again.")

class DirectReadingOffException : IOException("The computer has not allowed this phone to read usage directly.")

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
        return computer
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
        return json
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

    /** The computer's current access tokens by tool; throws [DirectReadingOffException] until it allows it. */
    fun tokens(): JSONObject = JSONObject(signed("/v1/tokens", "GET")).optJSONObject("tokens") ?: JSONObject()

    private fun signed(path: String, method: String): String {
        val computer = settings.computer ?: throw NotPairedException()
        val (json, address) = request(computer.addresses, computer.port, computer.deviceId,
            PairingCrypto.decodeKey(computer.masterKey), path, method = method)
        settings.lastAddress = address
        return json
    }

    private fun request(addresses: List<String>, port: Int, id: String, master: ByteArray, path: String, method: String = "GET", sendName: Boolean = false): Pair<String, String> {
        // The address that worked last time goes first.
        val ordered = addresses.sortedByDescending { it == settings.lastAddress }
        var last: IOException = IOException("The computer could not be reached.")
        for (address in ordered) {
            val time = System.currentTimeMillis()
            val conn = URL("http://$address:$port$path").openConnection() as HttpURLConnection
            try {
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
                        val body = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                        return PairingCrypto.decrypt(master, time, body.getString("iv"), body.getString("data")) to address
                    }
                    401 -> throw NotPairedException()
                    403 -> throw DirectReadingOffException()
                    429 -> last = IOException("The computer is refusing requests for a minute.")
                    else -> last = IOException("The computer answered HTTP $status.")
                }
            } catch (e: NotPairedException) {
                throw e
            } catch (e: DirectReadingOffException) {
                throw e
            } catch (e: IOException) {
                last = IOException("Could not reach ${settings.computer?.name ?: "the computer"} at $address:$port. Is Usage Monitor running there, with phone sharing on?", e)
            } catch (e: Exception) {
                last = IOException("The computer's answer could not be read: ${e.message}", e)
            } finally {
                conn.disconnect()
            }
        }
        throw last
    }

    private fun phoneName(): String = listOf(Build.MANUFACTURER, Build.MODEL)
        .filter { !it.isNullOrBlank() }
        .joinToString(" ") { it.replaceFirstChar(Char::uppercase) }
        .ifBlank { "Phone" }
}
