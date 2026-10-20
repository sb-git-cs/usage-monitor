package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.device.BatteryLogic
import io.github.sbgitcs.usagemonitor.device.BatteryReading
import org.junit.Assert.*
import org.junit.Test

class BatteryTest {
    private val base = 1_800_000_000_000L
    private fun p(minute: Int, percent: Int, state: String = "discharging", gap: Boolean = false) =
        BatteryReading(base + minute * 60_000, percent, state, gap = gap)

    @Test fun estimatesRequireEnoughTimeAndMovement() {
        assertEquals(17400L, BatteryLogic.estimate(p(10, 58), listOf(p(0, 60))).seconds)
        assertEquals(11400L, BatteryLogic.estimate(p(10, 62, "charging"), listOf(p(0, 60, "charging"))).seconds)
        assertNull(BatteryLogic.estimate(p(0, 58).copy(t = base + 15_000), listOf(p(0, 60))).seconds)
        assertNull(BatteryLogic.estimate(p(10, 60), listOf(p(0, 60))).seconds)
        assertNull(BatteryLogic.estimate(p(10, 62), listOf(p(0, 60))).seconds)
    }
    @Test fun preferSystemAndResetAfterGapsOrPowerChanges() {
        assertEquals(120L, BatteryLogic.estimate(p(10, 62, "charging").copy(seconds = 120, source = "system"), listOf(p(0, 60, "charging"))).seconds)
        assertNull(BatteryLogic.estimate(p(10, 58), listOf(p(0, 60, "charging"))).seconds)
        assertNull(BatteryLogic.estimate(p(25, 58), listOf(p(0, 60))).seconds)
        assertNull(BatteryLogic.estimate(p(10, 58, gap = true), listOf(p(0, 60))).seconds)
        assertNull(BatteryLogic.estimate(p(40, 58), listOf(p(0, 60))).seconds)
    }
    @Test fun currentAndChargeCounterGiveAnImmediateEstimate() {
        assertEquals(7200L, BatteryLogic.powerEstimate(60, "discharging", 3_000_000, -1_500_000))
        assertEquals(4800L, BatteryLogic.powerEstimate(60, "charging", 3_000_000, 1_500_000))
        assertNull(BatteryLogic.powerEstimate(60, "charging", 3_000_000, 0))
        assertNull(BatteryLogic.powerEstimate(0, "charging", 3_000_000, 1_500_000))
        assertNull(BatteryLogic.powerEstimate(60, "plugged", 3_000_000, 1_500_000))
    }
    @Test fun descriptionsDistinguishUnknownFullAndChargingPaused() {
        assertEquals("Unavailable", p(0, 60).copy(percent = null).description)
        assertEquals("Full", p(0, 100, "full").description)
        assertEquals("Plugged in · not charging", p(0, 80, "plugged").description)
        assertEquals("Estimating…", p(0, 80).description)
        assertEquals("~2h 0m to full", p(0, 80, "charging").copy(seconds = 7200).description)
    }
    @Test fun sessionsExcludeGapsAndMarkPartialEnds() {
        val sessions = BatteryLogic.sessions(listOf(p(0, 50, "plugged"), p(1, 50, "charging"), p(11, 60, "charging"),
            p(12, 60), p(22, 58), p(60, 40, gap = true)))
        assertEquals(3, sessions.size)
        assertFalse(sessions[2].partial)
        assertEquals(10, sessions[2].last.percent!! - sessions[2].first.percent!!)
        assertEquals(10 * 60_000L, sessions[2].last.t - sessions[2].first.t)
        assertTrue(sessions[0].partial)
        assertTrue(sessions[1].partial)
        assertTrue(BatteryLogic.sessions(emptyList()).isEmpty())
    }
}
