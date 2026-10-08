package io.github.sbgitcs.usagemonitor.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.sbgitcs.usagemonitor.device.DeviceReadings
import io.github.sbgitcs.usagemonitor.device.DeviceStats
import io.github.sbgitcs.usagemonitor.net.Format
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Locale

/** This phone's CPU clock, memory, storage and battery, read every two seconds while on screen. */
@Composable
fun DeviceScreen() {
    val context = LocalContext.current
    var r by remember { mutableStateOf<DeviceReadings?>(null) }
    WhileVisible(Unit, 2000) {
        r = withContext(Dispatchers.IO) { runCatching { DeviceStats.read(context) }.getOrNull() }
    }
    val readings = r ?: return
    val columns = if (LocalDensity.current.fontScale > 1.3f) 2 else 3

    ScreenList {
        item {
            Section("Battery") {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Figure("Level", readings.batteryPct?.let { "$it%" } ?: "—", Modifier.weight(1f))
                    Figure("Temperature", readings.batteryTempC?.let { String.format(Locale.US, "%.1f °C", it) } ?: "—", Modifier.weight(1f))
                }
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Figure(if (readings.charging) "Charging at" else "Drawing", readings.currentMa?.let { "${kotlin.math.abs(it)} mA" } ?: "—", Modifier.weight(1f))
                    Figure("Heat", readings.thermal, Modifier.weight(1f))
                }
            }
        }
        item {
            Section("Resources") {
                Meter("Memory", "${Format.bytes(readings.memUsed)} of ${Format.bytes(readings.memTotal)}", readings.memPct, meterColor(readings.memPct, 85.0))
                Meter("Storage", "${Format.bytes(readings.storageUsed)} of ${Format.bytes(readings.storageTotal)}", readings.storagePct, meterColor(readings.storagePct, 90.0))
            }
        }
        item {
            Section("CPU clocks") {
                val clock = readings.cpuClockPct
                if (clock != null) {
                    Meter("Clock speed", Format.percent(clock), clock, meterColor(clock, 85.0))
                } else {
                    Note("This phone does not share its CPU clock with apps.")
                }
                val cores = readings.coreMhz
                if (cores.any { it != null }) {
                    Spacer(Modifier.height(4.dp))
                    cores.chunked(columns).forEachIndexed { row, group ->
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            group.forEachIndexed { i, mhz ->
                                Column(Modifier.weight(1f)) {
                                    Note("Core ${row * columns + i + 1}")
                                    Text(mhz?.let { "$it MHz" } ?: "Off", style = MaterialTheme.typography.labelLarge,
                                        fontWeight = FontWeight.SemiBold)
                                }
                            }
                            repeat(columns - group.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
                Note("Clock speed relative to each core's maximum. This is not CPU utilization.")
            }
        }
    }
}
