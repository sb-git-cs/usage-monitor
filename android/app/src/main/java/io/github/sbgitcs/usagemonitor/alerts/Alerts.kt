package io.github.sbgitcs.usagemonitor.alerts

import android.content.Context
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.model.Provider
import io.github.sbgitcs.usagemonitor.model.PlanWindow
import io.github.sbgitcs.usagemonitor.data.InsightHistory
import io.github.sbgitcs.usagemonitor.net.DataStatus
import io.github.sbgitcs.usagemonitor.net.Format
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.roundToInt

internal fun planWindowKey(p: Provider, w: PlanWindow): String {
    // A linked token with the same provider account reads the same pool as the PC.
    // Without a stable account ID, keep sources isolated.
    val account = p.accountId?.let { InsightHistory.accountRef(it) }
        ?: "${p.source}|${InsightHistory.accountRef(p.cacheScope ?: p.account)}"
    return "${p.subscriptionRegime}|${p.id}|$account|${w.kind}|${w.label}|${w.resetsAt ?: 0}"
}

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
                    if (w.resetsAt != null && w.resetsAt <= System.currentTimeMillis()) continue
                    val window = planWindowKey(p, w)
                    if (used >= 100) due += Alert("plan-full|$window", p.name, "${w.label} limit reached")
                    else if (used >= snapshot.alertThreshold) due += Alert("plan-warn|$window", p.name, "${w.label} is ${used.roundToInt()}% used")
                    val forecast = w.forecastAt
                    if (settings.forecastAlerts && forecast != null && w.resetsAt != null && forecast > System.currentTimeMillis() && forecast < w.resetsAt && used >= FORECAST_MIN_USED && used < 100) {
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
        val quiet = settings.inQuietHours() || settings.snoozeUntil > System.currentTimeMillis()
        for (a in due) {
            if (settings.alreadyFired(a.key)) continue
            settings.markFired(a.key)
            val allowed = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()
            settings.recordEvent(a.title, a.text, if (quiet) "Suppressed" else if (!allowed) "Permission denied" else "Delivery requested")
            if (!quiet) Notifications.show(context, Notifications.ALERTS, a.key.hashCode(), a.title, a.text)
        }
    }

    private fun clock(ms: Long): String =
        DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))
}
