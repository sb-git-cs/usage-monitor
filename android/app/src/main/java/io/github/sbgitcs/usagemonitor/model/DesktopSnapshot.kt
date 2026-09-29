package io.github.sbgitcs.usagemonitor.model

import org.json.JSONObject
import java.time.Instant

data class PlanWindow(
    val kind: String,
    val label: String,
    val usedPct: Double?,
    val resetsAt: Long?,
    val forecastAt: Long?,
    val burnPerHour: Double?,
)

data class Provider(
    val id: String,
    val name: String,
    val plan: String?,
    val state: String,
    val hint: String?,
    val windows: List<PlanWindow>,
) {
    /** The window the chips show: 5-hour first, then daily, else the fullest one (like the desktop). */
    fun currentWindow(): PlanWindow? {
        val numeric = windows.filter { it.usedPct != null }
        if (numeric.isEmpty()) return null
        val preferred = numeric.filter { it.kind == "five_hour" }.ifEmpty { numeric.filter { it.kind == "daily" } }.ifEmpty { numeric }
        return preferred.maxByOrNull { it.usedPct ?: 0.0 }
    }
}

data class SystemReadings(val cpu: Double?, val mem: Double?, val gpu: Double?, val disk: Double?, val diskRate: Double?, val space: Double?)

data class DesktopNetwork(val state: String, val rxRate: Double, val txRate: Double)

data class DesktopSnapshot(
    val appVersion: String,
    val name: String,
    val generatedAt: Long,
    val alertThreshold: Int,
    val providers: List<Provider>,
    val system: SystemReadings?,
    val network: DesktopNetwork?,
) {
    companion object {
        /** Parses the /v1/snapshot payload; unknown fields are ignored. */
        fun parse(json: String): DesktopSnapshot {
            val o = JSONObject(json)
            val providers = o.optJSONArray("providers")
            val list = (0 until (providers?.length() ?: 0)).map { i ->
                val p = providers!!.getJSONObject(i)
                val status = p.optJSONObject("status")
                val wins = p.optJSONArray("windows")
                Provider(
                    id = p.optString("id"),
                    name = p.optString("display_name", p.optString("id")),
                    plan = p.stringOrNull("plan"),
                    state = status?.optString("state", "unknown") ?: "unknown",
                    hint = status?.stringOrNull("hint"),
                    windows = (0 until (wins?.length() ?: 0)).map { j ->
                        val w = wins!!.getJSONObject(j)
                        PlanWindow(
                            kind = w.optString("kind"),
                            label = w.optString("label"),
                            usedPct = w.numberOrNull("used_pct"),
                            resetsAt = w.timeOrNull("resets_at"),
                            forecastAt = w.timeOrNull("forecast_at"),
                            burnPerHour = w.numberOrNull("burn_per_hour"),
                        )
                    },
                )
            }
            val sys = o.optJSONObject("system")
            val net = o.optJSONObject("network")
            return DesktopSnapshot(
                appVersion = o.optString("app_version"),
                name = o.optString("name", "Computer"),
                generatedAt = o.timeOrNull("generated_at") ?: System.currentTimeMillis(),
                alertThreshold = o.optInt("alert_threshold", 80).coerceIn(50, 100),
                providers = list,
                system = sys?.let {
                    SystemReadings(it.numberOrNull("cpu"), it.numberOrNull("mem"), it.numberOrNull("gpu"), it.numberOrNull("disk"), it.numberOrNull("disk_rate"), it.numberOrNull("space"))
                },
                network = net?.let { DesktopNetwork(it.optString("state"), it.numberOrNull("rx_rate") ?: 0.0, it.numberOrNull("tx_rate") ?: 0.0) },
            )
        }

        private fun JSONObject.stringOrNull(key: String): String? =
            if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

        private fun JSONObject.numberOrNull(key: String): Double? {
            if (!has(key) || isNull(key)) return null
            val v = optDouble(key)
            return if (v.isNaN() || v.isInfinite()) null else v
        }

        private fun JSONObject.timeOrNull(key: String): Long? =
            stringOrNull(key)?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    }
}
