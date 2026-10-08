package io.github.sbgitcs.usagemonitor

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.mutableStateOf
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.pairing.PairingInfo
import io.github.sbgitcs.usagemonitor.pairing.PairingLink
import io.github.sbgitcs.usagemonitor.service.SpeedService
import io.github.sbgitcs.usagemonitor.ui.App
import io.github.sbgitcs.usagemonitor.ui.Tab
import io.github.sbgitcs.usagemonitor.ui.UsageMonitorTheme
import io.github.sbgitcs.usagemonitor.widget.Widgets
import io.github.sbgitcs.usagemonitor.work.Scheduler

class MainActivity : ComponentActivity() {
    private lateinit var settings: Settings

    /** A pairing link opened from the camera app, waiting for the user to confirm it. */
    private val incoming = mutableStateOf<PairingInfo?>(null)
    private val requestedTab = mutableStateOf<Tab?>(null)
    private var incomingLink: String? = null

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) runCatching { SpeedService.sync(this) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        settings = Settings(this)
        if (savedInstanceState == null) {
            handle(intent)
        } else {
            savedInstanceState.getString(PAIR_LINK)?.let { link -> accept(link) }
        }
        setContent {
            UsageMonitorTheme {
                App(settings, incoming.value, onIncomingHandled = { accept(null) },
                    requestedTab = requestedTab.value, onNavigationHandled = { requestedTab.value = null })
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !settings.askedNotifications &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            settings.askedNotifications = true
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        incomingLink?.let { outState.putString(PAIR_LINK, it) }
    }

    override fun onResume() {
        super.onResume()
        AppState.foreground = true
        runCatching { SpeedService.sync(this) }
        Widgets.refresh(this)
        // Like the desktop app, look for a new version whenever the app is opened (at most every 30 minutes).
        if (settings.autoUpdate && System.currentTimeMillis() - settings.lastUpdateCheck > 30 * 60_000L) {
            Scheduler.checkForUpdate(this, interactive = false)
        }
    }

    override fun onPause() {
        AppState.foreground = false
        super.onPause()
    }

    private fun handle(intent: Intent?) {
        requestedTab.value = Tab.entries.firstOrNull { it.name == intent?.getStringExtra(WIDGET_TAB) }
        val data = intent?.data ?: return
        if (data.scheme != "usagemonitor") return
        if (PairingLink.parse(data.toString()) == null) {
            Toast.makeText(this, "That pairing link is not complete. Scan the QR code again.", Toast.LENGTH_LONG).show()
            return
        }
        accept(data.toString())
    }

    private fun accept(link: String?) {
        incomingLink = link
        incoming.value = link?.let { PairingLink.parse(it) }
    }

    companion object {
        const val WIDGET_TAB = "widget_tab"
        private const val PAIR_LINK = "pair_link"
    }
}
