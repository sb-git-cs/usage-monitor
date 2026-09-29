package io.github.sbgitcs.usagemonitor.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import io.github.sbgitcs.usagemonitor.AppState
import io.github.sbgitcs.usagemonitor.alerts.Notifications

/** Hears back from the system installer. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                } ?: return
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (AppState.foreground) {
                    context.startActivity(confirm)
                } else {
                    val tap = PendingIntent.getActivity(context, 2, confirm, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                    Notifications.show(context, Notifications.UPDATES, 2002, "Usage Monitor update ready", "Tap to install it. Later updates install on their own.", tap)
                }
            }
            PackageInstaller.STATUS_SUCCESS -> Unit // The new version replaces this process.
            else -> {
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown error"
                Notifications.show(context, Notifications.UPDATES, 2003, "Usage Monitor update failed", message)
            }
        }
    }

    companion object {
        const val ACTION = "io.github.sbgitcs.usagemonitor.INSTALL_STATUS"
    }
}
