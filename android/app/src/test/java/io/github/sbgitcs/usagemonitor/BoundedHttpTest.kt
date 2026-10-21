package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.net.BoundedHttp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL

class BoundedHttpTest {
    @Test fun answersAreCappedWhileTheyAreRead() {
        assertEquals(10, BoundedHttp.read(ByteArrayInputStream(ByteArray(10)), 10).size)
        assertThrows(IOException::class.java) { BoundedHttp.read(ByteArrayInputStream(ByteArray(11)), 10) }
    }

    @Test fun anAnswerTrickledByteByByteIsCutOffAtTheDeadline() {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { server ->
            Thread {
                runCatching {
                    server.accept().use { socket ->
                        val out = socket.getOutputStream()
                        out.write("HTTP/1.1 200 ".toByteArray())
                        // Each byte arrives well within the read timeout, so only the deadline ends it.
                        repeat(100) {
                            out.write('x'.code)
                            out.flush()
                            Thread.sleep(100)
                        }
                    }
                }
            }.apply { isDaemon = true }.start()
            val conn = URL("http://127.0.0.1:${server.localPort}/").openConnection() as HttpURLConnection
            // A POST of nothing, as the phone sends: the JDK client would retry a failed GET once.
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(0)
            conn.readTimeout = 5_000
            val started = System.nanoTime()
            val error = assertThrows(IOException::class.java) { BoundedHttp.withDeadline(conn, 500) { conn.responseCode } }
            assertEquals("The answer took too long.", error.message)
            assertTrue((System.nanoTime() - started) / 1_000_000 < 4_000)
        }
    }
}
