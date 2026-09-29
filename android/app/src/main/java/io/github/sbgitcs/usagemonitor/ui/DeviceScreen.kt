package io.github.sbgitcs.usagemonitor.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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

    ScreenList {
        item {
            Section("CPU") {
                val clock = readings.cpuClockPct
                if (clock != null) {
                    Meter("Clock speed", Format.percent(clock), clock, meterColor(clock, 85.0))
                } else {
                    Note("This phone does not share its CPU clock with apps.")
                }
                val cores = readings.coreMhz
                if (cores.any { it != null }) {
                    Spacer(Modifier.height(4.dp))
                    cores.chunked(4).forEachIndexed { row, group ->
                        Row {
                            group.forEachIndexed { i, mhz ->
                                Figure("Core ${row * 4 + i + 1}", mhz?.let { "$it MHz" } ?: "off", Modifier.weight(1f))
                            }
                            repeat(4 - group.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                Note("Android does not let apps read how busy the CPU is, so this shows how fast the cores run compared with their top speed. A busy phone runs them faster.")
            }
        }
        item {
            Section("Memory") {
                Meter("In use", "${Format.bytes(readings.memUsed)} of ${Format.bytes(readings.memTotal)}", readings.memPct, meterColor(readings.memPct, 85.0))
            }
        }
        item {
            Section("Storage") {
                Meter("Used", "${Format.bytes(readings.storageUsed)} of ${Format.bytes(readings.storageTotal)}", readings.storagePct, meterColor(readings.storagePct, 90.0))
            }
        }
        item {
            Section("Battery") {
                Row {
                    Figure("Level", readings.batteryPct?.let { "$it%" } ?: "—", Modifier.weight(1f))
                    Figure("Temperature", readings.batteryTempC?.let { String.format(Locale.US, "%.1f °C", it) } ?: "—", Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                Row {
                    Figure(if (readings.charging) "Charging at" else "Drawing", readings.currentMa?.let { "${kotlin.math.abs(it)} mA" } ?: "—", Modifier.weight(1f))
                    Figure("Heat", readings.thermal, Modifier.weight(1f))
                }
            }
        }
    }
}
