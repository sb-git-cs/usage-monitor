package io.github.sbgitcs.usagemonitor

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import org.junit.Assert.assertEquals
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.device.DeviceReadings
import io.github.sbgitcs.usagemonitor.model.DesktopNetwork
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.model.PlanWindow
import io.github.sbgitcs.usagemonitor.model.Provider
import io.github.sbgitcs.usagemonitor.model.SystemReadings
import io.github.sbgitcs.usagemonitor.net.AppData
import io.github.sbgitcs.usagemonitor.net.DataStatus
import io.github.sbgitcs.usagemonitor.net.DataTotals
import io.github.sbgitcs.usagemonitor.ui.AppScaffold
import io.github.sbgitcs.usagemonitor.ui.DataContent
import io.github.sbgitcs.usagemonitor.ui.DeviceContent
import io.github.sbgitcs.usagemonitor.ui.PlansContent
import io.github.sbgitcs.usagemonitor.ui.SettingsScreen
import io.github.sbgitcs.usagemonitor.direct.consolidateSubscription
import io.github.sbgitcs.usagemonitor.ui.Tab
import io.github.sbgitcs.usagemonitor.ui.UsageMonitorTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

private const val MIN = 60_000L
private const val HOUR = 60 * MIN
private const val DAY = 24 * HOUR
private const val MB = 1024L * 1024
private const val GB = 1024 * MB

/**
 * Renders the real Home, Data and Phone screens with demo data (no real sign-ins, usage or names)
 * into docs/screenshots/android. Run with:
 *   ./gradlew testDebugUnitTest --tests '*ScreenshotsTest*' -PscreenshotsDir=../docs/screenshots/android
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
// A plain Application: the app's own schedules WorkManager jobs, which are not needed here.
@Config(sdk = [35], qualifiers = "w393dp-h852dp-xhdpi", application = Application::class)
open class ScreenshotsTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    protected open val suffix = ""
    private val now = System.currentTimeMillis()

    @Test fun home() = homeScene("legacy", "home")
    @Test fun homeCombined() = homeScene("combined", "home-combined")

    private fun homeScene(regime: String, name: String) = shoot(name) {
        val raw = listOf(
            Provider("claude", "Claude Code", "Max", "ok", null, listOf(
                PlanWindow("five_hour", "5h", 42.0, now + 2 * HOUR + 10 * MIN, null, 14.0),
                PlanWindow("weekly", "Weekly", 61.0, now + 3 * DAY, null, null),
            )),
            Provider("codex", "Codex", "Plus", "ok", null, listOf(
                PlanWindow("five_hour", "5h", 18.0, now + 3 * HOUR + 40 * MIN, null, 5.0),
                PlanWindow("weekly", "Weekly", 33.0, now + 5 * DAY, null, null),
            )),
            Provider("gemini", "Gemini", "Pro", "ok", null, listOf(
                PlanWindow("daily", "Daily", 86.0, now + 7 * HOUR, now + 55 * MIN, 15.0),
            )),
            Provider("grok", "Grok Build", "SuperGrok", "ok", null, listOf(
                PlanWindow("weekly", "Weekly", 35.0, now + 3 * DAY, null, null),
                PlanWindow("credits", "Credits $12.50", null, null, null, null),
            ), sharedWeekly = PlanWindow("weekly", "Weekly", 35.0, now + 3 * DAY, null, null)),
            Provider("cursor", "Cursor", "Pro", "ok", null, listOf(
                PlanWindow("monthly", "Monthly", 54.0, now + 12 * DAY, null, null),
            ), source = "phone", fetchedAt = now - 2 * MIN),
        )
        val providers = consolidateSubscription(raw, regime, now)
        val snapshot = DesktopSnapshot("1.6.0", "Studio PC", now, 80, providers,
            SystemReadings(cpu = 23.0, mem = 58.0, gpu = 12.0, disk = 4.0, diskRate = null, space = 71.0),
            DesktopNetwork("running", 2.4 * MB, 310.0 * 1024))
        AppScaffold(Tab.Plans, onTab = {}) {
            PlansContent("Studio PC · 1 min ago · 1 direct", busy = false, providers, warnAt = 80.0, now = now,
                snapshot = snapshot, cached = false, error = null, unpaired = false,
                onRefresh = {}, onPair = {}, onSelect = {})
        }
    }

    @Test fun settingsLegacy() = settingsScene("legacy")
    @Test fun settingsCombined() = settingsScene("combined")
    private fun settingsScene(regime: String) {
        val settings = Settings(compose.activity).apply { subscriptionRegime = regime; autoUpdate = false }
        shoot("settings-$regime") {
            AppScaffold(Tab.Settings, onTab = {}) { SettingsScreen(settings, null, 0, onPair = {}, onForget = {}) }
        }
    }

    @Test fun data() {
        val settings = Settings(compose.activity).apply {
            billingDay = 1
            monthlyCapMb = 15 * 1024
            dailyCapMb = 1024
        }
        val cycleStart = now - 12 * DAY
        val status = DataStatus(
            todayTotals = DataTotals(380 * MB, 32 * MB, 1700 * MB, 140 * MB, 0),
            cycleTotals = DataTotals(5800 * MB, 420 * MB, 36 * GB, 2 * GB, 0),
            cycleStart = cycleStart, cycleEnd = cycleStart + 30 * DAY, day = "",
        )
        val apps = listOf(
            AppData(10101, "YouTube", null, 160 * MB, 950 * MB),
            AppData(10102, "Chrome", null, 92 * MB, 410 * MB),
            AppData(10103, "Maps", null, 64 * MB, 12 * MB),
            AppData(10104, "Spotify", null, 41 * MB, 180 * MB),
            AppData(10105, "Photos", null, 3 * MB, 220 * MB),
            AppData(10106, "Gmail", null, 12 * MB, 26 * MB),
        )
        shoot("data") {
            AppScaffold(Tab.Data, onTab = {}) {
                DataContent(settings, access = true, speed = 2.4 * MB to 310.0 * 1024, status = status, apps = apps,
                    period = 0, onPeriod = {}, onOpenAccess = {})
            }
        }
    }

    @Test fun phone() = shoot("phone") {
        val readings = DeviceReadings(
            memUsed = 5300 * MB, memTotal = 8 * GB, storageUsed = 88 * GB, storageTotal = 128 * GB,
            batteryEstimate = "~3h 10m left",
            batteryPct = 76, batteryTempC = 31.4, charging = false, currentMa = -412, thermal = "Normal",
            cpuClockPct = 38.0, coreMhz = listOf(1094, 1094, 1197, 1401, 1804, 2016, 2304, 787),
        )
        AppScaffold(Tab.Phone, onTab = {}) { DeviceContent(readings) }
    }

    @Test fun batteryHistory() = batteryScene(false)
    @Test fun batteryLargeText() = batteryScene(true)
    private fun batteryScene(large: Boolean) {
        val history = io.github.sbgitcs.usagemonitor.device.BatteryHistory.get(compose.activity)
        history.clear()
        val stamp = System.currentTimeMillis() - 60 * MIN
        for (i in 0..60) {
            val charging = i >= 30
            history.record(io.github.sbgitcs.usagemonitor.device.BatteryReading(stamp + i * MIN,
                if (charging) 40 + (i - 30) else 60 - i / 2,
                if (charging) "charging" else "discharging", gap = i == 0))
        }
        shoot(if (large) "battery-large-text" else "battery") {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, if (large) 1.5f else density.fontScale)) {
                AppScaffold(Tab.Phone, onTab = {}) {
                    io.github.sbgitcs.usagemonitor.ui.ScreenList {
                        item { io.github.sbgitcs.usagemonitor.ui.BatteryHistorySection() }
                    }
                }
            }
        }
    }

    private fun shoot(name: String, content: @Composable () -> Unit) {
        compose.setContent { UsageMonitorTheme(content = content) }
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        assertEquals("system bar contrast follows the rendered theme", suffix != "-dark",
            WindowCompat.getInsetsController(compose.activity.window, view).isAppearanceLightStatusBars)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val dir = File(System.getProperty("screenshotsDir") ?: error("Set -PscreenshotsDir")).apply { mkdirs() }
        File(dir, "$name$suffix.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}

/** The same screens in dark mode. */
@Config(sdk = [35], qualifiers = "w393dp-h852dp-night-xhdpi", application = Application::class)
class ScreenshotsTestDark : ScreenshotsTest() {
    override val suffix = "-dark"
}
