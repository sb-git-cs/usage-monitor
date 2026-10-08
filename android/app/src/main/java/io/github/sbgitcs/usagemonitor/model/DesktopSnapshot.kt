package io.github.sbgitcs.usagemonitor.model

import org.json.JSONArray
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

data class SavedAccount(val id: String, val label: String, val active: Boolean)

data class Provider(
    val id: String,
    val name: String,
    val plan: String?,
    val state: String,
    val hint: String?,
    val windows: List<PlanWindow>,
    val account: String? = null,
    val accounts: List<SavedAccount> = emptyList(),
    val source: String = "desktop",
    val fetchedAt: Long? = null,
    val usageSummary: String? = null,
    val usageValue: String? = null,
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
                val saved = p.optJSONArray("accounts")
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
                    account = p.stringOrNull("account"),
                    source = p.optString("source", "desktop"),
                    fetchedAt = p.timeOrNull("fetched_at"),
                    usageSummary = p.stringOrNull("usage_summary"),
                    usageValue = p.stringOrNull("usage_value"),
                    accounts = (0 until (saved?.length() ?: 0)).mapNotNull { j ->
                        val item = saved?.optJSONObject(j) ?: return@mapNotNull null
                        val id = item.optString("id")
                        val label = item.optString("label")
                        if (id.isEmpty() || label.isEmpty()) null else SavedAccount(id, label, item.optBoolean("active"))
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

        /** Providers in the snapshot's own format, so [parse] reads them back. */
        fun providersJson(providers: List<Provider>): String = JSONObject().put("providers", JSONArray(providers.map { p ->
            JSONObject().put("id", p.id).put("display_name", p.name).putOpt("plan", p.plan)
                .put("status", JSONObject().put("state", p.state).putOpt("hint", p.hint))
                .putOpt("account", p.account).put("source", p.source).putOpt("fetched_at", p.fetchedAt?.let { Instant.ofEpochMilli(it).toString() })
                .putOpt("usage_summary", p.usageSummary).putOpt("usage_value", p.usageValue)
                .put("windows", JSONArray(p.windows.map { w ->
                    JSONObject().put("kind", w.kind).put("label", w.label).putOpt("used_pct", w.usedPct)
                        .putOpt("resets_at", w.resetsAt?.let { Instant.ofEpochMilli(it).toString() })
                        .putOpt("forecast_at", w.forecastAt?.let { Instant.ofEpochMilli(it).toString() })
                        .putOpt("burn_per_hour", w.burnPerHour)
                }))
        })).toString()

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
