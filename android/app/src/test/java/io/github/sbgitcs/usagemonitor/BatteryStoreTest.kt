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
}
