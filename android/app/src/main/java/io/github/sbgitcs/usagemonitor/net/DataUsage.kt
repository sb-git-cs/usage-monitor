package io.github.sbgitcs.usagemonitor.net

import android.app.AppOpsManager
import android.app.usage.NetworkStats
import android.app.usage.NetworkStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.os.Process
import java.time.ZonedDateTime

data class DataTotals(val mobileRx: Long, val mobileTx: Long, val wifiRx: Long, val wifiTx: Long, val roaming: Long) {
    val mobile: Long get() = mobileRx + mobileTx
    val wifi: Long get() = wifiRx + wifiTx

    companion object {
        val EMPTY = DataTotals(0, 0, 0, 0, 0)
    }
}

/** Data used today and in the current billing cycle; [today] and [cycle] are the mobile bytes the caps count. */
data class DataStatus(val todayTotals: DataTotals, val cycleTotals: DataTotals, val cycleStart: Long, val cycleEnd: Long, val day: String) {
    val today: Long get() = todayTotals.mobile
    val cycle: Long get() = cycleTotals.mobile
}

data class AppData(val uid: Int, val name: String, val packageName: String?, val mobile: Long, val wifi: Long) {
    val total: Long get() = mobile + wifi
}

/** Mobile and Wi-Fi data from Android's own accounting (NetworkStatsManager); needs Usage access. */
@Suppress("DEPRECATION") // NetworkStatsManager still takes the ConnectivityManager.TYPE_* constants.
object DataUsage {
    fun hasAccess(context: Context): Boolean {
        val ops = context.getSystemService(AppOpsManager::class.java) ?: return false
        val mode = ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /** Null without Usage access. Blocking (binder calls); keep it off the main thread. */
    fun status(context: Context, billingDay: Int, now: ZonedDateTime = ZonedDateTime.now(DataPlan.zone())): DataStatus? {
        if (!hasAccess(context)) return null
        val end = now.toInstant().toEpochMilli()
        val day = DataPlan.dayStart(now)
        val cycleStart = DataPlan.cycleStart(billingDay, now).toInstant().toEpochMilli()
        val cycleEnd = DataPlan.cycleEnd(billingDay, now).toInstant().toEpochMilli()
        return DataStatus(
            totals(context, day.toInstant().toEpochMilli(), end),
            totals(context, cycleStart, end),
            cycleStart,
            cycleEnd,
            day.toLocalDate().toString(),
        )
    }

    fun totals(context: Context, start: Long, end: Long): DataTotals {
        if (!hasAccess(context)) return DataTotals.EMPTY
        val nsm = context.getSystemService(NetworkStatsManager::class.java) ?: return DataTotals.EMPTY
        return runCatching {
            val mobile = nsm.querySummaryForDevice(ConnectivityManager.TYPE_MOBILE, null, start, end)
            val wifi = nsm.querySummaryForDevice(ConnectivityManager.TYPE_WIFI, null, start, end)
            var roaming = 0L
            eachBucket(nsm, ConnectivityManager.TYPE_MOBILE, start, end) { b ->
                if (b.roaming == NetworkStats.Bucket.ROAMING_YES) roaming += b.rxBytes + b.txBytes
            }
            DataTotals(mobile.rxBytes, mobile.txBytes, wifi.rxBytes, wifi.txBytes, roaming)
        }.getOrDefault(DataTotals.EMPTY)
    }

    /** Per app, largest first. Apps that share a user id (like system services) are one row. */
    fun perApp(context: Context, start: Long, end: Long): List<AppData> {
        if (!hasAccess(context)) return emptyList()
        val nsm = context.getSystemService(NetworkStatsManager::class.java) ?: return emptyList()
        val mobile = HashMap<Int, Long>()
        val wifi = HashMap<Int, Long>()
        runCatching {
            eachBucket(nsm, ConnectivityManager.TYPE_MOBILE, start, end) { b -> mobile.merge(b.uid, b.rxBytes + b.txBytes, Long::plus) }
            eachBucket(nsm, ConnectivityManager.TYPE_WIFI, start, end) { b -> wifi.merge(b.uid, b.rxBytes + b.txBytes, Long::plus) }
        }
        val pm = context.packageManager
        return (mobile.keys + wifi.keys).distinct()
            .map { uid ->
                val (name, pkg) = label(pm, uid)
                AppData(uid, name, pkg, mobile[uid] ?: 0, wifi[uid] ?: 0)
            }
            .filter { it.total > 0 }
            .sortedByDescending { it.total }
    }

    private inline fun eachBucket(nsm: NetworkStatsManager, type: Int, start: Long, end: Long, block: (NetworkStats.Bucket) -> Unit) {
        val stats = nsm.querySummary(type, null, start, end)
        try {
            val bucket = NetworkStats.Bucket()
            while (stats.hasNextBucket()) {
                stats.getNextBucket(bucket)
                block(bucket)
            }
        } finally {
            stats.close()
        }
    }

    private fun label(pm: PackageManager, uid: Int): Pair<String, String?> = when (uid) {
        NetworkStats.Bucket.UID_REMOVED -> "Removed apps" to null
        NetworkStats.Bucket.UID_TETHERING -> "Hotspot and tethering" to null
        Process.SYSTEM_UID -> "Android system" to "android"
        0 -> "System" to null
        else -> {
            val packages = pm.getPackagesForUid(uid).orEmpty()
            val pkg = packages.firstOrNull()
            val name = pkg?.let { runCatching { pm.getApplicationLabel(pm.getApplicationInfo(it, 0)).toString() }.getOrNull() }
            when {
                name != null && packages.size > 1 -> "$name and ${packages.size - 1} more" to pkg
                name != null -> name to pkg
                pkg != null -> pkg to pkg
                else -> "App $uid" to null
            }
        }
    }
}
