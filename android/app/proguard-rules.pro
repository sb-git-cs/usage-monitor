# These names are persisted in WorkManager's database and Glance's widget registry.
# Preserve existing jobs and launcher placements when upgrading an unminified build.
-keep,allowoptimization class io.github.sbgitcs.usagemonitor.work.RefreshWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}
-keep,allowoptimization class io.github.sbgitcs.usagemonitor.work.UpdateWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}
-keepnames class io.github.sbgitcs.usagemonitor.widget.PlanWidget
-keepnames class io.github.sbgitcs.usagemonitor.widget.DataWidget
-keepnames class io.github.sbgitcs.usagemonitor.widget.DeviceWidget
