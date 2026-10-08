package io.github.sbgitcs.usagemonitor.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalTime

/** The computer this phone is paired with. [masterKey] is base64url; the pairing code itself is not kept. */
data class PairedComputer(val name: String, val addresses: List<String>, val port: Int, val deviceId: String, val masterKey: String)

/** Everything the app remembers, in one SharedPreferences file that widgets and workers can read. */
class Settings(context: Context) {
    private val p: SharedPreferences = context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var computer: PairedComputer?
        get() = p.getString("computer", null)?.let { raw ->
            runCatching {
                val o = JSONObject(raw)
                val list = o.getJSONArray("addresses")
                PairedComputer(o.getString("name"), (0 until list.length()).map { list.getString(it) }, o.getInt("port"), o.getString("id"), o.getString("key"))
            }.getOrNull()
        }
        set(value) {
            val raw = value?.let {
                JSONObject().put("name", it.name).put("addresses", JSONArray(it.addresses)).put("port", it.port).put("id", it.deviceId).put("key", it.masterKey).toString()
            }
            p.edit().putString("computer", raw).apply()
        }

    /** Unpairs: drops the key and everything read from that computer. Linked sign-ins are dropped by the caller. */
    fun forgetComputer() {
        p.edit().remove("computer").remove("last_address").remove("snapshot").remove("snapshot_at").remove("last_error")
            .remove("direct_link").remove("tokens_at").apply()
    }

    /** Direct reading with the computer's sign-ins: "off", "asked" (waiting for the computer to allow it) or "on". */
    var directLink: String
        get() = p.getString("direct_link", "off") ?: "off"
        set(v) = p.edit().putString("direct_link", v).apply()

    /** When the computer's access tokens were last fetched. */
    var tokensAt: Long
        get() = p.getLong("tokens_at", 0)
        set(v) = p.edit().putLong("tokens_at", v).apply()

    /** Usage read directly by this phone, as snapshot providers JSON. Holds no sign-in data. */
    var directJson: String?
        get() = p.getString("direct", null)
        set(v) = p.edit().putString("direct", v).apply()

    var lastAddress: String?
        get() = p.getString("last_address", null)
        set(v) = p.edit().putString("last_address", v).apply()

    var snapshotJson: String?
        get() = p.getString("snapshot", null)
        set(v) = p.edit().putString("snapshot", v).apply()

    var snapshotAt: Long
        get() = p.getLong("snapshot_at", 0)
        set(v) = p.edit().putLong("snapshot_at", v).apply()

    var lastError: String?
        get() = p.getString("last_error", null)
        set(v) = p.edit().putString("last_error", v).apply()

    var billingDay: Int
        get() = p.getInt("billing_day", 1)
        set(v) = p.edit().putInt("billing_day", v.coerceIn(1, 31)).apply()

    /** Monthly mobile data allowance in MB; 0 means no cap. */
    var monthlyCapMb: Long
        get() = p.getLong("monthly_cap_mb", 0)
        set(v) = p.edit().putLong("monthly_cap_mb", v.coerceAtLeast(0)).apply()

    var dailyCapMb: Long
        get() = p.getLong("daily_cap_mb", 0)
        set(v) = p.edit().putLong("daily_cap_mb", v.coerceAtLeast(0)).apply()

    var capWarnPct: Int
        get() = p.getInt("cap_warn_pct", 80)
        set(v) = p.edit().putInt("cap_warn_pct", v.coerceIn(50, 95)).apply()

    var planAlerts: Boolean
        get() = p.getBoolean("plan_alerts", true)
        set(v) = p.edit().putBoolean("plan_alerts", v).apply()

    var forecastAlerts: Boolean
        get() = p.getBoolean("forecast_alerts", true)
        set(v) = p.edit().putBoolean("forecast_alerts", v).apply()

    var quietEnabled: Boolean
        get() = p.getBoolean("quiet_enabled", false)
        set(v) = p.edit().putBoolean("quiet_enabled", v).apply()

    var quietStart: String
        get() = p.getString("quiet_start", "22:00") ?: "22:00"
        set(v) = p.edit().putString("quiet_start", v).apply()

    var quietEnd: String
        get() = p.getString("quiet_end", "07:00") ?: "07:00"
        set(v) = p.edit().putString("quiet_end", v).apply()

    var speedNotification: Boolean
        get() = p.getBoolean("speed_notification", false)
        set(v) = p.edit().putBoolean("speed_notification", v).apply()

    var autoUpdate: Boolean
        get() = p.getBoolean("auto_update", true)
        set(v) = p.edit().putBoolean("auto_update", v).apply()

    /** "stable" or "beta". */
    var updateChannel: String
        get() = p.getString("update_channel", "stable") ?: "stable"
        set(v) = p.edit().putString("update_channel", if (v == "beta") "beta" else "stable").apply()

    var askedNotifications: Boolean
        get() = p.getBoolean("asked_notifications", false)
        set(v) = p.edit().putBoolean("asked_notifications", v).apply()

    var lastUpdateCheck: Long
        get() = p.getLong("last_update_check", 0)
        set(v) = p.edit().putLong("last_update_check", v).apply()

    var updateStatus: String?
        get() = p.getString("update_status", null)
        set(v) = p.edit().putString("update_status", v).apply()

    fun inQuietHours(now: LocalTime = LocalTime.now()): Boolean {
        if (!quietEnabled) return false
        val start = parseTime(quietStart) ?: return false
        val end = parseTime(quietEnd) ?: return false
        if (start == end) return true
        return if (start < end) !now.isBefore(start) && now.isBefore(end) else !now.isBefore(start) || now.isBefore(end)
    }

    /** Alert keys already notified, with when; old ones are dropped after 40 days. */
    fun alreadyFired(key: String): Boolean = fired().has(key)

    fun markFired(key: String, now: Long = System.currentTimeMillis()) {
        val all = fired()
        all.put(key, now)
        val stale = all.keys().asSequence().filter { now - all.optLong(it) > 40L * 24 * 60 * 60_000 }.toList()
        stale.forEach { all.remove(it) }
        p.edit().putString("fired", all.toString()).apply()
    }

    private fun fired(): JSONObject = runCatching { JSONObject(p.getString("fired", "{}") ?: "{}") }.getOrDefault(JSONObject())

    companion object {
        fun parseTime(s: String): LocalTime? = runCatching { LocalTime.parse(s) }.getOrNull()

        /** "7:5" is not a time, "7:05" and "07:05" are; returns the stored "07:05" form. */
        fun normalizeTime(s: String): String? {
            val m = Regex("""^\s*(\d{1,2}):(\d{2})\s*$""").find(s) ?: return null
            val (h, min) = m.destructured
            if (h.toInt() > 23 || min.toInt() > 59) return null
            return "%02d:%02d".format(java.util.Locale.US, h.toInt(), min.toInt())
        }
    }
}
