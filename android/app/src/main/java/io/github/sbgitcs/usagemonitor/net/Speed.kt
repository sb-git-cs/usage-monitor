package io.github.sbgitcs.usagemonitor.net

import android.net.TrafficStats
import android.os.SystemClock

/** Whole-phone download and upload speed from the kernel's byte counters. */
class SpeedMeter {
    private var lastRx = -1L
    private var lastTx = -1L
    private var lastAt = 0L

    /** Bytes per second since the previous call; (0, 0) on the first call. */
    fun sample(): Pair<Double, Double> {
        val rx = TrafficStats.getTotalRxBytes()
        val tx = TrafficStats.getTotalTxBytes()
        val now = SystemClock.elapsedRealtime()
        val result = if (lastAt == 0L || rx < 0 || tx < 0 || rx < lastRx || tx < lastTx) 0.0 to 0.0 else {
            val seconds = ((now - lastAt) / 1000.0).coerceAtLeast(0.25)
            (rx - lastRx) / seconds to (tx - lastTx) / seconds
        }
        lastRx = rx
        lastTx = tx
        lastAt = now
        return result
    }

    companion object {
        /** The latest reading of the running speed notification, for the Quick Settings tile. */
        @Volatile var latest: Pair<Double, Double>? = null
    }
}
