package io.github.sbgitcs.usagemonitor.work

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

/**
 * Background work: every 15 minutes (Android's shortest period) the meters are fetched from the
 * computer, data caps are checked and the widgets redrawn; every 6 hours GitHub is checked for
 * a new version, like the desktop app.
 */
object Scheduler {
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedule(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.enqueueUniquePeriodicWork(
            "refresh",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES).build(),
        )
        wm.enqueueUniquePeriodicWork(
            "update",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<UpdateWorker>(6, TimeUnit.HOURS)
                .setConstraints(online)
                .setInitialDelay(10, TimeUnit.MINUTES)
                .build(),
        )
    }

    fun refreshNow(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            "refresh-now",
            ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<RefreshWorker>().build(),
        )
    }

    fun checkForUpdate(context: Context, interactive: Boolean) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            "update-now",
            ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<UpdateWorker>()
                .setConstraints(online)
                .setInputData(workDataOf(UpdateWorker.INTERACTIVE to interactive))
                .build(),
        )
    }
}
