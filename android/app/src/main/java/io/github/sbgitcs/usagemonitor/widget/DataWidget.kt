package io.github.sbgitcs.usagemonitor.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.provideContent
import androidx.glance.currentState
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.net.DataPlan
import io.github.sbgitcs.usagemonitor.net.DataStatus
import io.github.sbgitcs.usagemonitor.net.DataUsage
import io.github.sbgitcs.usagemonitor.net.Format
import io.github.sbgitcs.usagemonitor.net.SpeedMeter
import java.time.ZonedDateTime

/** Mobile and Wi-Fi data today and this billing cycle, against the caps set in the app. */
class DataWidget : GlanceAppWidget() {
    private class Model(val status: DataStatus?, val monthlyCap: Long, val dailyCap: Long, val warnAt: Double, val projected: Long?, val speed: Pair<Double, Double>?)

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val stamp = currentState(Widgets.STAMP) ?: 0L
            val model = remember(stamp) { read(context) }
            GlanceTheme { Content(model) }
        }
    }

    private fun read(context: Context): Model {
        val settings = Settings(context)
        val now = ZonedDateTime.now(DataPlan.zone())
        val status = runCatching { DataUsage.status(context, settings.billingDay, now) }.getOrNull()
        val mb = 1024L * 1024
        return Model(
            status = status,
            monthlyCap = settings.monthlyCapMb * mb,
            dailyCap = settings.dailyCapMb * mb,
            warnAt = settings.capWarnPct.toDouble(),
            projected = status?.let { DataPlan.projected(it.cycle, settings.billingDay, now) },
            speed = SpeedMeter.latest,
        )
    }

    @Composable
    private fun Content(model: Model) {
        val speed = model.speed?.let { "↓ ${Format.rateShort(it.first)}  ↑ ${Format.rateShort(it.second)}" }
        WidgetFrame("Data", speed) {
            val status = model.status
            if (status == null) {
                Text("Open Usage Monitor and allow Usage access to see data use.", style = smallStyle())
                return@WidgetFrame
            }
            Row(modifier = GlanceModifier.fillMaxWidth()) {
                Figure("Mobile today", Format.bytes(status.today), GlanceModifier.defaultWeight())
                Figure("Wi-Fi today", Format.bytes(status.todayTotals.wifi), GlanceModifier.defaultWeight())
            }
            Spacer(GlanceModifier.height(6.dp))
            if (model.dailyCap > 0) {
                val pct = status.today * 100.0 / model.dailyCap
                MeterRow("Today's cap", "${Format.bytes(status.today)} of ${Format.bytes(model.dailyCap)}", pct, WidgetColors.forPercent(pct, model.warnAt))
            }
            val projected = model.projected?.let { "on pace for ${Format.bytes(it)}" }
            if (model.monthlyCap > 0) {
                val pct = status.cycle * 100.0 / model.monthlyCap
                MeterRow("Mobile this cycle", "${Format.bytes(status.cycle)} of ${Format.bytes(model.monthlyCap)}", pct, WidgetColors.forPercent(pct, model.warnAt), projected)
            } else {
                Text("This cycle: mobile ${Format.bytes(status.cycle)} · Wi-Fi ${Format.bytes(status.cycleTotals.wifi)}", style = smallStyle(), maxLines = 1)
            }
        }
    }

    @Composable
    private fun Figure(label: String, value: String, modifier: GlanceModifier) {
        Column(modifier = modifier) {
            Text(label, style = smallStyle(), maxLines = 1)
            Text(value, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 18.sp, fontWeight = FontWeight.Bold), maxLines = 1)
        }
    }
}

class DataWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DataWidget()
}
