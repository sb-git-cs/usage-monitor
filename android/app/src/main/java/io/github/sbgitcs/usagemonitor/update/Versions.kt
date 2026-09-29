package io.github.sbgitcs.usagemonitor.update

import org.json.JSONObject

/** latest-android.json, attached to every release next to the APK. */
data class UpdateManifest(val version: String, val versionCode: Int, val file: String, val sha256: String, val size: Long) {
    companion object {
        fun parse(json: String): UpdateManifest? = runCatching {
            val o = JSONObject(json)
            UpdateManifest(
                version = o.getString("version"),
                versionCode = o.getInt("version_code"),
                file = o.getString("file"),
                sha256 = o.getString("sha256").lowercase(),
                size = o.getLong("size"),
            ).takeIf {
                it.file.matches(Regex("""UsageMonitor-[0-9A-Za-z.\-]+\.apk""")) && it.sha256.matches(Regex("[0-9a-f]{64}")) && it.size in 1..(300L * 1024 * 1024)
            }
        }.getOrNull()
    }
}

object Versions {
    /** Semantic-version order, the same as the desktop: 1.3.0-beta.2 < 1.3.0-beta.10 < 1.3.0. */
    fun compare(a: String, b: String): Int {
        fun parts(v: String): Pair<List<Int>, List<String>> {
            val trimmed = v.trim().removePrefix("v").removePrefix("V")
            val core = trimmed.substringBefore("-")
            val pre = if ('-' in trimmed) trimmed.substringAfter("-").split(".").filter { it.isNotEmpty() } else emptyList()
            return core.split(".").map { it.toIntOrNull() ?: 0 } to pre
        }
        val (x, xp) = parts(a)
        val (y, yp) = parts(b)
        for (i in 0 until maxOf(x.size, y.size, 3)) {
            val d = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 })
            if (d != 0) return d
        }
        if (xp.isEmpty() || yp.isEmpty()) return if (xp.isEmpty() == yp.isEmpty()) 0 else if (xp.isEmpty()) 1 else -1
        for (i in 0 until maxOf(xp.size, yp.size)) {
            val p = xp.getOrNull(i) ?: return -1
            val q = yp.getOrNull(i) ?: return 1
            val pn = p.toIntOrNull()
            val qn = q.toIntOrNull()
            val d = when {
                pn != null && qn != null -> pn.compareTo(qn)
                pn != null -> -1
                qn != null -> 1
                else -> p.compareTo(q)
            }
            if (d != 0) return d.coerceIn(-1, 1)
        }
        return 0
    }
}
