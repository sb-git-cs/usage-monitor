package io.github.sbgitcs.usagemonitor.pairing

import java.net.URI
import java.net.URLDecoder

/** What the desktop's pairing QR code (or the typed address and code) tells the phone. */
data class PairingInfo(val name: String, val addresses: List<String>, val port: Int, val code: String)

object PairingLink {
    const val DEFAULT_PORT = 47329

    /** Parses usagemonitor://pair?h=...&p=...&c=...&n=...; null if it is not a pairing link. */
    fun parse(link: String): PairingInfo? {
        val uri = runCatching { URI(link.trim()) }.getOrNull() ?: return null
        if (uri.scheme != "usagemonitor" || uri.host != "pair") return null
        val query = uri.rawQuery ?: return null
        val params = query.split("&").mapNotNull { part ->
            val eq = part.indexOf('=')
            if (eq <= 0) null else decode(part.substring(0, eq)) to decode(part.substring(eq + 1))
        }.toMap()
        val addresses = params["h"].orEmpty().split(",").map { it.trim() }.filter { isAddress(it) }
        val port = params["p"]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: DEFAULT_PORT
        val code = params["c"].orEmpty()
        if (addresses.isEmpty() || !PairingCrypto.isValidCode(code)) return null
        return PairingInfo(params["n"].orEmpty().ifBlank { "Computer" }.take(60), addresses, port, PairingCrypto.normalizeCode(code))
    }

    /** For typed pairing: "192.168.1.20" or "192.168.1.20:47329" plus the code. */
    fun manual(address: String, code: String): PairingInfo? {
        val trimmed = address.trim()
        val host = trimmed.substringBefore(":")
        val port = if (':' in trimmed) trimmed.substringAfter(":").toIntOrNull() else DEFAULT_PORT
        if (!isAddress(host) || port == null || port !in 1..65535 || !PairingCrypto.isValidCode(code)) return null
        return PairingInfo("Computer", listOf(host), port, PairingCrypto.normalizeCode(code))
    }

    private fun decode(s: String): String = URLDecoder.decode(s, "UTF-8")

    /**
     * A private (10/8, 172.16/12, 192.168/16) or carrier-grade NAT (100.64/10, which VPNs such as
     * Tailscale use) IPv4 address: a link from a web page must not point the phone at a public host.
     */
    internal fun isAddress(s: String): Boolean {
        val parts = s.split(".")
        if (parts.size != 4 || !parts.all { p -> p.isNotEmpty() && p.length <= 3 && p.all { it in '0'..'9' } && p.toInt() in 0..255 }) return false
        val (a, b) = parts.map { it.toInt() }
        return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 100 && b in 64..127)
    }
}
