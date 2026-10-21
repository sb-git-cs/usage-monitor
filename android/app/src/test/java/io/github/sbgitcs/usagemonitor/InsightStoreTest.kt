package io.github.sbgitcs.usagemonitor

import android.app.Application
import android.content.Context
import io.github.sbgitcs.usagemonitor.data.InsightHistory
import io.github.sbgitcs.usagemonitor.data.Settings
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class InsightStoreTest {
    @Test fun historyMovesOutOfThePreferencesOnceAndKeepsGrowingInItsFile() {
        val app = RuntimeEnvironment.getApplication()
        val prefs = app.getSharedPreferences("settings", Context.MODE_PRIVATE)
        val old = InsightHistory.event(null, "Warning", "Body", "Suppressed")
        prefs.edit().putString("insights", old).putString("theme_mode", "dark").commit()
        val settings = Settings(app)
        assertEquals(old, settings.insightsJson)
        assertFalse(prefs.contains("insights"))
        assertEquals("dark", settings.themeMode)
        assertEquals(old, File(app.filesDir, "insights.json").readText())
        settings.recordEvent("Second", "Body", "Delivery requested")
        assertEquals(2, InsightHistory.read(Settings(app).insightsJson).getJSONArray("events").length())
        assertFalse(prefs.contains("insights"))
        settings.insightsJson = null
        assertNull(Settings(app).insightsJson)
    }
}
