package io.github.sbgitcs.usagemonitor.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.glance.GlanceId
import androidx.glance.GlanceTheme
import androidx.glance.LocalSize
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.provideContent
import androidx.glance.currentState
import androidx.glance.text.Text
import io.github.sbgitcs.usagemonitor.device.DeviceReadings
import io.github.sbgitcs.usagemonitor.device.DeviceStats
import io.github.sbgitcs.usagemonitor.net.Format
import io.github.sbgitcs.usagemonitor.ui.Tab

/** This phone's CPU clock, memory, storage and battery. */
class DeviceWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val stamp = currentState(Widgets.STAMP) ?: 0L
            val readings = remember(stamp) { runCatching { DeviceStats.read(context) }.getOrNull() }
            GlanceTheme { Content(readings) }
        }
    }

    @Composable
    private fun Content(r: DeviceReadings?) {
        val tier = widgetTier(LocalSize.current.width.value, LocalSize.current.height.value)
        if (tier == WidgetTier.LARGE) {
            Large(r)
            return
        }
        val battery = WidgetStat(if (r?.charging == true) "Charging" else "Battery", r?.batteryPct?.let { "$it%" } ?: "—")
        val ram = WidgetStat("RAM", r?.let { Format.percent(it.memPct) } ?: "—")
        when (tier) {
            WidgetTier.ONE -> OneCell(battery.value, battery.label, Tab.Phone)
            WidgetTier.WIDE -> WideStats(listOf(battery, ram), Tab.Phone)
            WidgetTier.STRIP -> StripStats(
                listOf(
                    WidgetStat("CPU", r?.cpuClockPct?.let { Format.percent(it) } ?: "—"),
                    ram,
                    WidgetStat("Disk", r?.let { Format.percent(it.storagePct) } ?: "—"),
                    battery,
                ),
                Tab.Phone,
            )
            WidgetTier.LARGE -> Unit
        }
    }

    @Composable
    private fun Large(r: DeviceReadings?) {
        WidgetFrame("Phone · Local", r?.thermal?.takeIf { it != "Normal" && it != "Unknown" }, Tab.Phone) {
            if (r == null) {
                Text("Readings are not available.", style = smallStyle())
                return@WidgetFrame
            }
            val battery = listOfNotNull(
                r.batteryPct?.let { "Battery $it%" },
                if (r.charging) "charging" else null,
                r.batteryTempC?.let { "%.1f °C".format(it) },
            )
            LazyColumn {
                r.cpuClockPct?.let { clock -> item { MeterRow("CPU clock", Format.percent(clock), clock, WidgetColors.forPercent(clock, 85.0)) } }
                item { MeterRow("Memory", "${Format.bytes(r.memUsed)} of ${Format.bytes(r.memTotal)}", r.memPct, WidgetColors.forPercent(r.memPct, 85.0)) }
                item { MeterRow("Storage", "${Format.bytes(r.storageUsed)} of ${Format.bytes(r.storageTotal)}", r.storagePct, WidgetColors.forPercent(r.storagePct, 90.0)) }
                if (battery.isNotEmpty()) item { Text(battery.joinToString(" · "), style = smallStyle(), maxLines = 2) }
            }
        }
    }
}

class DeviceWidgetReceiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DeviceWidget()
}
