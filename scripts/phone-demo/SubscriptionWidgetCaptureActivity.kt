package io.github.sbgitcs.usagemonitor

import android.app.Activity
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.os.Bundle
import android.widget.FrameLayout
import io.github.sbgitcs.usagemonitor.widget.PlanWidgetReceiver
import io.github.sbgitcs.usagemonitor.widget.Widgets

/** A real Android host for the production Glance widget, in the isolated demo APK. */
class SubscriptionWidgetCaptureActivity : Activity() {
    private lateinit var host: AppWidgetHost
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        host = AppWidgetHost(this, 1600)
        host.deleteHost()
        val id = host.allocateAppWidgetId()
        val manager = AppWidgetManager.getInstance(this)
        val options = Bundle().apply {
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 360)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 360)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 320)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 320)
        }
        check(manager.bindAppWidgetIdIfAllowed(id, ComponentName(this, PlanWidgetReceiver::class.java), options)) {
            "Grant appwidget bind permission to the demo package first"
        }
        val view = host.createView(this, id, manager.getAppWidgetInfo(id))
        val frame = FrameLayout(this).apply { setBackgroundColor(0xff101827.toInt()) }
        val density = resources.displayMetrics.density
        frame.addView(view, FrameLayout.LayoutParams((360 * density).toInt(), (320 * density).toInt()).apply {
            gravity = android.view.Gravity.CENTER
        })
        setContentView(frame)
        host.startListening()
        Widgets.refresh(this)
    }
    override fun onDestroy() { host.stopListening(); super.onDestroy() }
}
