package io.github.sbgitcs.usagemonitor.device

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import java.io.File

data class DeviceReadings(
    val memUsed: Long,
    val memTotal: Long,
    val storageUsed: Long,
    val storageTotal: Long,
    val batteryPct: Int?,
    val batteryTempC: Double?,
    val charging: Boolean,
    /** Positive while charging, in mA; many phones report it, some do not. */
    val currentMa: Int?,
    val thermal: String,
    /** Current clock of all cores as a share of their maximum; the closest a normal app can get to CPU load. */
    val cpuClockPct: Double?,
    val coreMhz: List<Int?>,
) {
    val memPct: Double get() = if (memTotal > 0) memUsed * 100.0 / memTotal else 0.0
    val storagePct: Double get() = if (storageTotal > 0) storageUsed * 100.0 / storageTotal else 0.0
}

/**
 * Phone readings an app may read. Android 8+ keeps system-wide CPU usage (/proc/stat) from
 * apps, so CPU is shown as clock speed against each core's maximum.
 */
object DeviceStats {
    fun read(context: Context): DeviceReadings {
        val am = context.getSystemService(ActivityManager::class.java)
        val mem = ActivityManager.MemoryInfo().also { am?.getMemoryInfo(it) }

        val stat = StatFs(Environment.getDataDirectory().path)
        val storageTotal = stat.totalBytes
        val storageUsed = storageTotal - stat.availableBytes

        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val temp = battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE) ?: Int.MIN_VALUE
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        val bm = context.getSystemService(BatteryManager::class.java)
        val microAmps = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW) ?: Int.MIN_VALUE
        // Vendors disagree on the sign and on µA versus mA; report the size, signed by charging.
        val currentMa = if (microAmps == Int.MIN_VALUE || microAmps == 0) null else {
            val raw = kotlin.math.abs(microAmps)
            val ma = if (raw > 20_000) raw / 1000 else raw
            if (charging) ma else -ma
        }

        val pm = context.getSystemService(PowerManager::class.java)
        val thermal = when (pm?.currentThermalStatus) {
            PowerManager.THERMAL_STATUS_NONE -> "Normal"
            PowerManager.THERMAL_STATUS_LIGHT -> "Warm"
            PowerManager.THERMAL_STATUS_MODERATE -> "Hot"
            PowerManager.THERMAL_STATUS_SEVERE -> "Very hot"
            PowerManager.THERMAL_STATUS_CRITICAL, PowerManager.THERMAL_STATUS_EMERGENCY, PowerManager.THERMAL_STATUS_SHUTDOWN -> "Critical"
            else -> "Unknown"
        }

        val cores = Runtime.getRuntime().availableProcessors()
        val cur = (0 until cores).map { readKhz("/sys/devices/system/cpu/cpu$it/cpufreq/scaling_cur_freq") }
        val max = (0 until cores).map { readKhz("/sys/devices/system/cpu/cpu$it/cpufreq/cpuinfo_max_freq") }
        val pairs = cur.zip(max).filter { (c, m) -> c != null && m != null && m > 0 }
        val clockPct = if (pairs.isEmpty()) null else pairs.sumOf { it.first!!.toDouble() } * 100 / pairs.sumOf { it.second!!.toDouble() }

        return DeviceReadings(
            memUsed = mem.totalMem - mem.availMem,
            memTotal = mem.totalMem,
            storageUsed = storageUsed,
            storageTotal = storageTotal,
            batteryPct = if (level >= 0 && scale > 0) level * 100 / scale else null,
            batteryTempC = if (temp == Int.MIN_VALUE) null else temp / 10.0,
            charging = charging,
            currentMa = currentMa,
            thermal = thermal,
            cpuClockPct = clockPct?.coerceIn(0.0, 100.0),
            coreMhz = cur.map { it?.let { khz -> (khz / 1000).toInt() } },
        )
    }

    private fun readKhz(path: String): Long? = runCatching { File(path).readText().trim().toLong() }.getOrNull()
}
