package io.github.sbgitcs.usagemonitor

import android.content.Context
import android.content.ContextWrapper
import io.github.sbgitcs.usagemonitor.device.BatteryHistory
import io.github.sbgitcs.usagemonitor.device.BatteryLogic
import io.github.sbgitcs.usagemonitor.device.BatteryReading
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class BatteryStoreTest {
    private fun context(): Context {
        val app = RuntimeEnvironment.getApplication()
        val dir = File(app.cacheDir, "battery-${UUID.randomUUID()}").also { it.mkdirs() }
        return object : ContextWrapper(app) { override fun getFilesDir(): File = dir }
    }
    @Test fun storePersistsDeduplicatesAndRestartsWithAGap() {
        val context = context()
        val now = System.currentTimeMillis() - 120_000
        val history = BatteryHistory(context)
        history.record(BatteryReading(now, 60, "discharging"))
        history.record(BatteryReading(now + 1000, 60, "discharging"))
        assertEquals(1, history.view().size)
        history.record(BatteryReading(now + 60_000, 59, "discharging"))
        history.record(BatteryReading(now + 61_000, 59, "charging"))
        assertEquals(3, history.view().size)
        val restart = BatteryHistory(context)
        val reading = restart.record(BatteryReading(now + 62_000, 59, "charging"))
        assertTrue(reading.gap)
        assertNull(reading.seconds)
        assertTrue(restart.clear())
        assertTrue(File(context.filesDir, "battery-history.json").readText(), BatteryHistory(context).view().isEmpty())
    }
    @Test fun corruptHistoryRecoversAndExpiredHistoryIsPruned() {
        val context = context()
        File(context.filesDir, "battery-history.json").writeText("broken")
        val history = BatteryHistory(context)
        assertTrue(history.error)
        val now = System.currentTimeMillis()
        history.record(BatteryReading(now - 31 * BatteryLogic.DAY, 60, "discharging"))
        assertFalse(history.error)
        assertTrue(history.view(30).isEmpty())
        history.record(BatteryReading(now - 60_000, 60, "discharging"))
        history.record(BatteryReading(now - 30_000, null, "unknown"))
        assertTrue(history.record(BatteryReading(now, 59, "discharging")).gap)
    }
    @Test fun pointsAreAppendedAndFoldedIntoTheFileAfterADay() {
        val context = context()
        val file = File(context.filesDir, "battery-history.json")
        val journal = File(context.filesDir, "battery-history.log")
        val start = System.currentTimeMillis() - 2 * BatteryLogic.DAY
        // A history written by earlier versions is read as it is.
        file.writeText("""{"version":1,"points":[{"t":$start,"percent":80,"state":"discharging","seconds":null,"source":null,"g":true}]}""")
        val history = BatteryHistory(context)
        assertEquals(1, history.view(3).size)
        history.record(BatteryReading(start + 60_000, 79, "discharging"))
        assertFalse("one point does not rewrite the file", file.readText().contains("\"percent\":79"))
        assertEquals(1, journal.readLines().count { it.isNotBlank() })
        journal.appendText("\n{\"t\":") // a write cut short
        // A full journal (a day of points by default; two here) is folded into the file with the next point.
        val reloaded = BatteryHistory(context, compactAfter = 2)
        assertEquals(2, reloaded.view(3).size)
        reloaded.record(BatteryReading(start + 2 * 60_000, 78, "discharging"))
        assertTrue(journal.exists())
        reloaded.record(BatteryReading(start + 3 * 60_000, 77, "discharging"))
        assertFalse(journal.exists())
        assertFalse(reloaded.error)
        assertTrue(file.readText().contains("\"percent\":77"))
        assertEquals(4, BatteryHistory(context).view(3).size)
    }
}
