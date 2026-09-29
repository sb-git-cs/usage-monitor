package io.github.sbgitcs.usagemonitor.net

import java.util.Locale
import kotlin.math.roundToInt

/** Same units as the desktop (binary, "1.50 MB"). */
object Format {
    private val units = listOf("B", "KB", "MB", "GB", "TB", "PB")

    fun bytes(value: Double): String {
        if (!(value > 0)) return "0 B"
        var v = value
        var i = 0
        while (v >= 1024 && i < units.size - 1) {
            v /= 1024
            i++
        }
        if (i == 0) return "${v.roundToInt()} B"
        val digits = if (v < 10) 2 else if (v < 100) 1 else 0
        return "%.${digits}f %s".format(Locale.US, v, units[i])
    }

    fun bytes(value: Long): String = bytes(value.toDouble())

    fun rate(value: Double): String = "${bytes(value)}/s"

    /** At most three digits ("8.8 KB/s", "120 MB/s"), for the status bar and widgets. */
    fun rateShort(value: Double): String {
        if (!(value >= 0.5)) return "0 B/s"
        var v = value
        var i = 0
        while (v >= 999.5 && i < units.size - 1) {
            v /= 1024
            i++
        }
        val text = if (i == 0 || v >= 9.95) v.roundToInt().toString() else "%.1f".format(Locale.US, v)
        return "$text ${units[i]}/s"
    }

    /** Two or three characters for the status bar icon: "0", "850K", "1.2M". */
    fun rateIcon(value: Double): Pair<String, String> {
        if (value < 1024) return value.roundToInt().toString() to "B/s"
        if (value < 1024 * 1024) return (value / 1024).let { if (it < 10) "%.1f".format(Locale.US, it) else it.roundToInt().toString() } to "KB/s"
        return (value / (1024 * 1024)).let { if (it < 10) "%.1f".format(Locale.US, it) else it.roundToInt().toString() } to "MB/s"
    }

    fun percent(value: Double?): String = value?.let { "${it.coerceIn(0.0, 999.0).roundToInt()}%" } ?: "—"

    /** "just now", "5 min ago", "3 h ago", "2 days ago". */
    fun ago(then: Long, now: Long): String {
        val min = (now - then).coerceAtLeast(0) / 60_000
        return when {
            min < 1 -> "just now"
            min < 60 -> "$min min ago"
            min < 48 * 60 -> "${min / 60} h ago"
            else -> "${min / (24 * 60)} days ago"
        }
    }

    /** "in 45 min", "in 2 h 10 min", "in 3 days"; like the desktop's reset countdown. */
    fun until(then: Long, now: Long): String {
        val min = ((then - now).coerceAtLeast(0) + 59_999) / 60_000
        return when {
            min < 60 -> "in $min min"
            min < 24 * 60 -> if (min % 60 == 0L) "in ${min / 60} h" else "in ${min / 60} h ${min % 60} min"
            else -> ((min + 12 * 60) / (24 * 60)).let { if (it == 1L) "in 1 day" else "in $it days" }
        }
    }

    /** "1.5 GB" from a byte count, trimmed for the settings fields: whole numbers lose the ".0". */
    fun gigabytes(bytes: Long): String {
        val gb = bytes / (1024.0 * 1024 * 1024)
        return if (gb == Math.floor(gb)) gb.toLong().toString() else "%.2f".format(Locale.US, gb).trimEnd('0').trimEnd('.')
    }

    /** Provider states from the desktop, in words; null for ones that need no explanation. */
    fun state(state: String): String? = when (state) {
        "ok" -> null
        "stale" -> "Last reading is old"
        "logged_out" -> "Signed out on the computer"
        "not_installed" -> "Not installed on the computer"
        "setup_required" -> "Needs setup on the computer"
        "disabled" -> "Turned off"
        "fetch_failed", "error" -> "Could not be read"
        else -> "Waiting for a reading"
    }
}
