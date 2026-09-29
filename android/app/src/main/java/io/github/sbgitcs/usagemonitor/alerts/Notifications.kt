package io.github.sbgitcs.usagemonitor.alerts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import io.github.sbgitcs.usagemonitor.R

object Notifications {
    const val ALERTS = "alerts"
    const val UPDATES = "updates"
    const val SPEED = "speed"

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(ALERTS, "Usage alerts", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Plan windows and data caps running out"
                },
                NotificationChannel(UPDATES, "Updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "New versions of Usage Monitor"
                },
                NotificationChannel(SPEED, "Network speed", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Live download and upload speed in the status bar"
                    setShowBadge(false)
                },
            )
        )
    }

    fun openApp(context: Context): PendingIntent {
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: Intent().setPackage(context.packageName)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun show(context: Context, channel: String, id: Int, title: String, text: String, tap: PendingIntent? = null) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (!nm.areNotificationsEnabled()) return
        val n = Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_speed)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(tap ?: openApp(context))
            .setAutoCancel(true)
            .build()
        nm.notify(id, n)
    }
}
