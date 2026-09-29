package io.github.sbgitcs.usagemonitor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.github.sbgitcs.usagemonitor.service.SpeedService

/**
 * After a restart or an update, brings back the status bar speed if it was on. Starting the
 * process also runs UsageMonitorApp.onCreate, which schedules the background work again.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            runCatching { SpeedService.sync(context) }
        }
    }
}
