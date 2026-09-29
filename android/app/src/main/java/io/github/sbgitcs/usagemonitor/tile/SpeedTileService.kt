package io.github.sbgitcs.usagemonitor.tile

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.net.Format
import io.github.sbgitcs.usagemonitor.net.SpeedMeter
import io.github.sbgitcs.usagemonitor.service.SpeedService

/** Quick Settings tile: switches the status bar speed on and off, and shows the speed while on. */
class SpeedTileService : TileService() {
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            update()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onStartListening() {
        super.onStartListening()
        handler.post(refresh)
    }

    override fun onStopListening() {
        handler.removeCallbacks(refresh)
        super.onStopListening()
    }

    override fun onClick() {
        super.onClick()
        val settings = Settings(this)
        settings.speedNotification = !settings.speedNotification
        if (runCatching { SpeedService.sync(this) }.isFailure) {
            // Some versions refuse a service start from a tile; the app starts it when it opens.
            val open = packageManager.getLaunchIntentForPackage(packageName)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (open != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    startActivityAndCollapse(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
                } else {
                    @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated") startActivityAndCollapse(open)
                }
            }
        }
        update()
    }

    private fun update() {
        val tile = qsTile ?: return
        val on = Settings(this).speedNotification
        tile.state = if (on) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = "Network speed"
        val speed = SpeedMeter.latest
        tile.subtitle = when {
            !on -> "Off"
            speed == null -> "Starting…"
            else -> "↓ ${Format.rateShort(speed.first)} ↑ ${Format.rateShort(speed.second)}"
        }
        tile.updateTile()
    }
}
