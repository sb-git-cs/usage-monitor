package io.github.sbgitcs.usagemonitor.data

import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Quota observations only; credentials and account names are never stored here. */
object InsightHistory {
    const val DAY = 86_400_000L
    fun accountRef(value: String?): String = value?.takeIf { it.isNotBlank() }?.let {
        MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).take(8).joinToString("") { b -> "%02x".format(b) }
    } ?: "unidentified"

    fun read(raw: String?): JSONObject = runCatching { JSONObject(raw ?: "{}") }.getOrDefault(JSONObject())

    fun record(raw: String?, snapshot: DesktopSnapshot?, now: Long = System.currentTimeMillis()): String {
        val data = read(raw)
        val series = data.optJSONObject("series") ?: JSONObject().also { data.put("series", it) }
        for (p in snapshot?.providers.orEmpty()) {
            if (p.state != "ok") continue
            if (p.fetchedAt != null && now - p.fetchedAt > 30 * 60_000L) continue
            val account = accountRef(p.account)
            for (w in p.windows) {
                val used = w.usedPct?.takeIf { it.isFinite() } ?: continue
                val key = accountRef("${p.id}|$account|${w.kind}|${w.label}")
                val s = series.optJSONObject(key) ?: JSONObject().put("provider", p.id).put("account_ref", account)
                    .put("label", w.label).put("points", JSONArray()).also { series.put(key, it) }
                val points = s.optJSONArray("points") ?: JSONArray().also { s.put("points", it) }
                val last = points.optJSONObject(points.length() - 1)
                val reset = w.resetsAt?.toString() ?: "unknown"
                var segment = if (last?.optString("reset") == reset) last.optString("segment") else "$reset-$now"
                if (last != null && used < last.optDouble("used") - 1) segment = "$reset-$now"
                if (last != null && now - last.optLong("at") < 900_000 && segment == last.optString("segment")) continue
                points.put(JSONObject().put("at", now).put("used", used).put("reset", reset).put("segment", segment))
            }
        }
        for (key in series.keys().asSequence().toList()) {
            val s = series.optJSONObject(key) ?: continue
            val points = s.optJSONArray("points") ?: JSONArray()
            val valid = (0 until points.length()).mapNotNull { points.optJSONObject(it) }
                .filter { it.optLong("at") in (now - 31 * DAY)..now }.takeLast(9000)
            if (valid.isEmpty()) series.remove(key) else s.put("points", JSONArray(valid))
        }
        return data.toString()
    }

    fun event(raw: String?, title: String, body: String, delivery: String, now: Long = System.currentTimeMillis()): String {
        val data = read(raw)
        val old = data.optJSONArray("events") ?: JSONArray()
        val events = (0 until old.length()).mapNotNull { old.optJSONObject(it) }.filter { it.optLong("at") >= now - 31 * DAY }.takeLast(199)
        data.put("events", JSONArray(events).put(JSONObject().put("at", now).put("title", title.take(160)).put("body", body.take(500)).put("delivery", delivery)))
        return data.toString()
    }
}
