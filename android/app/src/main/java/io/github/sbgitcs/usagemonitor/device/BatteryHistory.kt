package io.github.sbgitcs.usagemonitor.device

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlin.math.abs
import kotlin.math.roundToLong

data class BatteryReading(val t: Long, val percent: Int?, val state: String,
                          val seconds: Long? = null, val source: String? = null, val gap: Boolean = false) {
    val description: String get() = when {
        percent == null || state == "unknown" -> "Unavailable"
        state == "full" -> "Full"
        state == "plugged" -> "Plugged in · not charging"
        seconds == null -> "Estimating…"
        else -> "~${batteryDuration(seconds)} ${if (state == "charging") "to full" else "left"}"
    }
}

fun batteryDuration(seconds: Long): String {
    val minutes = (seconds / 60.0).roundToLong().coerceAtLeast(1)
    return if (minutes < 60) "${minutes}m" else "${minutes / 60}h ${minutes % 60}m"
}

data class BatterySession(val first: BatteryReading, val last: BatteryReading, val partial: Boolean)

object BatteryLogic {
    const val GAP = 20 * 60_000L
    const val DAY = 86_400_000L
    fun estimate(r: BatteryReading, points: List<BatteryReading>): BatteryReading {
        if (r.seconds != null || r.percent == null || r.state !in listOf("charging", "discharging")) return r
        val recent = mutableListOf<BatteryReading>()
        for (p in points.asReversed()) {
            if (p.t >= r.t) continue
            val next = recent.lastOrNull() ?: r
            if (p.state != r.state || next.gap || next.t - p.t > GAP || r.t - p.t > 30 * 60_000L) break
            recent += p
            if (p.gap) break
        }
        val first = recent.lastOrNull() ?: return r
        val delta = r.percent - (first.percent ?: return r)
        if (r.t - first.t < 5 * 60_000L || abs(delta) < 2 || (if (r.state == "charging") delta <= 0 else delta >= 0)) return r
        val target = if (r.state == "charging") 100 - r.percent else r.percent
        return r.copy(seconds = (target.toDouble() / abs(delta) * (r.t - first.t) / 1000).roundToLong(), source = "observed")
    }
    fun sessions(points: List<BatteryReading>): List<BatterySession> {
        val result = mutableListOf<BatterySession>()
        var start = 0
        var completeStart = false
        for (i in 1..points.size) {
            val last = points[i - 1]
            val next = points.getOrNull(i)
            val continuous = next != null && !next.gap && next.t - last.t <= GAP
            if (next == null || !continuous || next.state != last.state) {
                if (points[start].state in listOf("charging", "discharging"))
                    result += BatterySession(points[start], last, !completeStart || !continuous)
                start = i
                completeStart = continuous
            }
        }
        return result.reversed()
    }
}

/** Local observations only. Atomic replacement protects history if a write is interrupted. */
class BatteryHistory internal constructor(context: Context) {
    private val file = File(context.filesDir, "battery-history.json")
    private var boundary = true
    private val points = mutableListOf<BatteryReading>()
    var error = false; private set
    var latest: BatteryReading? = null; private set
    init {
        runCatching {
            val data = JSONObject(file.readText())
            val rows = if (data.optInt("version") == 1) data.optJSONArray("points") else null
            for (i in 0 until (rows?.length() ?: 0)) {
                val p = rows!!.optJSONObject(i) ?: continue
                val pct = p.optInt("percent", -1)
                val t = p.optLong("t")
                val state = p.optString("state")
                if (pct in 0..100 && t > 0 && state in listOf("charging", "discharging", "full", "plugged", "unknown"))
                    points += BatteryReading(t, pct, state, p.optLong("seconds", -1).takeIf { it >= 0 },
                        p.optString("source").takeIf { it in listOf("system", "observed") }, p.optBoolean("g"))
            }
            points.sortBy { it.t }
        }.onFailure { error = it !is java.io.FileNotFoundException }
        prune(System.currentTimeMillis())
    }
    private fun prune(now: Long) {
        points.removeAll { it.t < now - 30 * BatteryLogic.DAY || it.t > now }
        if (points.size > 45000) points.subList(0, points.size - 45000).clear()
    }
    @Synchronized fun record(raw: BatteryReading): BatteryReading {
        val last = points.lastOrNull()
        if (last != null && raw.t <= last.t && !boundary) return latest ?: raw
        val reading = BatteryLogic.estimate(raw.copy(gap = boundary || last == null || raw.t - last.t > BatteryLogic.GAP || raw.t <= last.t), points)
        latest = reading
        if (reading.percent == null) { boundary = true; return reading }
        if (last != null && !reading.gap && last.state == reading.state && reading.t - last.t < 60_000) return reading
        points += reading; boundary = false; prune(reading.t); save()
        return reading
    }
    @Synchronized fun view(days: Int = 7): List<BatteryReading> {
        val now = System.currentTimeMillis(); prune(now)
        return points.filter { it.t >= now - days * BatteryLogic.DAY }
    }
    @Synchronized fun clear(): Boolean { points.clear(); boundary = true; return save() }
    @Synchronized fun breakSegment() { boundary = true }
    private fun save(): Boolean {
        return try {
            val rows = JSONArray()
            for (p in points) rows.put(JSONObject().put("t", p.t).put("percent", p.percent).put("state", p.state)
                .put("seconds", p.seconds ?: JSONObject.NULL).put("source", p.source ?: JSONObject.NULL).put("g", p.gap))
            val temp = File(file.parentFile, "${file.name}.tmp")
            temp.outputStream().use {
                it.write(JSONObject().put("version", 1).put("points", rows).toString().toByteArray(Charsets.UTF_8))
                it.fd.sync()
            }
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            error = false; true
        } catch (_: Exception) { error = true; false }
    }
    companion object {
        @Volatile private var instance: BatteryHistory? = null
        fun get(context: Context): BatteryHistory = instance ?: synchronized(this) {
            instance ?: BatteryHistory(context.applicationContext).also { instance = it }
        }
    }
}

object BatteryMonitor {
    fun refresh(context: Context, intent: Intent? = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))): BatteryReading {
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val pct = if (level >= 0 && scale > 0 && level <= scale) level * 100 / scale else null
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val plugged = (intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        val state = when {
            pct == null -> "unknown"
            status == BatteryManager.BATTERY_STATUS_FULL -> "full"
            status == BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
            plugged -> "plugged"
            status == BatteryManager.BATTERY_STATUS_DISCHARGING -> "discharging"
            else -> "unknown"
        }
        val estimate = if (state == "charging") runCatching {
            context.getSystemService(BatteryManager::class.java)?.computeChargeTimeRemaining()?.takeIf { it > 0 }?.div(1000)
        }.getOrNull() else null
        return BatteryHistory.get(context).record(BatteryReading(System.currentTimeMillis(), pct, state, estimate, if (estimate != null) "system" else null))
    }
}
