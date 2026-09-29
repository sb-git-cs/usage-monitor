package io.github.sbgitcs.usagemonitor.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.glance.GlanceId
import androidx.glance.GlanceTheme
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.provideContent
import androidx.glance.currentState
import androidx.glance.text.Text
import io.github.sbgitcs.usagemonitor.device.DeviceReadings
import io.github.sbgitcs.usagemonitor.device.DeviceStats
import io.github.sbgitcs.usagemonitor.net.Format

/** This phone's CPU clock, memory, storage and battery. */
class DeviceWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val stamp = currentState(Widgets.STAMP) ?: 0L
            val readings = remember(stamp) { runCatching { DeviceStats.read(context) }.getOrNull() }
            GlanceTheme { Content(readings) }
        }
    }

    @Composable
    private fun Content(r: DeviceReadings?) {
        WidgetFrame("Phone", r?.thermal?.takeIf { it != "Normal" && it != "Unknown" }) {
            if (r == null) {
                Text("Readings are not available.", style = smallStyle())
                return@WidgetFrame
            }
            r.cpuClockPct?.let { MeterRow("CPU clock", Format.percent(it), it, WidgetColors.forPercent(it, 85.0)) }
            MeterRow("Memory", "${Format.bytes(r.memUsed)} of ${Format.bytes(r.memTotal)}", r.memPct, WidgetColors.forPercent(r.memPct, 85.0))
            MeterRow("Storage", "${Format.bytes(r.storageUsed)} of ${Format.bytes(r.storageTotal)}", r.storagePct, WidgetColors.forPercent(r.storagePct, 90.0))
            val battery = listOfNotNull(
                r.batteryPct?.let { "Battery $it%" },
                if (r.charging) "charging" else null,
                r.batteryTempC?.let { "%.1f °C".format(it) },
            )
            if (battery.isNotEmpty()) Text(battery.joinToString(" · "), style = smallStyle(), maxLines = 1)
        }
    }
}

class DeviceWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DeviceWidget()
}
