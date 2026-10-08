package io.github.sbgitcs.usagemonitor.service

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import io.github.sbgitcs.usagemonitor.alerts.Notifications
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.net.DataPlan
import io.github.sbgitcs.usagemonitor.net.DataUsage
import io.github.sbgitcs.usagemonitor.net.Format
import io.github.sbgitcs.usagemonitor.net.SpeedMeter
import io.github.sbgitcs.usagemonitor.work.Scheduler
import java.time.ZonedDateTime

/**
 * Live download and upload speed in the status bar. The icon itself shows the combined speed
 * ("1.2" over "MB/s"), updated every second; the notification text adds today's data.
 * Runs only while the user has it switched on.
 */
class SpeedService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val meter = SpeedMeter()
    private var ticks = 0
    @Volatile private var todayText = ""

    private val tick = object : Runnable {
        override fun run() {
            val (rx, tx) = meter.sample()
            SpeedMeter.latest = rx to tx
            if (ticks % 60 == 0) {
                // NetworkStatsManager queries are binder calls; keep them off the main thread.
                Thread { todayText = runCatching { today() }.getOrDefault("") }.start()
                // Fetch fresh desktop readings as well as redrawing phone/data widgets.
                Scheduler.refreshNow(this@SpeedService)
            }
            ticks++
            getSystemService(NotificationManager::class.java)?.notify(ID, build(rx, tx))
            handler.postDelayed(this, 1000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(ID, build(0.0, 0.0), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(ID, build(0.0, 0.0))
        }
        handler.removeCallbacks(tick)
        handler.post(tick)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        SpeedMeter.latest = null
        super.onDestroy()
    }

    private fun today(): String {
        if (!DataUsage.hasAccess(this)) return ""
        val now = ZonedDateTime.now()
        val t = DataUsage.totals(this, DataPlan.dayStart(now).toInstant().toEpochMilli(), System.currentTimeMillis())
        return "Today: mobile ${Format.bytes(t.mobile)} · Wi-Fi ${Format.bytes(t.wifi)}"
    }

    private fun build(rx: Double, tx: Double): Notification {
        val title = "↓ ${Format.rateShort(rx)}   ↑ ${Format.rateShort(tx)}"
        return Notification.Builder(this, Notifications.SPEED)
            .setSmallIcon(icon(rx + tx))
            .setContentTitle(title)
            .setContentText(todayText.ifEmpty { "Network speed" })
            .setContentIntent(Notifications.openApp(this))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_STATUS)
            .build()
    }

    private fun icon(total: Double): Icon {
        val (value, unit) = Format.rateIcon(total)
        val size = 96
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textAlign = Paint.Align.CENTER
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        paint.textSize = if (value.length <= 3) 56f else 46f
        canvas.drawText(value, size / 2f, 56f, paint)
        paint.textSize = 34f
        paint.typeface = Typeface.DEFAULT
        canvas.drawText(unit, size / 2f, 92f, paint)
        return Icon.createWithBitmap(bmp)
    }

    companion object {
        private const val ID = 1001

        fun start(context: Context) {
            context.startForegroundService(Intent(context, SpeedService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SpeedService::class.java))
        }

        /** Starts or stops the service to match the setting. */
        fun sync(context: Context) {
            if (Settings(context).speedNotification) start(context) else stop(context)
        }
    }
}
