package io.github.sbgitcs.usagemonitor.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import io.github.sbgitcs.usagemonitor.work.Scheduler

/** Fetch new readings when the launcher adds or periodically updates any widget. */
abstract class RefreshingWidgetReceiver : GlanceAppWidgetReceiver() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        super.onUpdate(context, manager, ids)
        Scheduler.refreshNow(context)
    }
}

/** Starting sizes in the picker; every preset can grow or shrink in either direction. */
class PlanWidget4x1Receiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PlanWidget()
}

class PlanWidget2x1Receiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PlanWidget()
}

class PlanWidget1x1Receiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PlanWidget()
}

class DataWidget4x1Receiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DataWidget()
}

class DataWidget2x1Receiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DataWidget()
}

class DataWidget1x1Receiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DataWidget()
}

class DeviceWidget4x1Receiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DeviceWidget()
}

class DeviceWidget2x1Receiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DeviceWidget()
}

class DeviceWidget1x1Receiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DeviceWidget()
}
