package io.github.sbgitcs.usagemonitor

import android.app.Application
import android.util.AtomicFile
import io.github.sbgitcs.usagemonitor.alerts.Notifications
import io.github.sbgitcs.usagemonitor.work.Scheduler

class UsageMonitorApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Copilot phone authorization was removed; retain pairing and all other preferences.
        AtomicFile(noBackupFilesDir.resolve("github-login")).delete()
        getSharedPreferences("settings", MODE_PRIVATE).edit()
            .remove("github_connected").remove("github_usage").remove("github_error").apply()
        Notifications.createChannels(this)
        Scheduler.schedule(this)
    }
}
