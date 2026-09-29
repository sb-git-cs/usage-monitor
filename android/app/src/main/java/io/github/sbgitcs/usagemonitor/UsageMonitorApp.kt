package io.github.sbgitcs.usagemonitor

import android.app.Application
import io.github.sbgitcs.usagemonitor.alerts.Notifications
import io.github.sbgitcs.usagemonitor.work.Scheduler

class UsageMonitorApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
        Scheduler.schedule(this)
    }
}
