package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.direct.PlanReadings
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.model.PlanWindow
import io.github.sbgitcs.usagemonitor.model.Provider
import org.junit.Assert.*
import org.junit.Test

class PlanReadingsTest {
    private fun provider(id: String, state: String = "ok") =
        Provider(id, id, null, state, null, listOf(PlanWindow("five_hour", "5h", 25.0, null, null, null)),
            account = "$id@example.test")
    private fun desktop() = DesktopSnapshot("1.3.0", "PC", 100_000, 80,
        listOf(provider("claude"), provider("codex"), provider("gemini"), provider("grok"),
            provider("cursor", "disabled"), provider("copilot")), null, null)

    @Test fun onlyCopilotIsExcludedFromMobileFreshAndCachedReadingsWithoutMutatingDesktopData() {
        val original = desktop()
        for (failed in listOf(false, true)) {
            val view = PlanReadings.fromDesktop(original, 100_000, failed, 100_000)
            assertEquals(listOf("claude", "codex", "gemini", "grok", "cursor"), view.snapshot!!.providers.map { it.id })
            assertEquals(6, original.providers.size)
            assertTrue(original.providers.any { it.id == "copilot" })
            assertEquals("ok", original.providers.first().state)
        }
    }

    @Test fun failedOrAgedComputerReadingsKeepCodexUsageAndIdentityButRemainCached() {
        for ((at, failed, now) in listOf(Triple(100_000L, true, 100_000L),
            Triple(100_000L, false, 2_000_001L), Triple(0L, false, 100_000L))) {
            val view = PlanReadings.fromDesktop(desktop(), at, failed, now)
            assertTrue(view.computerCached)
            val codex = view.snapshot!!.providers.single { it.id == "codex" }
            assertEquals("stale", codex.state)
            assertEquals("codex@example.test", codex.account)
            assertEquals(25.0, codex.currentWindow()!!.usedPct!!, 0.0)
            assertEquals("disabled", view.snapshot.providers.single { it.id == "cursor" }.state)
        }
        assertFalse(PlanReadings.fromDesktop(desktop(), 100_000, false, 100_000).computerCached)
    }

    @Test fun missingComputerSnapshotDoesNotInventAReading() {
        val view = PlanReadings.fromDesktop(null, 0, true, 100_000)
        assertNull(view.snapshot)
        assertFalse(view.computerCached)
    }
}
