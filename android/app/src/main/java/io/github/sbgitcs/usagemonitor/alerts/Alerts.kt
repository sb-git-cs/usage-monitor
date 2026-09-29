package io.github.sbgitcs.usagemonitor.alerts

import android.content.Context
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.net.DataStatus
import io.github.sbgitcs.usagemonitor.net.Format
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.roundToInt

/**
 * Notifications the phone shows itself: plan windows past the computer's "warn at" percentage,
 * windows on course to run out before they reset, and the mobile data plan's caps. Each fires
 * once; during quiet hours it is recorded but not shown.
 */
object Alerts {
    private const val FORECAST_MIN_USED = 50.0

    private data class Alert(val key: String, val title: String, val text: String)

    fun check(context: Context, settings: Settings, snapshot: DesktopSnapshot?, data: DataStatus?) {
        val due = mutableListOf<Alert>()
        if (snapshot != null && settings.planAlerts) {
            for (p in snapshot.providers) {
                if (p.state != "ok") continue
                for (w in p.windows) {
                    val used = w.usedPct ?: continue
                    val window = "${p.id}|${w.kind}|${w.label}|${w.resetsAt ?: 0}"
                    if (used >= 100) due += Alert("plan-full|$window", p.name, "${w.label} limit reached")
                    else if (used >= snapshot.alertThreshold) due += Alert("plan-warn|$window", p.name, "${w.label} is ${used.roundToInt()}% used")
                    val forecast = w.forecastAt
                    if (settings.forecastAlerts && forecast != null && w.resetsAt != null && used >= FORECAST_MIN_USED && used < 100) {
                        due += Alert("plan-forecast|$window", p.name, "${w.label} is ${used.roundToInt()}% used. At this pace it reaches 100% around ${clock(forecast)}, before it resets at ${clock(w.resetsAt)}.")
                    }
                }
            }
        }
        if (data != null) {
            val warn = settings.capWarnPct
            val monthly = settings.monthlyCapMb * 1024 * 1024
            if (monthly > 0) {
                val pct = data.cycle * 100.0 / monthly
                if (pct >= 100) due += Alert("cycle-full|${data.cycleStart}", "Mobile data cap reached", "${Format.bytes(data.cycle)} of ${Format.bytes(monthly)} used this billing cycle.")
                else if (pct >= warn) due += Alert("cycle-warn|${data.cycleStart}", "Mobile data at ${pct.roundToInt()}%", "${Format.bytes(data.cycle)} of ${Format.bytes(monthly)} used this billing cycle.")
            }
            val daily = settings.dailyCapMb * 1024 * 1024
            if (daily > 0) {
                val pct = data.today * 100.0 / daily
                if (pct >= 100) due += Alert("day-full|${data.day}", "Daily mobile data cap reached", "${Format.bytes(data.today)} of ${Format.bytes(daily)} used today.")
                else if (pct >= warn) due += Alert("day-warn|${data.day}", "Mobile data today at ${pct.roundToInt()}%", "${Format.bytes(data.today)} of ${Format.bytes(daily)} used today.")
            }
        }
        val quiet = settings.inQuietHours()
        for (a in due) {
            if (settings.alreadyFired(a.key)) continue
            settings.markFired(a.key)
            if (!quiet) Notifications.show(context, Notifications.ALERTS, a.key.hashCode(), a.title, a.text)
        }
    }

    private fun clock(ms: Long): String =
        DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))
}
