package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.data.InsightHistory
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.model.PlanWindow
import io.github.sbgitcs.usagemonitor.model.Provider
import org.junit.Assert.*
import org.junit.Test

class InsightHistoryTest {
    private val now = 1_800_000_000_000L
    private fun snapshot(account: String, used: Double, state: String = "ok", reset: Long = now + 3600000) =
        DesktopSnapshot("", "", now, 80, listOf(Provider("codex", "Codex", null, state, null,
            listOf(PlanWindow("five_hour", "5h", used, reset, null, null)), account = account, fetchedAt = now)), null, null)

    @Test fun accountsAndResetsStaySeparate() {
        var raw = InsightHistory.record(null, snapshot("first@example.com", 40.0), now)
        raw = InsightHistory.record(raw, snapshot("second@example.com", 60.0), now + 300000)
        raw = InsightHistory.record(raw, snapshot("first@example.com", 5.0, reset = now + 7200000), now + 600000)
        val series = InsightHistory.read(raw).getJSONObject("series")
        assertEquals(2, series.length())
        val first = series.keys().asSequence().map { series.getJSONObject(it) }.first { it.getJSONArray("points").length() == 2 }.getJSONArray("points")
        assertNotEquals(first.getJSONObject(0).getString("segment"), first.getJSONObject(1).getString("segment"))
        assertFalse(raw.contains("@example.com"))
    }
    @Test fun cachedReadingsAndDuplicatePollsAreExcluded() {
        var raw = InsightHistory.record(null, snapshot("a", 40.0), now)
        raw = InsightHistory.record(raw, snapshot("a", 45.0), now + 1000)
        raw = InsightHistory.record(raw, snapshot("a", 90.0, "stale"), now + 600000)
        val series = InsightHistory.read(raw).getJSONObject("series")
        assertEquals(1, series.getJSONObject(series.keys().next()).getJSONArray("points").length())
    }
    @Test fun eventsAreBoundedAndCorruptStateRecovers() {
        var raw = "invalid"
        repeat(220) { raw = InsightHistory.event(raw, "Warning", "Body", "Suppressed", now + it) }
        assertEquals(200, InsightHistory.read(raw).getJSONArray("events").length())
        assertEquals("unidentified", InsightHistory.accountRef(null))
    }
}
