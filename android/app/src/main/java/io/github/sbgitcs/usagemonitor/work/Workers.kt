package io.github.sbgitcs.usagemonitor.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import io.github.sbgitcs.usagemonitor.alerts.Alerts
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.net.DataUsage
import io.github.sbgitcs.usagemonitor.pairing.DesktopClient
import io.github.sbgitcs.usagemonitor.update.Updater
import io.github.sbgitcs.usagemonitor.widget.Widgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val settings = Settings(applicationContext)
        var snapshot: DesktopSnapshot? = null
        if (settings.computer != null) {
            // Away from the computer's network this fails; the widgets keep the last reading.
            runCatching { DesktopClient(settings).refresh() }.onSuccess { json ->
                snapshot = runCatching { DesktopSnapshot.parse(json) }.getOrNull()
            }
        }
        val data = runCatching { DataUsage.status(applicationContext, settings.billingDay) }.getOrNull()
        Alerts.check(applicationContext, settings, snapshot, data)
        runCatching { Widgets.updateAll(applicationContext) }
        Result.success()
    }
}

class UpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val settings = Settings(applicationContext)
        val interactive = inputData.getBoolean(INTERACTIVE, false)
        if (interactive || settings.autoUpdate) Updater.check(applicationContext, settings, interactive)
        Result.success()
    }

    companion object {
        const val INTERACTIVE = "interactive"
    }
}
