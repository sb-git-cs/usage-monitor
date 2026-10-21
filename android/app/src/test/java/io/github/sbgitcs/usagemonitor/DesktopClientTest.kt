package io.github.sbgitcs.usagemonitor

import android.app.Application
import io.github.sbgitcs.usagemonitor.data.PairedComputer
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.pairing.ClockException
import io.github.sbgitcs.usagemonitor.pairing.DesktopClient
import io.github.sbgitcs.usagemonitor.pairing.PairingCrypto
import io.github.sbgitcs.usagemonitor.pairing.PairingInfo
import io.github.sbgitcs.usagemonitor.pairing.StatusException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** The phone against a stand-in for the computer's src/phone.js, over HTTP on this machine. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class DesktopClientTest {
    private val code = "ABCDE-FGHJK-MNPQR-STVWX"
    private val b64 = Base64.getUrlEncoder().withoutPadding()
    private val computers = mutableListOf<Computer>()

    /** Like src/phone.js: an offered key works alongside the current one and replaces it at its first use. */
    private inner class Computer(val rekeys: Boolean, val clockOff: Boolean) {
        var key: ByteArray = PairingCrypto.masterKey(code)
        var next: ByteArray? = null
        val requests = mutableListOf<String>()
        val server = ServerSocket(0, 10, InetAddress.getLoopbackAddress())

        init {
            Thread {
                while (true) {
                    val socket = runCatching { server.accept() }.getOrNull() ?: break
                    socket.use { runCatching { serve(it) } }
                }
            }.apply { isDaemon = true }.start()
        }

        /** One request per connection, which the phone's requests (no body) allow. */
        private fun serve(socket: Socket) {
            val input = socket.getInputStream().bufferedReader(Charsets.ISO_8859_1)
            val (method, target) = input.readLine().split(" ")
            val headers = generateSequence { input.readLine() }.takeWhile { it.isNotEmpty() }
                .associate { it.substringBefore(":").trim().lowercase() to it.substringAfter(":").trim() }
            val path = target.substringBefore("?")
            val time = headers.getValue("x-um-time").toLong()
            val sig = headers.getValue("x-um-sig")
            val used = listOfNotNull(key, next).firstOrNull { PairingCrypto.sign(it, method, path, time) == sig }
            synchronized(requests) { requests += "$method $path ${if (used != null && used === next) "next" else "current"}" }
            val (status, body) = when {
                used == null -> 401 to """{"error":"not paired"}"""
                clockOff -> 400 to """{"error":"clock"}"""
                path == "/v1/rekey" && !rekeys -> 404 to """{"error":"not found"}"""
                else -> {
                    if (used === next) {
                        key = used
                        next = null
                    }
                    val plain = when (path) {
                        "/v1/ping" -> JSONObject().put("ok", true).put("name", "Studio PC")
                        "/v1/rekey" -> JSONObject().put("ok", true).put("key", b64.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it); next = it }))
                        else -> JSONObject().put("v", 1).put("providers", JSONArray())
                    }
                    200 to seal(used, time, plain.toString())
                }
            }
            val bytes = body.toByteArray()
            socket.getOutputStream().apply {
                write("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                write(bytes)
                flush()
            }
        }

        fun info() = PairingInfo("Studio PC", listOf("127.0.0.1"), server.localPort, code)
        fun rekeyRequests() = synchronized(requests) { requests.count { it.contains("/v1/rekey") } }
    }

    private fun computer(rekeys: Boolean = true, clockOff: Boolean = false) = Computer(rekeys, clockOff).also { computers += it }

    private fun seal(master: ByteArray, time: Long, plain: String): String {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(PairingCrypto.subKey(master, "um-enc-v1"), "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD(time.toString().toByteArray())
        return JSONObject().put("v", 1).put("iv", b64.encodeToString(iv)).put("data", b64.encodeToString(cipher.doFinal(plain.toByteArray()))).toString()
    }

    @After fun stop() = computers.forEach { it.server.close() }

    @Test fun pairingSwapsTheCodeKeyForARandomOneFromTheComputer() {
        val pc = computer()
        val app = RuntimeEnvironment.getApplication()
        val client = DesktopClient(Settings(app))
        val paired = client.pair(pc.info())
        val issued = pc.next!!
        assertTrue(paired.rekeyed)
        assertEquals(paired, Settings(app).computer)
        assertArrayEquals(issued, PairingCrypto.decodeKey(paired.masterKey))
        client.refresh()
        assertArrayEquals("the computer switches at the first request with the new key", issued, pc.key)
        assertNull(pc.next)
        assertEquals(listOf("GET /v1/ping current", "POST /v1/rekey current", "GET /v1/snapshot next"), pc.requests)
        client.refresh()
        assertEquals(1, pc.rekeyRequests())
    }

    @Test fun anExistingPairingRekeysAtItsNextRefresh() {
        val pc = computer()
        val settings = Settings(RuntimeEnvironment.getApplication())
        settings.computer = PairedComputer("Studio PC", listOf("127.0.0.1"), pc.server.localPort, PairingCrypto.deviceId(code),
            PairingCrypto.encodeKey(PairingCrypto.masterKey(code)))
        DesktopClient(settings).refresh()
        assertNotNull(settings.snapshotJson)
        assertTrue(settings.computer!!.rekeyed)
        assertArrayEquals(pc.next, PairingCrypto.decodeKey(settings.computer!!.masterKey))
    }

    @Test fun anOlderComputerKeepsTheCodeKeyAndIsAskedAgainADayLater() {
        val pc = computer(rekeys = false)
        val settings = Settings(RuntimeEnvironment.getApplication())
        val client = DesktopClient(settings)
        val paired = client.pair(pc.info())
        assertFalse(paired.rekeyed)
        assertArrayEquals(PairingCrypto.masterKey(code), PairingCrypto.decodeKey(paired.masterKey))
        client.refresh()
        assertEquals("not again within a day", 1, pc.rekeyRequests())
        settings.rekeyCheckedAt = System.currentTimeMillis() - 25 * 3_600_000L
        client.refresh()
        assertEquals(2, pc.rekeyRequests())
        assertNotNull("the refresh itself works", settings.snapshotJson)
    }

    @Test fun aWrongClockIsNotReportedAsAnUnpairedPhone() {
        val pc = computer(clockOff = true)
        val error = assertThrows(ClockException::class.java) { DesktopClient(Settings(RuntimeEnvironment.getApplication())).pair(pc.info()) }
        assertEquals("This phone's clock differs from the computer's by more than 5 minutes. Check the date and time on both.", error.message)
        assertTrue(DesktopClient.failure(400, """{"error":"clock"}""") is ClockException)
        assertEquals(400, (DesktopClient.failure(400, """{"error":"invalid request"}""") as StatusException).status)
        assertEquals(404, (DesktopClient.failure(404, "not json") as StatusException).status)
    }
}
