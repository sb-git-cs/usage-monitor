package io.github.sbgitcs.usagemonitor.net

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Limits for answers from other machines: a size cap, and a deadline for the whole request. */
object BoundedHttp {
    private val timer = Executors.newSingleThreadScheduledExecutor { Thread(it, "http-deadline").apply { isDaemon = true } }

    /** Reads the rest of [input]; more than [limit] bytes is an error rather than an out-of-memory crash. */
    fun read(input: InputStream, limit: Long): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) return out.toByteArray()
            if (out.size() + n > limit) throw IOException("The answer was larger than expected.")
            out.write(buf, 0, n)
        }
    }

    /**
     * Runs [block] on [conn] and disconnects it once [ms] have passed. Read timeouts apply to each
     * read, so an answer trickled a byte at a time could otherwise hold a request open for good.
     */
    fun <T> withDeadline(conn: HttpURLConnection, ms: Long, block: () -> T): T {
        val expired = AtomicBoolean(false)
        val alarm = timer.schedule({
            expired.set(true)
            conn.disconnect()
        }, ms, TimeUnit.MILLISECONDS)
        try {
            return block()
        } catch (e: Exception) {
            // Whatever the cut connection threw, the cause is the deadline.
            if (expired.get()) throw IOException("The answer took too long.", e)
            throw e
        } finally {
            alarm.cancel(false)
        }
    }
}
